import { useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { installDealerLocatorTheme } from "../lib/install-dealer-locator.server";

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
  showOnMap: boolean;
};

type CompanyLocationNode = {
  id: string;
  name: string;
  phone: string | null;
  showOnMap: { value: string } | null;
  company: {
    name: string;
    locations: {
      nodes: Array<{
        roleAssignments: { nodes: Array<{ id: string }> };
      }>;
    };
  };
  shippingAddress: Address | null;
  billingAddress: Address | null;
};

type DealerQueryResponse = {
  data?: {
    shop?: {
      dealerLocatorPassword?: { value: string } | null;
      defaultRadius?: { value: string } | null;
    };
    companyLocations?: {
      nodes?: CompanyLocationNode[];
    };
  };
  errors?: unknown;
};

type LoaderData = {
  dealers: Dealer[];
  error: string;
  password: string;
  defaultRadiusKm: number;
  showDeveloperSection: boolean;
};

const DEALER_LOCATOR_PASSWORD_NAMESPACE = "custom";
const DEALER_LOCATOR_PASSWORD_KEY = "dealer_locator_password";
const DEFAULT_DEALER_LOCATOR_PASSWORD = "TMG2026";

const DEFAULT_RADIUS_NAMESPACE = "custom";
const DEFAULT_RADIUS_KEY = "dealer_locator_default_radius";
const FALLBACK_DEFAULT_RADIUS_KM = 50;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const response = await admin.graphql(
    `#graphql
      query DealerCompanies {
        shop {
          dealerLocatorPassword: metafield(namespace: "${DEALER_LOCATOR_PASSWORD_NAMESPACE}", key: "${DEALER_LOCATOR_PASSWORD_KEY}") {
            value
          }
          defaultRadius: metafield(namespace: "${DEFAULT_RADIUS_NAMESPACE}", key: "${DEFAULT_RADIUS_KEY}") {
            value
          }
        }
        companyLocations(first: 250) {
          nodes {
            id
            name
            phone
            showOnMap: metafield(namespace: "custom", key: "show_on_map") {
              value
            }
            company {
              name
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
  );
  const json = (await response.json()) as DealerQueryResponse;
  const showDeveloperSection = process.env.NODE_ENV !== "production";

  if (json.errors) {
    console.error("Unable to load company locations", json.errors);
    return {
      dealers: [],
      error:
        "Company locations could not be loaded. Confirm this store supports Companies and grant read_companies.",
      password: DEFAULT_DEALER_LOCATOR_PASSWORD,
      defaultRadiusKm: FALLBACK_DEFAULT_RADIUS_KM,
      showDeveloperSection,
    };
  }

  const defaultRadiusValue = json.data?.shop?.defaultRadius?.value;
  const defaultRadiusKm =
    defaultRadiusValue === null ||
    defaultRadiusValue === undefined ||
    defaultRadiusValue === "" ||
    !Number.isFinite(Number(defaultRadiusValue))
      ? FALLBACK_DEFAULT_RADIUS_KM
      : Number(defaultRadiusValue);

  return {
    dealers: (json.data?.companyLocations?.nodes || [])
      .map(normalizeDealer)
      .filter((dealer: Dealer | null): dealer is Dealer => Boolean(dealer)),
    error: "",
    password:
      json.data?.shop?.dealerLocatorPassword?.value ||
      DEFAULT_DEALER_LOCATOR_PASSWORD,
    defaultRadiusKm,
    showDeveloperSection,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "savePassword") {
    const password = String(formData.get("password") || "").trim();
    if (!password) {
      return { passwordError: "Password cannot be empty." };
    }

    const shopResponse = await admin.graphql(`#graphql
      query DealerLocatorShopId {
        shop { id }
      }`);
    const shopJson = (await shopResponse.json()) as {
      data?: { shop?: { id?: string } };
    };
    const shopId = shopJson.data?.shop?.id;

    if (!shopId) {
      return { passwordError: "Could not resolve shop." };
    }

    const response = await admin.graphql(
      `#graphql
        mutation SetDealerLocatorPassword($ownerId: ID!, $value: String!) {
          metafieldsSet(metafields: [{
            ownerId: $ownerId
            namespace: "${DEALER_LOCATOR_PASSWORD_NAMESPACE}"
            key: "${DEALER_LOCATOR_PASSWORD_KEY}"
            type: "single_line_text_field"
            value: $value
          }]) {
            userErrors { field message }
          }
        }`,
      { variables: { ownerId: shopId, value: password } },
    );
    const result = (await response.json()) as {
      data?: { metafieldsSet?: { userErrors?: Array<{ message: string }> } };
    };
    const userErrors = result.data?.metafieldsSet?.userErrors || [];

    if (userErrors.length) {
      return { passwordError: userErrors.map((e) => e.message).join(" ") };
    }

    return { passwordSaved: true };
  }

  if (intent === "saveDefaultRadius") {
    const radiusValue = Number(formData.get("defaultRadiusKm"));
    if (!Number.isFinite(radiusValue) || radiusValue <= 0) {
      return { radiusError: "Enter a radius greater than 0." };
    }

    const shopResponse = await admin.graphql(`#graphql
      query DealerLocatorShopId {
        shop { id }
      }`);
    const shopJson = (await shopResponse.json()) as {
      data?: { shop?: { id?: string } };
    };
    const shopId = shopJson.data?.shop?.id;

    if (!shopId) {
      return { radiusError: "Could not resolve shop." };
    }

    const response = await admin.graphql(
      `#graphql
        mutation SetDealerLocatorDefaultRadius($ownerId: ID!, $value: String!) {
          metafieldsSet(metafields: [{
            ownerId: $ownerId
            namespace: "${DEFAULT_RADIUS_NAMESPACE}"
            key: "${DEFAULT_RADIUS_KEY}"
            type: "number_integer"
            value: $value
          }]) {
            userErrors { field message }
          }
        }`,
      { variables: { ownerId: shopId, value: String(Math.round(radiusValue)) } },
    );
    const result = (await response.json()) as {
      data?: { metafieldsSet?: { userErrors?: Array<{ message: string }> } };
    };
    const userErrors = result.data?.metafieldsSet?.userErrors || [];

    if (userErrors.length) {
      return { radiusError: userErrors.map((e) => e.message).join(" ") };
    }

    return { radiusSaved: true };
  }

  if (process.env.NODE_ENV === "production") {
    return { resyncError: "Theme resync is disabled in production." };
  }

  await installDealerLocatorTheme(admin);
  return { resynced: true };
};

function useTimedVisibility(
  condition: boolean,
  signal: unknown,
  durationMs = 3000,
) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!condition) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), durationMs);
    return () => clearTimeout(timer);
  }, [condition, signal, durationMs]);

  return visible;
}

export default function DealerMap() {
  const { dealers, error, password, defaultRadiusKm, showDeveloperSection } =
    useLoaderData() as LoaderData;
  const actionData = useActionData() as
    | {
        resynced?: boolean;
        resyncError?: string;
        passwordSaved?: boolean;
        passwordError?: string;
        radiusSaved?: boolean;
        radiusError?: string;
      }
    | undefined;
  const [passwordInput, setPasswordInput] = useState(password);
  const [defaultRadiusInput, setDefaultRadiusInput] = useState(
    String(defaultRadiusKm),
  );

  const showPasswordSaved = useTimedVisibility(
    Boolean(actionData?.passwordSaved),
    actionData,
  );
  const showRadiusSaved = useTimedVisibility(
    Boolean(actionData?.radiusSaved),
    actionData,
  );
  const showResynced = useTimedVisibility(
    Boolean(actionData?.resynced),
    actionData,
  );

  const approvedCount = useMemo(
    () => dealers.filter((dealer) => dealer.status === "Approved").length,
    [dealers],
  );

  const selectedLocationsCount = useMemo(
    () => dealers.filter((dealer) => dealer.showOnMap).length,
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
          <s-badge tone="success">{approvedCount} approved dealers</s-badge>
          <s-badge tone="info">{selectedLocationsCount} selected locations shown</s-badge>
          <s-badge tone="neutral">{dealers.length} total companies</s-badge>
        </s-stack>
      </s-section>
      <s-section heading="Storefront access">
        <s-paragraph>
          Users must enter this password before they can view the
          dealer locator page on your storefront.
        </s-paragraph>
        <Form method="post">
          <input type="hidden" name="intent" value="savePassword" />
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-password-field
              name="password"
              label="Page password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.currentTarget.value)}
              autocomplete="off"
            ></s-password-field>
            <s-button type="submit">Save password</s-button>
          </s-stack>
        </Form>
        {showPasswordSaved ? (
          <div style={{ marginTop: "5px" }}>
            <s-badge tone="success">Password saved</s-badge>
          </div>
        ) : null}
        {actionData?.passwordError ? (
          <s-paragraph>{actionData.passwordError}</s-paragraph>
        ) : null}
      </s-section>
      <s-section heading="Default radius">
        <s-paragraph>
          Used as the dealer radius on the storefront map when a
          company location doesn't have its own radius metafield set.
        </s-paragraph>
        <Form method="post">
          <input type="hidden" name="intent" value="saveDefaultRadius" />
          <s-stack direction="inline" gap="base" alignItems="end">
            <s-number-field
              name="defaultRadiusKm"
              label="Default radius (km)"
              value={defaultRadiusInput}
              onChange={(e) => setDefaultRadiusInput(e.currentTarget.value)}
              min={1}
              step={1}
              inputMode="numeric"
            ></s-number-field>
            <s-button type="submit">Save radius</s-button>
          </s-stack>
        </Form>
        {showRadiusSaved ? (
          <div style={{ marginTop: "5px" }}>
            <s-badge tone="success">Default radius saved</s-badge>
          </div>
        ) : null}
        {actionData?.radiusError ? (
          <s-paragraph>{actionData.radiusError}</s-paragraph>
        ) : null}
      </s-section>
      {showDeveloperSection ? (
        <s-section heading="Developer">
          <s-paragraph>
            Re-uploads the local dealer-locator section/template files to
            this store's main theme. Use this during development instead of
            uninstalling/reinstalling the app to pick up local edits.
          </s-paragraph>
          <Form method="post">
            <s-button type="submit">Resync dealer locator theme files</s-button>
          </Form>
          {showResynced ? (
            <div style={{ marginTop: "5px" }}>
              <s-badge tone="success">Theme files resynced</s-badge>
            </div>
          ) : null}
        </s-section>
      ) : null}
    </s-page>
  );
}

function normalizeDealer(node: CompanyLocationNode): Dealer | null {
  const address = node.shippingAddress || node.billingAddress;
  const isApprovedForOrdering = node.company.locations.nodes.some(
    (location) => location.roleAssignments.nodes.length > 0,
  );
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
    showOnMap: node.showOnMap?.value !== "false",
  };
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
