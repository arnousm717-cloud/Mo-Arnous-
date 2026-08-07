import { cache } from "react";
import type { Metadata } from "next";
import { getAuthenticatedUser, resolveOrganizationContextForUser } from "@ai-revenue-os/auth";
import { PLATFORM_DEFAULT_THEME, resolveThemeForOrganization, type ResolvedTheme } from "@ai-revenue-os/tenancy";
import { buildThemeStyleTag } from "./theme-css";

/**
 * Server-side theme resolution for every request (docs/07-UI-UX-System.md
 * §2) — resolved and injected as inline CSS before the first byte of HTML
 * is sent, so there is no client-side theme flash to guard against at all,
 * not a flash-of-default-theme hidden by JS after the fact. Unauthenticated
 * requests (e.g. /login, /signup) and authenticated requests with no
 * organization both resolve straight to the platform default without a
 * database round trip — only an authenticated, org-linked request pays for
 * the actual lookup.
 *
 * Only the theme's resolved color/font VALUES ever reach the client, as
 * plain CSS custom properties — no organization id, agency id, role, or any
 * other tenant identifier is serialized into the page at all here.
 */
// react's cache() deduplicates this across the request — generateMetadata()
// and RootLayout() below both need the resolved theme, and without this
// they'd each independently re-authenticate and re-query, doubling the
// work (and the GoTrue round trip) on every single request.
const resolveThemeForCurrentRequest = cache(async (): Promise<ResolvedTheme> => {
  const user = await getAuthenticatedUser();
  if (!user) {
    return { ...PLATFORM_DEFAULT_THEME, source: "platform-default" };
  }

  const orgContext = await resolveOrganizationContextForUser(user.id);
  if (!orgContext) {
    return { ...PLATFORM_DEFAULT_THEME, source: "platform-default" };
  }

  return resolveThemeForOrganization({ userId: user.id, organizationId: orgContext.organizationId });
});

export async function generateMetadata(): Promise<Metadata> {
  const theme = await resolveThemeForCurrentRequest();
  return {
    title: "AI Revenue OS",
    ...(theme.faviconUrl ? { icons: { icon: theme.faviconUrl } } : {}),
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const theme = await resolveThemeForCurrentRequest();
  const themeStyle = buildThemeStyleTag(theme);

  return (
    <html lang="en">
      <head>
        <style>{themeStyle}</style>
      </head>
      <body>{children}</body>
    </html>
  );
}
