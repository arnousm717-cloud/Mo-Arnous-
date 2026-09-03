import Link from "next/link";
import { redirect } from "next/navigation";
import { resolveRequestContext } from "@ai-revenue-os/auth";
import { getOrganizationById } from "@ai-revenue-os/tenancy";
import { getDealDashboardMetrics, listDeals } from "@ai-revenue-os/crm";
import {
  getLeadScoreDistribution,
  getHighScoreContacts,
  getIdentifiedVisitorMetrics,
} from "@ai-revenue-os/intelligence";
import { logoutAction } from "./actions";
import { canViewDealKpis } from "./kpi-access";
import { buildDealKpiViewModel } from "./kpi-view-model";
import { buildStageOverviewViewModel } from "./stage-overview-view-model";
import { canViewLeadIntelligence } from "./lead-intelligence-access";
import { buildLeadScoreDistributionViewModel } from "./lead-score-distribution-view-model";
import { buildHighScoreContactsViewModel } from "./high-score-contacts-view-model";
import { buildRecentDealsViewModel } from "./recent-deals-view-model";
import styles from "../companies/companies.module.css";
import kpiStyles from "./dashboard.module.css";

/** Milestone 3.5D. Small, server-defined, never browser-controlled. */
const HIGH_SCORE_LIMIT = 5;

/** Milestone 3.5E. Fixed server-side window — never a query param, never
 * client state. No accepted product requirement establishes a different
 * value, so this matches getIdentifiedVisitorMetrics' own default. */
const VISITOR_WINDOW_DAYS = 30;

/** Milestone 3.5F. Small, server-defined, never browser-controlled. No
 * pagination in v1 -- this is a bounded recent list, not a full console. */
const RECENT_DEALS_LIMIT = 5;

/**
 * Milestone 3.5B/3.5C/3.5D/3.5E/3.5F. Replaces the M1.3-era shell's own body with an
 * organization-wide deal KPI row (3.5B) and a read-only Deals by Stage
 * overview (3.5C), both gated by the existing deals:read grant
 * (packages/auth) — never a new dashboard-specific permission. The gate
 * is content-only (see ./kpi-access.ts): this page itself stays reachable
 * by every authenticated user, matching its existing role as the
 * universal landing page and the redirect target every console page's
 * own decideXConsoleAccess falls back to on denial.
 *
 * getDealDashboardMetrics is called in-process, directly, exactly like
 * every other Server Component in this app calls a domain function
 * (ADR-004) — never a browser fetch() to this app's own API — and called
 * exactly ONCE: both the KPI row and the stage overview are pure
 * transforms of that one result, never a second identical domain/database
 * call. A query failure here is not caught: it propagates to ./error.tsx,
 * the same discipline apps/web/app/agency/error.tsx already established,
 * so a technical failure can never masquerade as "0 deals" or "0%".
 *
 * Deals by Stage is deliberately NOT packages/ui's PipelineBoard: that
 * component expects one full deal object per card (a label, an optional
 * moveControl, drag-and-drop-shaped operational semantics) and has no
 * concept of grouping by pipeline at all — /deals/board already renders
 * one pipeline's board at a time via its own pipeline switcher. Forcing
 * aggregate stage counts through it would mean fabricating fake "cards"
 * just to get a number displayed. This section instead uses small,
 * semantic, dashboard-specific markup — an overview, not a second
 * operational board.
 *
 * Milestone 3.5D adds Lead Intelligence (score distribution + high-score
 * contacts), gated by contacts:read (./lead-intelligence-access.ts) --
 * a deliberately different permission than the deals:read gate above,
 * since this section is fundamentally contact data. getLeadScoreDistribution
 * and getHighScoreContacts are two independent M3.5A aggregates (unlike
 * the KPI/stage sections, which share one getDealDashboardMetrics call)
 * so they run via Promise.all rather than being forced into one call —
 * both still called in-process, still uncaught, still propagating any
 * failure to ./error.tsx exactly like every other section on this page.
 *
 * Milestone 3.5E adds Visitor Intelligence, reusing canViewLeadIntelligence
 * (contacts:read) unchanged rather than introducing a near-duplicate
 * helper -- no dedicated "visitors:read" permission exists anywhere in
 * packages/auth/src/permissions.ts, and this section's only output is an
 * organization-wide aggregate count of visitors currently matched to a
 * contact, so contacts:read is the correct, already-established boundary,
 * not a new one. Renders ONLY getIdentifiedVisitorMetrics'
 * identifiedInWindowCount (the true "Identified Visitors — Last N Days"
 * figure -- occurred_at-windowed, per visitor, never per event, never
 * first_seen_at-based). The function's OTHER field, identifiedVisitorCount
 * (an unwindowed, all-time total), is deliberately NOT rendered here: it
 * is a different metric than this sub-phase's own single locked-scope
 * concept, and Phase 5's own instruction ("if only one trustworthy metric
 * exists, render only one... do not make the section larger just for
 * visual balance") is read literally -- adding a second, differently-
 * scoped number under a section titled "Last 30 Days" would risk
 * misrepresenting what either number means.
 *
 * Milestone 3.5F adds Recently Created Deals, reusing canViewDealKpis
 * (deals:read) unchanged -- the same boundary the KPI/stage sections
 * already use -- and listDeals (packages/crm/src/deals.ts) completely
 * unmodified: it already guarantees organization scope, deleted_at
 * exclusion, created_at DESC with a deterministic id DESC tie-break, and
 * a bounded limit, exactly what this section needs. This is deliberately
 * NOT an activity log, stage-history, or revenue-history view -- it is a
 * bounded list ordered by created_at only, reusing the same domain call
 * apps/web/app/deals/board/page.tsx's own precedent already established
 * for Milestone 3.5A/C's "Recent Deals" design decision.
 */
