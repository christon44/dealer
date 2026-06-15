import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import dealerLocatorSectionLiquid from "../theme-assets/dealer-locator.liquid?raw";
import dealerLocatorPageTemplate from "../theme-assets/page.page-dealer-locator.json?raw";

const PAGE_HANDLE = "dealer-locator";
const PAGE_TEMPLATE_SUFFIX = "page-dealer-locator";

export async function installDealerLocatorTheme(admin: AdminApiContext) {
  const themeResponse = await admin.graphql(
    `#graphql
      query MainTheme {
        themes(first: 1, roles: [MAIN]) {
          nodes {
            id
          }
        }
      }`,
  );
  const themePayload = await themeResponse.json();
  const themeId = themePayload.data?.themes?.nodes?.[0]?.id;

  if (!themeId) {
    console.error("Unable to install dealer locator: no main theme found.");
    return;
  }

  const filesResponse = await admin.graphql(
    `#graphql
      mutation UpsertDealerLocatorThemeFiles($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
        themeFilesUpsert(themeId: $themeId, files: $files) {
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        themeId,
        files: [
          {
            filename: "sections/dealer-locator.liquid",
            body: { type: "TEXT", value: dealerLocatorSectionLiquid },
          },
          {
            filename: "templates/page.page-dealer-locator.json",
            body: { type: "TEXT", value: dealerLocatorPageTemplate },
          },
        ],
      },
    },
  );
  const filesPayload = await filesResponse.json();
  const fileErrors = filesPayload.data?.themeFilesUpsert?.userErrors;
  if (fileErrors?.length) {
    console.error("Unable to upload dealer locator theme files", fileErrors);
    return;
  }

  const existingPageResponse = await admin.graphql(
    `#graphql
      query DealerLocatorPage($query: String!) {
        pages(first: 1, query: $query) {
          nodes {
            id
          }
        }
      }`,
    { variables: { query: `handle:${PAGE_HANDLE}` } },
  );
  const existingPagePayload = await existingPageResponse.json();
  if (existingPagePayload.data?.pages?.nodes?.length) {
    return;
  }

  const pageCreateResponse = await admin.graphql(
    `#graphql
      mutation CreateDealerLocatorPage($page: PageCreateInput!) {
        pageCreate(page: $page) {
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        page: {
          title: "Dealer Locator",
          handle: PAGE_HANDLE,
          isPublished: true,
          templateSuffix: PAGE_TEMPLATE_SUFFIX,
        },
      },
    },
  );
  const pageCreatePayload = await pageCreateResponse.json();
  const pageErrors = pageCreatePayload.data?.pageCreate?.userErrors;
  if (pageErrors?.length) {
    console.error("Unable to create dealer locator page", pageErrors);
  }
}
