import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getCachedDealers,
  isUnauthorized,
  logRefreshError,
  refreshDealerCache,
} from "../lib/dealers.server";
import { syncDealerLocatorTheme } from "../lib/install-dealer-locator.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Throws on an invalid app proxy signature, so `shop` can be trusted below.
  const { admin } = await authenticate.public.appProxy(request);
  const shop = new URL(request.url).searchParams.get("shop") || "";

  if (admin) {
    syncDealerLocatorTheme(shop, admin).catch((error) =>
      console.error(`[dealer-locator] Theme file check for ${shop} failed`, error),
    );
  }

  const cached = await getCachedDealers(shop);
  if (cached) {
    if (cached.isStale) {
      if (admin) {
        refreshDealerCache(shop, admin).catch((error) => logRefreshError(shop, error));
      } else {
        console.warn(
          `[dealer-locator] No offline session stored for ${shop}, so saved dealers can't be refreshed. Open the app in Shopify admin to create one.`,
        );
      }
    }
    return json({ dealers: cached.dealers, error: "" });
  }

  if (!admin) {
    console.warn(
      `[dealer-locator] No offline session stored for ${shop}. Open the app in Shopify admin to create one.`,
    );
    return json({ dealers: [], error: "No app proxy session was found." }, 401);
  }

  try {
    return json({ dealers: await refreshDealerCache(shop, admin), error: "" });
  } catch (error) {
    logRefreshError(shop, error);
    return isUnauthorized(error)
      ? json({ dealers: [], error: "The app's access token was rejected." }, 401)
      : json({ dealers: [], error: "Company locations could not be loaded." }, 500);
  }
};

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
