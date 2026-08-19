export {
  createOrganizationForNewUser,
  createClientOrganizationForAgency,
  getOrganizationById,
  listOrganizationsForAgency,
  type NewOrganizationResult,
  type NewClientOrganizationResult,
  type OrganizationSummary,
} from "./organizations";
export { getAgencyById, type AgencySummary } from "./agencies";
export {
  listCompaniesForAgency,
  listContactsForAgency,
  listDealsForAgency,
  listPipelinesForAgency,
  type AgencyRollupCompany,
  type AgencyRollupContact,
  type AgencyRollupDeal,
  type AgencyRollupPipeline,
} from "./agency-rollup";
export { slugify, slugWithSuffix } from "./slug";
export {
  contrastRatio,
  ensureContrast,
  hexToRgb,
  hslToRgb,
  meetsWcagAA,
  relativeLuminance,
  rgbToHex,
  rgbToHsl,
  WCAG_AA_LARGE_TEXT_RATIO,
  WCAG_AA_NORMAL_TEXT_RATIO,
  type ContrastAdjustmentResult,
  type Hsl,
  type Rgb,
} from "./contrast";
export {
  PLATFORM_DEFAULT_THEME,
  resolveTheme,
  resolveThemeForAgency,
  resolveThemeForOrganization,
  type ResolvedTheme,
  type ThemeOverride,
  type ThemeSource,
} from "./theme";
