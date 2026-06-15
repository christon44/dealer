import { useMemo } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

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
  status: "Approved" | "Not approved";
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

  const approvedCount = useMemo(
    () => dealers.filter((dealer) => dealer.status === "Approved").length,
    [dealers],
  );

  return (
    <s-page heading="Internal Dealer Map">
      <s-section>
        <s-banner heading="Welcome to the Internal Dealer Map" tone="info">
          <s-paragraph>
            This app powers the dealer locator on your storefront, which
            shows customers only your approved company dealers and lets them
            search for the nearest one.
          </s-paragraph>
        </s-banner>
      </s-section>
      <s-section heading="Settings">
        {error ? <s-paragraph>{error}</s-paragraph> : null}
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-badge tone="success">{approvedCount} approved dealers shown on storefront</s-badge>
          <s-badge tone="neutral">{dealers.length} total companies</s-badge>
        </s-stack>
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

  if (!addressParts) {
    return null;
  }

  return {
    id: node.id,
    name: node.company.name,
    locationName: node.name,
    address: addressParts,
    phone: node.phone || "",
    addressQuery: addressParts,
    status: isApprovedForOrdering ? "Approved" : "Not approved",
  };
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
