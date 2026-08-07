/** Converts "Acme Inc." into "acme-inc" — lowercase, alphanumeric, hyphen-separated. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Appends a short random suffix — used to retry after a slug collision. */
export function slugWithSuffix(baseSlug: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${baseSlug}-${suffix}`;
}
