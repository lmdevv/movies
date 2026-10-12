/**
 * Where to go after signing in or choosing a profile. Only paths inside this app are followed, so a
 * crafted `?redirect=https://…` link cannot send someone elsewhere after they sign in.
 */
export const safeRedirect = (redirect: string | undefined): string =>
  redirect !== undefined &&
  redirect.startsWith("/") &&
  !redirect.startsWith("//") &&
  !redirect.startsWith("/\\")
    ? redirect
    : "/";
