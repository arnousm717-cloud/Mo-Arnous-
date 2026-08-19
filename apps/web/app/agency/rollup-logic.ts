import { can } from "@ai-revenue-os/auth";
import {
  listOrganizationsForAgency,
  listCompaniesForAgency,
  listContactsForAgency,
  listDealsForAgency,
  listPipelinesForAgency,
} from "@ai-revenue-os/tenancy";
import { dealDisplayLabel } from "../deals/deal-display";

/**
 * Milestone 2.4D: application-layer authorization + composition for the
 * four agency CRM roll-up pages. Kept out of any "use server" file
 * deliberately, mirroring create-client-org-logic.ts's own precedent
 * exactly — every export of a "use server" file becomes an independently
 * callable RPC endpoint, so a function that trusts an already-resolved
 * agencyContext must never live there. Each page.tsx resolves the real
 * context via resolveAgencyRequestContext() itself, then calls in here.
 *
 * This is where can() is actually checked — packages/tenancy's
 * listXForAgency functions are deliberately authorization-free (2.4C,
 * Option A), trusting the caller. A roll-up tenancy function is never
 * called here unless the matching companies:/contacts:/deals:/
 * pipelines:agency-rollup-read permission already returned true. The
 * database roll-up views (2.4A: security_invoker=false,
 * current_agency()/current_role_key() in their own WHERE clause) remain
 * the real, underlying security boundary regardless — this file is
 * defense-in-depth on top of that, never a replacement for it.
 *
 * Organization labeling: listOrganizationsForAgency (already-existing,
 * unchanged) is called once per request and turned into an
 * organizationId -> name map, joined here in application code — never a
 * change to the 2.4A views. A row whose organizationId isn't in that map
 * (should not happen in practice, since both queries scope identically by
 * current_agency(); kept only as a defensive fallback against a
 * theoretical same-request TOCTOU where an org's agency_id changes
 * between the two independent queries) renders as "Unknown client
 * organization" — never the raw UUID.
 *
 * Company/pipeline name resolution for the Contacts/Deals pages is itself
 * gated by a SEPARATE can() check (companies:agency-rollup-read /
 * pipelines:agency-rollup-read) before ever calling those roll-up
 * functions — today's 2.4B matrix always grants all four keys together to
 * the same two roles, so this never actually degrades in practice, but
 * the code does not assume that will always remain true.
 */

export const UNKNOWN_ORGANIZATION_LABEL = "Unknown client organization";

interface AgencyContext {
  userId: string;
  agencyId: string;
  roleKey: string;
}

export type RollupResult<T> = { kind: "denied" } | { kind: "error" } | { kind: "ready"; rows: T[] };

async function buildOrganizationLabelMap(ctx: AgencyContext): Promise<Map<string, string>> {
  const organizations = await listOrganizationsForAgency(ctx);
  return new Map(organizations.map((org) => [org.id, org.name]));
}

/** Exported (unlike buildOrganizationLabelMap, which needs a live query)
 * specifically so the fallback itself is directly, deterministically unit
 * testable without needing to reproduce the theoretical same-request
 * TOCTOU race described in this file's own top comment. */
export function resolveOrganizationLabel(labels: Map<string, string>, organizationId: string): string {
  return labels.get(organizationId) ?? UNKNOWN_ORGANIZATION_LABEL;
}

export interface AgencyCompanyRow {
  id: string;
  name: string;
  organizationLabel: string;
  domain: string | null;
  industry: string | null;
  employeeCount: number | null;
  annualRevenue: string | null;
}

export async function listCompaniesForAgencyConsole(
  agencyContext: AgencyContext | null,
): Promise<RollupResult<AgencyCompanyRow>> {
  if (!agencyContext || !can(agencyContext, "companies:agency-rollup-read")) {
    return { kind: "denied" };
  }
  try {
    const [orgLabels, companies] = await Promise.all([
      buildOrganizationLabelMap(agencyContext),
      listCompaniesForAgency(agencyContext),
    ]);
    const rows: AgencyCompanyRow[] = companies.map((company) => ({
      id: company.id,
      name: company.name,
      organizationLabel: resolveOrganizationLabel(orgLabels, company.organizationId),
      domain: company.domain,
      industry: company.industry,
      employeeCount: company.employeeCount,
      annualRevenue: company.annualRevenue,
    }));
    return { kind: "ready", rows };
  } catch {
    return { kind: "error" };
  }
}

export interface AgencyContactRow {
  id: string;
  name: string;
  organizationLabel: string;
  /** null = no company link on this contact, or company-name resolution
   * wasn't authorized/possible — the UI renders either case as "—", never
   * a raw companyId. */
  companyLabel: string | null;
  lifecycleStage: string | null;
}

