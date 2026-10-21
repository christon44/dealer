import { createHash } from "node:crypto";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import dealerLocatorSectionLiquid from "../theme-assets/dealer-locator.liquid?raw";
import dealerLocatorPageTemplate from "../theme-assets/page.page-dealer-locator.json?raw";

const PAGE_HANDLE = "dealer-locator";
const PAGE_TEMPLATE_SUFFIX = "page-dealer-locator";

const THEME_ASSETS_HASH = createHash("sha256")
  .update(dealerLocatorSectionLiquid)
  .update(dealerLocatorPageTemplate)
  .digest("hex");
const THEME_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const lastThemeChecks = new Map<string, number>();

// Uploads the theme files when this build's copies differ from the ones last
// uploaded (a deploy changed them) or the store published another main theme.
// Checks a shop at most every 10 minutes per server process.
export async function syncDealerLocatorTheme(shop: string, admin: AdminApiContext) {
  const lastCheck = lastThemeChecks.get(shop);
  if (lastCheck && Date.now() - lastCheck < THEME_CHECK_INTERVAL_MS) return;
  lastThemeChecks.set(shop, Date.now());

  const [installed, themeId] = await Promise.all([
    prisma.themeInstall.findUnique({ where: { shop } }),
    getMainThemeId(admin),
  ]);
  if (
    installed &&
    installed.themeId === themeId &&
    installed.assetsHash === THEME_ASSETS_HASH
  ) {
    return;
  }

  console.info(`[dealer-locator] Theme files for ${shop} are out of date; uploading them.`);
  await installDealerLocatorTheme(admin, shop);
}

export async function installDealerLocatorTheme(admin: AdminApiContext, shop: string) {
  const themeId = await getMainThemeId(admin);

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

  const installed = { themeId, assetsHash: THEME_ASSETS_HASH };
  await prisma.themeInstall.upsert({
    where: { shop },
    create: { shop, ...installed },
    update: installed,
  });

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

async function getMainThemeId(admin: AdminApiContext): Promise<string | undefined> {
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
  return themePayload.data?.themes?.nodes?.[0]?.id;
}
