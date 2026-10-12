import { fail } from "./errors";

/** The web app's public URL, from `SITE_URL`, without a trailing slash. */
export const siteUrl = (): string => {
  const url = process.env.SITE_URL;

  if (url === undefined || url.length === 0) {
    return fail("internal", "SITE_URL is not set on this deployment");
  }

  return url.replace(/\/+$/u, "");
};
