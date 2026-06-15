import { useEffect, useMemo, useRef, useState } from "react";
import type {
  HeadersFunction,
  LinksFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import styles from "../styles/dealer-map.module.css";

const COVERAGE_RADIUS_KM = 150;
const LEAFLET_SCRIPT_ID = "dealer-map-leaflet";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

type Address = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
};

type Dealer = {
  id: string;
  name: string;
  locationName: string;
  address: string;
  phone: string;
  addressQuery: string;
};

type DealerPoint = Dealer & {
  lat: number;
  lng: number;
};

type CompanyLocationNode = {
  id: string;
  name: string;
  phone: string | null;
  roleAssignments: {
    nodes: Array<{ id: string }>;
  };
  company: { name: string };
  shippingAddress: Address | null;
  billingAddress: Address | null;
};

type GeocodeResult = {
  display_name: string;
  lat: string;
  lon: string;
};

type SearchPoint = {
  label: string;
  lat: number;
  lng: number;
};

type LeafletMap = {
  fitBounds: (bounds: unknown, options?: unknown) => void;
  remove: () => void;
  setView: (position: [number, number], zoom: number) => void;
};

type LeafletLayer = {
  addTo: (map: LeafletMap) => LeafletLayer;
  bindPopup: (content: string) => LeafletLayer;
  openPopup: () => LeafletLayer;
  remove: () => void;
};

type LeafletCircle = LeafletLayer & {
  getBounds: () => unknown;
};

type LeafletApi = {
  circle: (
    position: [number, number],
    options: Record<string, unknown>,
  ) => LeafletCircle;
  divIcon: (options: Record<string, unknown>) => unknown;
  latLngBounds: (positions: Array<[number, number]>) => unknown;
  map: (element: HTMLElement) => LeafletMap;
  marker: (
    position: [number, number],
    options?: Record<string, unknown>,
  ) => LeafletLayer;
  tileLayer: (url: string, options: Record<string, unknown>) => LeafletLayer;
};

type DealerQueryResponse = {
  data?: {
    companyLocations?: {
      nodes?: CompanyLocationNode[];
    };
  };
  errors?: unknown;
};

type LoaderData = {
  dealers: Dealer[];
  error: string;
};

declare global {
  interface Window {
    L?: LeafletApi;
  }
}

