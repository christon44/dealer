import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";

// The storefront dealer locator serves a saved copy of the dealers so a page
// view doesn't wait on Shopify or on geocoding. A copy older than this is still
// served, and refreshed from Shopify in the background.
export const DEALER_CACHE_TTL_MS = 10 * 60 * 1000;

// Addresses no geocoder could find are retried after this long.
const GEOCODE_RETRY_NOT_FOUND_MS = 24 * 60 * 60 * 1000;
// Space out geocoder requests: Nominatim allows one per second.
const GEOCODE_SPACING_MS = 1100;
// The same public key the storefront section uses for address search.
const GEOAPIFY_API_KEY = "a335b186e0ae4db1821dae89eb83f53f";

const FALLBACK_DEFAULT_RADIUS_KM = 50;
const DEFAULT_RADIUS_NAMESPACE = "custom";
const DEFAULT_RADIUS_KEY = "dealer_locator_default_radius";

type Address = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
};

type CompanyLocationNode = {
  id: string;
  name: string;
  phone: string | null;
  company: {
    id: string;
    name: string;
    externalId: string | null;
    locations: {
      nodes: Array<{
        roleAssignments: { nodes: Array<{ id: string }> };
      }>;
    };
  };
  metafield: { value: string } | null;
  showOnMap: { value: string } | null;
  shippingAddress: Address | null;
  billingAddress: Address | null;
};

type DealerQueryResponse = {
  data?: {
    companyLocations?: {
      pageInfo?: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
      nodes?: CompanyLocationNode[];
    };
  };
  errors?: unknown;
};

type ShopDefaultRadiusResponse = {
  data?: {
    shop?: {
      defaultRadius?: { value: string } | null;
    };
  };
  errors?: unknown;
};

type Coordinates = { lat: number; lng: number };

// lat/lng are missing while the address hasn't been geocoded yet; the
// storefront geocodes those itself until the background geocoding catches up.
export type Dealer = NonNullable<ReturnType<typeof normalizeDealer>> &
  Partial<Coordinates>;

export async function getCachedDealers(shop: string) {
  const row = await prisma.dealerCache.findUnique({ where: { shop } });
  if (!row) return null;

  return {
    dealers: JSON.parse(row.dealers) as Dealer[],
    updatedAt: row.updatedAt,
    isStale: Date.now() - row.updatedAt.getTime() > DEALER_CACHE_TTL_MS,
  };
}

const refreshes = new Map<string, Promise<Dealer[]>>();

// Reads the dealers from Shopify and saves them with the coordinates already
// known, then geocodes new addresses in the background. Concurrent calls for a
// shop share one refresh.
export function refreshDealerCache(shop: string, admin: AdminApiContext) {
  const inFlight = refreshes.get(shop);
  if (inFlight) return inFlight;

  const refresh = (async () => {
    const dealers = await fetchDealers(admin);
    const geocodes = await loadGeocodes(dealers);
    const cached = applyCoordinates(dealers, geocodes);
    const data = { dealers: JSON.stringify(cached), updatedAt: new Date() };

    await prisma.dealerCache.upsert({
      where: { shop },
      create: { shop, ...data },
      update: data,
    });

    geocodeNewAddresses(shop, dealers, geocodes).catch((error) =>
      console.error(`[dealer-locator] Geocoding dealers for ${shop} failed`, error),
    );
    return cached;
  })().finally(() => refreshes.delete(shop));

  refreshes.set(shop, refresh);
  return refresh;
}

export function logRefreshError(shop: string, error: unknown) {
  if (isUnauthorized(error)) {
    console.error(
      `[dealer-locator] Shopify rejected the stored access token for ${shop}. Open the app in Shopify admin to issue a new one.`,
    );
  } else {
    console.error(`[dealer-locator] Unable to load dealers for ${shop}`, error);
  }
}

export function isUnauthorized(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    (error as { response?: { code?: number } }).response?.code === 401
  );
}