export default async function DashboardPage(): Promise<React.ReactElement> {
  const context = await resolveRequestContext();
  if (!context) {
    redirect("/login");
  }
  if (!context.organizationId || !context.roleKey) {
    // Authenticated but no organization yet — shouldn't normally happen
    // given signup always creates one, but handled explicitly rather than
    // crashing if it ever does (e.g. a future invite-only membership flow).
    return (
      <main className={styles.page}>
        <p>Your account isn&apos;t linked to an organization yet.</p>
      </main>
    );
  }

  const organization = await getOrganizationById({
    userId: context.userId,
    organizationId: context.organizationId,
  });

  const actor = { userId: context.userId, organizationId: context.organizationId, roleKey: context.roleKey };
  const showDealSections = canViewDealKpis(actor);
  const dealMetrics = showDealSections ? await getDealDashboardMetrics(actor) : null;
  const kpi = dealMetrics ? buildDealKpiViewModel(dealMetrics) : null;
  const stageOverview = dealMetrics ? buildStageOverviewViewModel(dealMetrics) : null;

  const showLeadIntelligence = canViewLeadIntelligence(actor);
  const [scoreDistribution, highScoreContacts] = showLeadIntelligence
    ? await Promise.all([getLeadScoreDistribution(actor), getHighScoreContacts(actor, HIGH_SCORE_LIMIT)])
    : [null, null];
  const distributionView = scoreDistribution ? buildLeadScoreDistributionViewModel(scoreDistribution) : null;
  const highScoreContactsView = highScoreContacts ? buildHighScoreContactsViewModel(highScoreContacts) : null;

  // Reuses the same contacts:read gate as Lead Intelligence — see the
  // module doc comment above for why no new permission/helper is needed.
  const showVisitorIntelligence = canViewLeadIntelligence(actor);
  const visitorMetrics = showVisitorIntelligence
    ? await getIdentifiedVisitorMetrics(actor, VISITOR_WINDOW_DAYS)
    : null;

  // Reuses the same deals:read gate as the KPI/stage sections above.
  const recentDeals = showDealSections ? (await listDeals(actor, { limit: RECENT_DEALS_LIMIT })).items : null;
  const recentDealsView = recentDeals ? buildRecentDealsViewModel(recentDeals) : null;

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <h1>Welcome, {organization?.name ?? "there"}</h1>
        <p>Role: {context.roleKey}</p>
      </header>
      <nav>
        <Link href="/companies">Companies</Link>
        {" | "}
        <Link href="/contacts">Contacts</Link>
        {" | "}
        <Link href="/deals">Deals</Link>
        {" | "}
        <Link href="/pipelines">Pipelines</Link>
      </nav>

      {kpi ? (
        <section className={styles.section} aria-labelledby="deal-kpi-heading">
          <h2 id="deal-kpi-heading">Deals overview</h2>
          <dl className={kpiStyles.kpiGrid}>
            <div className={kpiStyles.kpiCard}>
              <dt>Open Deals</dt>
              <dd>{kpi.openDealCount}</dd>
            </div>

            <div className={kpiStyles.kpiCard}>
              <dt>Open Pipeline Value</dt>
              <dd>
                {kpi.openPipelineValueLines.length > 0 ? (
                  <ul className={kpiStyles.currencyList}>
                    {kpi.openPipelineValueLines.map((line) => (
                      <li key={line.currency}>
                        {line.formattedAmount} {line.currency}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className={kpiStyles.emptyValue}>No pipeline value recorded yet.</span>
                )}
                {kpi.nullAmountDisclosure ? <p className={kpiStyles.disclosure}>{kpi.nullAmountDisclosure}</p> : null}
              </dd>
            </div>

            <div className={kpiStyles.kpiCard}>
              <dt>Win Rate</dt>
              <dd>{kpi.winRateLabel}</dd>
            </div>

            <div className={kpiStyles.kpiCard}>
              <dt>Average Open Deal Size</dt>
              <dd>
                {kpi.averageOpenDealSizeLines.length > 0 ? (
                  <ul className={kpiStyles.currencyList}>
                    {kpi.averageOpenDealSizeLines.map((line) => (
                      <li key={line.currency}>
                        {line.formattedAmount} {line.currency}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className={kpiStyles.emptyValue}>No open deal amounts recorded yet.</span>
                )}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      {stageOverview ? (
        <section className={styles.section} aria-labelledby="stage-overview-heading">
          <h2 id="stage-overview-heading">Deals by Stage</h2>
          {stageOverview.pipelineGroups.length === 0 ? (
            <p>No pipeline stages configured.</p>
          ) : (
            stageOverview.pipelineGroups.map((group) => (
              <div key={group.pipelineId} className={kpiStyles.pipelineGroup}>
                <h3 className={kpiStyles.pipelineGroupHeading}>{group.pipelineName}</h3>
                <ul className={kpiStyles.stageChipList}>
                  {group.stages.map((stage) => (
                    <li key={stage.stageId} className={kpiStyles.stageChip}>
                      <span className={kpiStyles.stageChipName}>{stage.stageName}</span>
                      <span className={kpiStyles.stageChipCount}>{stage.dealCount}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      ) : null}

      {distributionView && highScoreContactsView ? (
        <section className={styles.section} aria-labelledby="lead-intelligence-heading">
          <h2 id="lead-intelligence-heading">Lead Intelligence</h2>

          <div className={kpiStyles.pipelineGroup}>
            <h3 className={kpiStyles.pipelineGroupHeading}>Lead Score Distribution</h3>
            {distributionView.isEmpty ? (
              <p>No scored contacts yet.</p>
            ) : (
              <ul className={kpiStyles.stageChipList}>
                {distributionView.grades.map((line) => (
                  <li key={line.grade} className={kpiStyles.stageChip}>
                    <span className={kpiStyles.stageChipName}>{line.grade}</span>
                    <span className={kpiStyles.stageChipCount}>{line.contactCount}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={kpiStyles.pipelineGroup}>
            <h3 className={kpiStyles.pipelineGroupHeading}>High-Score Contacts</h3>
            {highScoreContactsView.length === 0 ? (
              <p>No scored contacts yet.</p>
            ) : (
              <ul className={kpiStyles.contactList}>
                {highScoreContactsView.map((contact) => (
                  <li key={contact.contactId} className={kpiStyles.contactRow}>
                    <span className={kpiStyles.contactName}>{contact.displayName}</span>
                    <span className={kpiStyles.contactEmail}>{contact.email ?? "—"}</span>
                    <span className={kpiStyles.contactScore}>
                      {contact.score} ({contact.grade})
                    </span>
                    <span className={kpiStyles.contactComputedAt}>
                      {new Date(contact.computedAt).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : null}

      {visitorMetrics ? (
        <section className={styles.section} aria-labelledby="visitor-intelligence-heading">
          <h2 id="visitor-intelligence-heading">Visitor Intelligence</h2>
          <dl className={kpiStyles.kpiGrid}>
            <div className={kpiStyles.kpiCard}>
              <dt>Identified Visitors — Last {visitorMetrics.windowDays} Days</dt>
              <dd>{visitorMetrics.identifiedInWindowCount}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      {recentDealsView ? (
        <section className={styles.section} aria-labelledby="recent-deals-heading">
          <h2 id="recent-deals-heading">Recently Created Deals</h2>
          {recentDealsView.length === 0 ? (
            <p>No deals created yet.</p>
          ) : (
            <ul className={kpiStyles.dealList}>
              {recentDealsView.map((deal) => (
                <li key={deal.dealId} className={kpiStyles.dealRow}>
                  <span className={kpiStyles.dealLabel}>{deal.label}</span>
                  <span className={kpiStyles.dealStatus}>{deal.statusLabel}</span>
                  <span className={kpiStyles.dealAmount}>{deal.amountLabel}</span>
                  <span className={kpiStyles.dealCreatedAt}>{deal.createdAtLabel}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <form action={logoutAction}>
        <button type="submit" className={styles.secondaryButton}>
          Log out
        </button>
      </form>
    </main>
  );
}