export const links: LinksFunction = () => [
  {
    rel: "stylesheet",
    href: "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(
    `#graphql
      query DealerCompanies {
        companyLocations(first: 250) {
          nodes {
            id
            name
            phone
            roleAssignments(first: 1) {
              nodes { id }
            }
            company { name }
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
  );
  const json = (await response.json()) as DealerQueryResponse;

  if (json.errors) {
    console.error("Unable to load company locations", json.errors);
    return {
      dealers: [],
      error:
        "Company locations could not be loaded. Confirm this store supports Companies and grant read_companies.",
    };
  }

  return {
    dealers: (json.data?.companyLocations?.nodes || [])
      .map(normalizeDealer)
      .filter((dealer: Dealer | null): dealer is Dealer => Boolean(dealer)),
    error: "",
  };
};

export default function DealerMap() {
  const { dealers, error } = useLoaderData() as LoaderData;
  const [addressQuery, setAddressQuery] = useState("");
  const [dealerPoints, setDealerPoints] = useState<DealerPoint[]>([]);
  const [leafletReady, setLeafletReady] = useState(
    typeof window !== "undefined" && Boolean(window.L),
  );
  const [searchPoint, setSearchPoint] = useState<SearchPoint | null>(null);
  const [selectedDealerId, setSelectedDealerId] = useState("");
  const [suggestions, setSuggestions] = useState<GeocodeResult[]>([]);
  const mapNodeRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const layersRef = useRef<LeafletLayer[]>([]);

  useEffect(() => {
    let cancelled = false;

    Promise.all(
      dealers.map(async (dealer) => {
        const result = await geocode(dealer.addressQuery, 1);
        const point = toDealerPoint(dealer, result[0]);

        return point;
      }),
    ).then((points) => {
      if (!cancelled) {
        setDealerPoints(
          points.filter((point: DealerPoint | null): point is DealerPoint =>
            Boolean(point),
          ),
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [dealers]);

  const selectedDealer =
    dealerPoints.find((dealer) => dealer.id === selectedDealerId) ||
    getDefaultDealer(dealerPoints);
  const nearbyDealers = useMemo(() => {
    if (!searchPoint) {
      return dealerPoints;
    }

    return dealerPoints
      .map((dealer) => ({
        ...dealer,
        distance: getDistanceKm(
          searchPoint.lat,
          searchPoint.lng,
          dealer.lat,
          dealer.lng,
        ),
      }))
      .filter((dealer) => dealer.distance <= COVERAGE_RADIUS_KM)
      .sort((first, second) => first.distance - second.distance);
  }, [dealerPoints, searchPoint]);
  const closestDealer = searchPoint ? nearbyDealers[0] : selectedDealer;
  const listedDealers = searchPoint ? nearbyDealers : dealerPoints;

  useEffect(() => {
    if (addressQuery.trim().length < 3) {
      setSuggestions([]);
      return;
    }

    const timeout = window.setTimeout(async () => {
      setSuggestions(await geocode(addressQuery, 5));
    }, 300);

    return () => window.clearTimeout(timeout);
  }, [addressQuery]);

  useEffect(() => {
    if (window.L) {
      setLeafletReady(true);
      return;
    }

    const existingScript = document.getElementById(LEAFLET_SCRIPT_ID);

    if (existingScript) {
      existingScript.addEventListener("load", () => setLeafletReady(true));
      return;
    }

    const script = document.createElement("script");
    script.id = LEAFLET_SCRIPT_ID;
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = () => setLeafletReady(true);
    document.body.appendChild(script);
  }, []);

  useEffect(() => {
    if (!leafletReady || !mapNodeRef.current || !window.L || mapRef.current) {
      return;
    }

    const leaflet = window.L;
    const map = leaflet.map(mapNodeRef.current);
    leaflet
      .tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: "&copy; OpenStreetMap contributors",
      })
      .addTo(map);
    map.setView([56.1304, -106.3468], 4);
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [leafletReady]);

  useEffect(() => {
    if (!leafletReady || !window.L || !mapRef.current) {
      return;
    }

    const leaflet = window.L;
    const map = mapRef.current;
    layersRef.current.forEach((layer) => layer.remove());
    layersRef.current = [];

    const dealerMarkers = dealerPoints.map((dealer) => {
      const marker = leaflet
        .marker([dealer.lat, dealer.lng], { icon: getDealerIcon(leaflet) })
        .bindPopup(
          `<strong>${escapeHtml(dealer.name)}</strong><br>${escapeHtml(dealer.address)}`,
        )
        .addTo(map);

      layersRef.current.push(marker);

      const dealerCircle = leaflet
        .circle([dealer.lat, dealer.lng], {
          color: "#ff671d",
          fillColor: "#ffb384",
          fillOpacity: 0.07,
          radius: COVERAGE_RADIUS_KM * 1000,
          weight: 1,
        })
        .bindPopup(
          `<strong>${escapeHtml(dealer.name)}</strong><br>${COVERAGE_RADIUS_KM} km dealer radius`,
        )
        .addTo(map);
      layersRef.current.push(dealerCircle);

      return [dealer.lat, dealer.lng] as [number, number];
    });

    if (selectedDealer && !searchPoint) {
      const selectedMarker = leaflet
        .marker([selectedDealer.lat, selectedDealer.lng], {
          icon: getDealerIcon(leaflet),
        })
        .bindPopup(
          `<strong>${escapeHtml(selectedDealer.name)}</strong><br>${COVERAGE_RADIUS_KM} km dealer radius`,
        )
        .addTo(map)
        .openPopup();
      layersRef.current.push(selectedMarker);
    }

    if (searchPoint) {
      const searchMarker = leaflet
        .marker([searchPoint.lat, searchPoint.lng], {
          icon: getSearchIcon(leaflet),
        })
        .bindPopup(
          `<strong>${escapeHtml(searchPoint.label)}</strong><br>Searched address`,
        )
        .addTo(map)
        .openPopup();
      layersRef.current.push(searchMarker);
      dealerMarkers.push([searchPoint.lat, searchPoint.lng]);
    }

    if (dealerMarkers.length > 1) {
      map.fitBounds(leaflet.latLngBounds(dealerMarkers), {
        padding: [42, 42],
      });
      return;
    }

    if (selectedDealer) {
      map.setView([selectedDealer.lat, selectedDealer.lng], 7);
      return;
    }

    if (searchPoint) {
      map.setView([searchPoint.lat, searchPoint.lng], 7);
    }
  }, [dealerPoints, leafletReady, nearbyDealers, searchPoint, selectedDealer]);

  return (
    <s-page heading="Internal Dealer Map">
      <s-section>
        <div className={styles.toolbar}>
          <label className={`${styles.field} ${styles.searchField}`}>
            <span>Search address</span>
            <input
              onChange={(event) => {
                setAddressQuery(event.target.value);
                setSearchPoint(null);
              }}
              placeholder="Enter address, city, or postal code"
              type="search"
              value={addressQuery}
            />
            {suggestions.length ? (
              <div className={styles.suggestions}>
                {suggestions.map((suggestion) => (
                  <button
                    key={`${suggestion.lat}-${suggestion.lon}`}
                    onClick={() => {
                      setAddressQuery(suggestion.display_name);
                      setSearchPoint(toSearchPoint(suggestion));
                      setSuggestions([]);
                    }}
                    type="button"
                  >
                    {suggestion.display_name}
                  </button>
                ))}
              </div>
            ) : null}
          </label>
          <div className={styles.field}>
            <span>Closest company dealer</span>
            <div className={styles.closestDealer}>
              <strong>{closestDealer?.name || "No company in radius"}</strong>
            </div>
          </div>
          <div className={styles.radiusField}>
            <span>Radius</span>
            <div className={styles.radius}>
              <strong>{COVERAGE_RADIUS_KM} km</strong>
            </div>
          </div>
        </div>
        <div className={styles.workspace}>
          <div className={styles.list}>
            {error ? <p className={styles.message}>{error}</p> : null}
            {!error && !dealers.length ? (
              <p className={styles.message}>
                No Shopify company locations were found.
              </p>
            ) : null}
            {!error && dealers.length && !dealerPoints.length ? (
              <p className={styles.message}>Locating company addresses...</p>
            ) : null}
            {!error && dealerPoints.length && !listedDealers.length ? (
              <p className={styles.message}>
                No company dealers are inside this 150 km radius.
              </p>
            ) : null}
            {listedDealers.map((dealer) => (
              <button
                className={
                  dealer.id === selectedDealer?.id && !searchPoint
                    ? styles.activeDealer
                    : styles.dealer
                }
                key={dealer.id}
                onClick={() => {
                  setSearchPoint(null);
                  setSelectedDealerId(dealer.id);
                }}
                type="button"
              >
                <span className={styles.pin} aria-hidden="true">
                  &#x25BC;
                </span>
                <span className={styles.dealerDetails}>
                  <strong>{dealer.name}</strong>
                  <span>{dealer.address}</span>
                  {dealer.locationName !== dealer.name ? (
                    <span>{dealer.locationName}</span>
                  ) : null}
                  {dealer.phone ? (
                    <span className={styles.contact}>{dealer.phone}</span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
          <div className={styles.map} ref={mapNodeRef} />
        </div>
      </s-section>
    </s-page>
  );
}

function normalizeDealer(node: CompanyLocationNode): Dealer | null {
  const address = node.shippingAddress || node.billingAddress;
  const isApprovedForOrdering = node.roleAssignments.nodes.length > 0;
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

  if (!isApprovedForOrdering || !addressParts) {
    return null;
  }

  return {
    id: node.id,
    name: node.company.name,
    locationName: node.name,
    address: addressParts,
    phone: node.phone || "",
    addressQuery: addressParts,
  };
}

async function geocode(query: string, limit: number) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("countrycodes", "ca");
  url.searchParams.set("q", query);

  try {
    const response = await fetch(url);

    return response.ok ? ((await response.json()) as GeocodeResult[]) : [];
  } catch {
    return [];
  }
}

function toDealerPoint(dealer: Dealer, result?: GeocodeResult) {
  const point = result ? toSearchPoint(result) : null;

  return point ? { ...dealer, lat: point.lat, lng: point.lng } : null;
}

function toSearchPoint(result: GeocodeResult) {
  return {
    label: result.display_name,
    lat: Number(result.lat),
    lng: Number(result.lon),
  };
}

function getDefaultDealer(dealers: DealerPoint[]) {
  return (
    dealers.find((dealer) =>
      dealer.name.toLowerCase().includes("farm equip"),
    ) || dealers[0]
  );
}

function getDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const earthRadiusKm = 6371;
  const latitudeDistance = toRadians(lat2 - lat1);
  const longitudeDistance = toRadians(lng2 - lng1);
  const a =
    Math.sin(latitudeDistance / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(longitudeDistance / 2) ** 2;

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function getDealerIcon(leaflet: LeafletApi) {
  return leaflet.divIcon({
    className: "dealer-map-marker",
    html: '<span aria-hidden="true"></span>',
    iconAnchor: [15, 34],
    iconSize: [30, 36],
    popupAnchor: [0, -30],
  });
}

function getSearchIcon(leaflet: LeafletApi) {
  return leaflet.divIcon({
    className: "search-map-marker",
    html: '<span aria-hidden="true"></span>',
    iconAnchor: [15, 34],
    iconSize: [30, 36],
    popupAnchor: [0, -30],
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
