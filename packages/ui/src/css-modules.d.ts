declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  // Ambient type declaration for a bundler-processed asset, not a business-
  // logic module — the same "framework-required" exception CLAUDE.md
  // already carves out for page.tsx/layout.tsx default exports. Next.js's
  // (and Vite's) CSS Modules support requires `import styles from
  // "*.module.css"` as a default import; there is no named-export form of
  // this that either bundler actually produces at runtime.
  // eslint-disable-next-line no-restricted-syntax
  export default classes;
}