async function fetchDealers(admin: AdminApiContext) {
  const defaultRadiusResponse = await admin.graphql(
    `#graphql
      query DealerLocatorDefaultRadius {
        shop {
          defaultRadius: metafield(namespace: "${DEFAULT_RADIUS_NAMESPACE}", key: "${DEFAULT_RADIUS_KEY}") {
            value
          }
        }
      }`,
  );
  const defaultRadiusPayload =
    (await defaultRadiusResponse.json()) as ShopDefaultRadiusResponse;
  const defaultRadiusValue = defaultRadiusPayload.data?.shop?.defaultRadius?.value;
  const defaultRadiusKm =
    defaultRadiusValue === null ||
    defaultRadiusValue === undefined ||
    defaultRadiusValue === "" ||
    !Number.isFinite(Number(defaultRadiusValue))
      ? FALLBACK_DEFAULT_RADIUS_KM
      : Number(defaultRadiusValue);

  const nodes: CompanyLocationNode[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(
      `#graphql
        query DealerCompanies($cursor: String) {
          companyLocations(first: 250, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              name
              phone
              metafield(namespace: "custom", key: "radius") {
                value
              }
              showOnMap: metafield(namespace: "custom", key: "show_on_map") {
                value
              }
              company {
                id
                name
                externalId
                locations(first: 50) {
                  nodes {
                    roleAssignments(first: 1) {
                      nodes { id }
                    }
                  }
                }
              }
              shippingAddress {
                address1
                address2
                city
                province
                zip
                country
              }
              billingAddress {
                address1
                address2
                city
                province
                zip
                country
              }
            }
          }
        }`,
      { variables: { cursor } },
    );
    const payload = (await response.json()) as DealerQueryResponse;

    if (payload.errors) {
      throw new Error(
        `Unable to load company locations: ${JSON.stringify(payload.errors)}`,
      );
    }

    const page = payload.data?.companyLocations;
    nodes.push(...(page?.nodes || []));
    hasNextPage = Boolean(page?.pageInfo?.hasNextPage);
    cursor = page?.pageInfo?.endCursor || null;
  }

  const dealers: NonNullable<ReturnType<typeof normalizeDealer>>[] = [];
  for (const node of nodes) {
    if (node.showOnMap?.value === "false") continue;
    const dealer = normalizeDealer(node, defaultRadiusKm);
    if (dealer && dealer.status === "Approved") {
      dealers.push(dealer);
    }
  }

  return dealers;
}

function normalizeDealer(node: CompanyLocationNode, defaultRadiusKm: number) {
  const address = node.shippingAddress || node.billingAddress;
  const addressParts = [
    address?.address1,
    address?.address2,
    address?.city,
    address?.province,
    address?.zip,
    address?.country,
  ]
    .filter(Boolean)
    .join(", ");
  const radiusValue = node.metafield?.value;
  const radius =
    radiusValue === null || radiusValue === undefined || radiusValue === ""
      ? defaultRadiusKm
      : Number(radiusValue);
  const isApprovedForOrdering = node.company.locations.nodes.some(
    (location) => location.roleAssignments.nodes.length > 0,
  );
  const status = isApprovedForOrdering ? "Approved" : "Not approved";

  if (!addressParts) {
    return null;
  }

  return {
    id: node.id,
    companyId: node.company.id,
    name: node.company.name,
    externalId: node.company.externalId || "",
    locationName: node.name,
    address: addressParts,
    phone: node.phone || "",
    status,
    radius: Number.isFinite(radius) ? radius : defaultRadiusKm,
  };
}

type Geocodes = Map<string, { lat: number | null; lng: number | null; updatedAt: Date }>;

async function loadGeocodes(dealers: Dealer[]): Promise<Geocodes> {
  const rows = await prisma.geocodedAddress.findMany({
    where: { address: { in: [...new Set(dealers.map((dealer) => dealer.address))] } },
  });
  return new Map(rows.map((row) => [row.address, row]));
}

function applyCoordinates(dealers: Dealer[], geocodes: Geocodes) {
  return dealers.flatMap((dealer) => {
    const saved = geocodes.get(dealer.address);
    if (!saved) return [dealer];
    // No geocoder found this address; the storefront leaves these off the map too.
    if (saved.lat === null || saved.lng === null) return [];
    return [{ ...dealer, lat: saved.lat, lng: saved.lng }];
  });
}

// Write coordinates into the saved dealers every few addresses, so the
// storefront stops geocoding them itself as soon as possible.
const GEOCODE_SAVE_EVERY = 10;
const geocodingShops = new Set<string>();

