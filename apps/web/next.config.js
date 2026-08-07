/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship raw TypeScript source (no build step, per
  // packages/database and packages/auth's "exports": "./src/index.ts") —
  // this tells Next.js's own compiler to transpile them directly rather
  // than expecting pre-built JS.
  transpilePackages: ["@ai-revenue-os/auth", "@ai-revenue-os/tenancy", "@ai-revenue-os/database"],
};

module.exports = nextConfig;
