import type { LoaderFunctionArgs } from "react-router";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shop = new URL(request.url).searchParams.get("shop");

  const { admin } = await authenticate.public.appProxy(request);

  if (!admin) {
    console.warn(
      `[dealer-locator] No offline session stored for ${shop}. Open the app in Shopify admin to create one.`,
    );
    return json({ dealers: [], error: "No app proxy session was found." }, 401);
  }

  try {
    return await loadDealers(admin);
  } catch (error) {
    if (isUnauthorized(error)) {
      console.error(
        `[dealer-locator] Shopify rejected the stored access token for ${shop}. Open the app in Shopify admin to issue a new one.`,
      );
      return json({ dealers: [], error: "The app's access token was rejected." }, 401);
    }
    console.error(`[dealer-locator] Unable to load dealers for ${shop}`, error);
    return json({ dealers: [], error: "Company locations could not be loaded." }, 500);
  }
};

async function loadDealers(admin: AdminApiContext) {
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
      console.error("Unable to load company locations for app proxy", payload.errors);
      return json({ dealers: [], error: "Company locations could not be loaded." }, 500);
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

  return json({ dealers, error: "" });
}

function isUnauthorized(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    (error as { response?: { code?: number } }).response?.code === 401
  );
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

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