async function geocodeNewAddresses(shop: string, dealers: Dealer[], geocodes: Geocodes) {
  const addresses = [...new Set(dealers.map((dealer) => dealer.address))].filter(
    (address) => {
      const saved = geocodes.get(address);
      return (
        !saved ||
        (saved.lat === null &&
          Date.now() - saved.updatedAt.getTime() > GEOCODE_RETRY_NOT_FOUND_MS)
      );
    },
  );
  if (!addresses.length || geocodingShops.has(shop)) return;

  geocodingShops.add(shop);
  try {
    let unsaved = 0;
    for (const [index, address] of addresses.entries()) {
      if (index > 0) await sleep(GEOCODE_SPACING_MS);

      let coordinates: Coordinates | null;
      try {
        coordinates = await geocode(address);
      } catch (error) {
        console.warn(`[dealer-locator] Could not geocode "${address}"; retrying on the next refresh.`, error);
        continue;
      }

      const data = { lat: coordinates?.lat ?? null, lng: coordinates?.lng ?? null };
      await prisma.geocodedAddress.upsert({
        where: { address },
        create: { address, ...data },
        update: data,
      });

      unsaved += 1;
      if (unsaved >= GEOCODE_SAVE_EVERY) {
        await applySavedCoordinates(shop);
        unsaved = 0;
      }
    }

    if (unsaved) await applySavedCoordinates(shop);
  } finally {
    geocodingShops.delete(shop);
  }
}

// Adds the coordinates geocoded so far to the dealers currently saved for the
// shop. Skipped if a refresh replaces them meanwhile, since it applies them too.
async function applySavedCoordinates(shop: string) {
  const row = await prisma.dealerCache.findUnique({ where: { shop } });
  if (!row) return;

  const dealers = JSON.parse(row.dealers) as Dealer[];
  const updated = applyCoordinates(dealers, await loadGeocodes(dealers));
  await prisma.dealerCache.updateMany({
    where: { shop, updatedAt: row.updatedAt },
    data: { dealers: JSON.stringify(updated) },
  });
}

// Mirrors the storefront section's lookup: Geoapify first, then Nominatim,
// limited to Canada. Resolves to null when neither finds the address, and
// throws when a geocoder couldn't be reached, so an outage isn't saved as
// "not found".
async function geocode(address: string): Promise<Coordinates | null> {
  const query = /\bcanada\b/i.test(address) ? address : `${address}, Canada`;

  const geoapify = await geoapifyGeocode(query).catch(() => undefined);
  if (geoapify) return geoapify;

  const nominatim = await nominatimGeocode(query).catch(() => undefined);
  if (nominatim) return nominatim;

  if (geoapify === undefined || nominatim === undefined) {
    throw new Error("A geocoding service could not be reached.");
  }
  return null;
}

async function geoapifyGeocode(query: string) {
  const url =
    "https://api.geoapify.com/v1/geocode/search?" +
    new URLSearchParams({
      text: query,
      apiKey: GEOAPIFY_API_KEY,
      limit: "1",
      lang: "en",
      format: "json",
      filter: "countrycode:ca",
    }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Geoapify responded ${response.status}`);

  const data = (await response.json()) as {
    results?: Array<{ lat: number; lon: number; formatted?: string }>;
  };
  const result = data.results?.[0];
  if (!result || !/\bcanada\b/i.test(result.formatted || "")) return null;

  return toCoordinates(result.lat, result.lon);
}

async function nominatimGeocode(query: string) {
  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({
      q: query,
      format: "jsonv2",
      limit: "1",
      countrycodes: "ca",
    }).toString();
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      // Nominatim's usage policy requires an identifying User-Agent.
      "User-Agent": `TMG Dealer Locator (${process.env.SHOPIFY_APP_URL || "dealers.apps.tmgindustrial.com"})`,
    },
  });
  if (!response.ok) throw new Error(`Nominatim responded ${response.status}`);

  const data = (await response.json()) as Array<{ lat: string; lon: string }>;
  const result = data[0];
  if (!result) return null;

  return toCoordinates(Number(result.lat), Number(result.lon));
}

function toCoordinates(lat: number, lng: number) {
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