export async function listContactsForAgencyConsole(
  agencyContext: AgencyContext | null,
): Promise<RollupResult<AgencyContactRow>> {
  if (!agencyContext || !can(agencyContext, "contacts:agency-rollup-read")) {
    return { kind: "denied" };
  }
  try {
    const canReadCompanies = can(agencyContext, "companies:agency-rollup-read");
    const [orgLabels, contacts, companies] = await Promise.all([
      buildOrganizationLabelMap(agencyContext),
      listContactsForAgency(agencyContext),
      canReadCompanies ? listCompaniesForAgency(agencyContext) : Promise.resolve([]),
    ]);
    const companyNames = new Map(companies.map((company) => [company.id, company.name]));
    const rows: AgencyContactRow[] = contacts.map((contact) => ({
      id: contact.id,
      name: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || "(no name)",
      organizationLabel: resolveOrganizationLabel(orgLabels, contact.organizationId),
      companyLabel: contact.companyId ? (companyNames.get(contact.companyId) ?? null) : null,
      lifecycleStage: contact.lifecycleStage,
    }));
    return { kind: "ready", rows };
  } catch {
    return { kind: "error" };
  }
}

export interface AgencyDealRow {
  id: string;
  dealLabel: string;
  organizationLabel: string;
  /** null = no company link, or company-name resolution wasn't
   * authorized/possible — rendered as "—", never a raw companyId. */
  companyLabel: string | null;
  /** null = pipeline-name resolution wasn't authorized/possible —
   * rendered as "—", never a raw pipelineId. Every deal has a
   * pipeline_id (NOT NULL), so this is only ever null due to a missing
   * pipelines:agency-rollup-read grant, never a missing relationship. */
  pipelineLabel: string | null;
  amount: string | null;
  currency: string;
  status: string;
  expectedCloseDate: string | null;
}

export async function listDealsForAgencyConsole(
  agencyContext: AgencyContext | null,
): Promise<RollupResult<AgencyDealRow>> {
  if (!agencyContext || !can(agencyContext, "deals:agency-rollup-read")) {
    return { kind: "denied" };
  }
  try {
    const canReadCompanies = can(agencyContext, "companies:agency-rollup-read");
    const canReadPipelines = can(agencyContext, "pipelines:agency-rollup-read");
    const [orgLabels, deals, companies, pipelines] = await Promise.all([
      buildOrganizationLabelMap(agencyContext),
      listDealsForAgency(agencyContext),
      canReadCompanies ? listCompaniesForAgency(agencyContext) : Promise.resolve([]),
      canReadPipelines ? listPipelinesForAgency(agencyContext) : Promise.resolve([]),
    ]);
    const companyNames = new Map(companies.map((company) => [company.id, company.name]));
    const pipelineNames = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline.name]));
    const rows: AgencyDealRow[] = deals.map((deal) => {
      const companyName = deal.companyId ? (companyNames.get(deal.companyId) ?? null) : null;
      return {
        id: deal.id,
        // No contact name available on this view (2.4A deliberately
        // excludes primary_contact_id from agency_rollup_deals) — reuses
        // the existing dealDisplayLabel() fallback chain unchanged
        // (company name -> short id, contact name never populated here).
        dealLabel: dealDisplayLabel(deal.id, companyName, null),
        organizationLabel: resolveOrganizationLabel(orgLabels, deal.organizationId),
        companyLabel: companyName,
        pipelineLabel: pipelineNames.get(deal.pipelineId) ?? null,
        amount: deal.amount,
        currency: deal.currency,
        status: deal.status,
        expectedCloseDate: deal.expectedCloseDate,
      };
    });
    return { kind: "ready", rows };
  } catch {
    return { kind: "error" };
  }
}

export interface AgencyPipelineRow {
  id: string;
  name: string;
  organizationLabel: string;
}

export async function listPipelinesForAgencyConsole(
  agencyContext: AgencyContext | null,
): Promise<RollupResult<AgencyPipelineRow>> {
  if (!agencyContext || !can(agencyContext, "pipelines:agency-rollup-read")) {
    return { kind: "denied" };
  }
  try {
    const [orgLabels, pipelines] = await Promise.all([
      buildOrganizationLabelMap(agencyContext),
      listPipelinesForAgency(agencyContext),
    ]);
    const rows: AgencyPipelineRow[] = pipelines.map((pipeline) => ({
      id: pipeline.id,
      name: pipeline.name,
      organizationLabel: resolveOrganizationLabel(orgLabels, pipeline.organizationId),
    }));
    return { kind: "ready", rows };
  } catch {
    return { kind: "error" };
  }
}
