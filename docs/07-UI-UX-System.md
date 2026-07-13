# 07 — UI/UX System

## 1. Design Principles

1. **Data density with clarity.** This is a RevOps tool used for hours a day — favor information-dense tables and dashboards over marketing-site whitespace, but never at the cost of scannability.
2. **Platform-neutral, tenant-expressive.** The base system (this document) is deliberately neutral so that agency white-label branding (logo, primary color, font) can be layered on top without fighting the underlying UI — see §2 theming architecture.
3. **AI output is visually distinct from human/system data — in whatever shape that output takes.** Anything agent-generated (drafts, structured action proposals, living-document briefs, score adjustments) carries a consistent visual marker so users never mistake a draft for a sent message, a proposed change for a committed one, or an agent suggestion for a confirmed fact — see §5 and §10 for the three variants this actually requires, not one shape forced to fit every case.
4. **No dark patterns, no manufactured urgency.** Consistent with the platform's trust positioning (`01-Vision.md` core values) — no fake scarcity, no confirm-shaming on cancel/unsubscribe flows.
5. **Accessible by default, not by retrofit.** WCAG 2.1 AA is the baseline for every component in the system, not an audit pass applied later.
6. **Loading, empty, and error states are designed once, as a system — not improvised per feature.** Every list/table composite (§5) ships with a defined skeleton-loading state, a defined empty state (illustration + copy + primary action, not a blank table), and a defined error-boundary presentation — designed here so every feature inherits the same quality bar instead of reinventing it.
7. **English-only for MVP; the system is not yet designed for i18n.** Given the EU-first market (`01-Vision.md`), this is stated as an explicit, revisited-later scope boundary rather than a silent gap — text-expansion allowance and locale-aware formatting (dates, currency) are a Phase 7+ concern, not built speculatively now.

## 2. Theming Architecture (White-Label Foundation)

- All color, radius, and font values are CSS custom properties (`--primary`, `--radius`, `--font-sans`), consumed by Tailwind config and shadcn/ui components — never hardcoded hex values in component code.
- Three theme layers, resolved in order of specificity:
  1. **Platform default theme** (this document's palette/type) — the fallback for direct (non-agency) customers.
  2. **Agency theme** (`brand_themes` row keyed by `agency_id`) — overrides logo, primary/secondary/accent color, font family. Applied to every organization under that agency by default.
  3. **Organization override** (optional, later phase) — a specific client org can override its inherited agency theme if the agency permits it.
- Theme resolution happens server-side at render time (values injected as CSS variables in the root layout), not via client-side theme-flash-prone JS.
- Dark mode is a separate, orthogonal axis from tenant theming — every tenant theme must define both a light and dark variant of its palette (enforced by the theme editor validating contrast in both modes, not just accepting arbitrary hex input). **When a submitted brand color fails the contrast check**, the editor doesn't hard-block theme creation outright — it offers an automatically-adjusted variant (lightness/darkness corrected for text-contrast compliance, hue preserved) alongside the original, and the agency chooses to accept the adjustment or pick a different color. A hard block with no path forward would otherwise turn a compliance safeguard into an onboarding blocker for agencies with strict brand guidelines.

## 3. Color Palette (Platform Default)

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--background` | `#FFFFFF` | `#0B0E14` | App background |
| `--foreground` | `#0F1420` | `#E6E9F0` | Primary text |
| `--muted` | `#F4F5F7` | `#161B26` | Subtle surfaces, table stripes |
| `--muted-foreground` | `#6B7280` | `#8B93A7` | Secondary text |
| `--primary` | `#3B5BFD` | `#5B7BFF` | Primary actions, links, active nav |
| `--primary-foreground` | `#FFFFFF` | `#0B0E14` | Text on primary surfaces |
| `--secondary` | `#0F1420` | `#1E2433` | Secondary buttons, chips |
| `--accent` | `#0EA5A0` | `#14C8C2` | Highlights, positive/success-adjacent accents (distinct from semantic success) |
| `--destructive` | `#E5484D` | `#F2555A` | Destructive actions, error states |
| `--success` | `#1AA36A` | `#2ECC81` | Won deals, positive deltas |
| `--warning` | `#D68A00` | `#F2A93B` | At-risk deals, pending review states |
| `--border` | `#E5E7EB` | `#242A38` | Dividers, input borders |
| `--ai-surface` | `#F1F0FF` bg / `#5B3DF5` border | `#1A1730` bg / `#8C6FFF` border | Reserved exclusively for AI-generated content surfaces, across all three variants (§5) |
| `--context-band` | `#FFF4D6` bg / `#B8860B` text | `#332B10` bg / `#E0B84D` text | Reserved for the active-org-context indicator (§6) — distinct from every other token so it can never be mistaken for ordinary chrome |

This is the **platform default only** — agency themes override `--primary`/`--secondary`/`--accent` and the logo; `--destructive`, `--success`, `--warning`, `--ai-surface`, and `--context-band` are **not** white-label-overridable, to keep semantic meaning (error/success/AI-generated/active-org-context) consistent across every tenant regardless of branding.

## 4. Typography

- **Font stack**: `Inter` (UI text) as platform default sans-serif; `IBM Plex Mono` for tabular numeric data (deal amounts, scores) where monospaced alignment aids scanning. Agency theme override may replace the sans-serif family; the monospace numeric font is not overridable (data legibility over branding).
- **Type scale** (Tailwind-aligned, 1.25 ratio): `xs` 12px / `sm` 14px / `base` 16px / `lg` 18px / `xl` 20px / `2xl` 24px / `3xl` 30px / `4xl` 36px.
- **Weights used**: 400 (body), 500 (labels, table headers), 600 (section headings), 700 (page titles only — reserved, not used inline to avoid visual noise in dense screens).
- **Line height**: 1.5 for body text, 1.25 for headings, 1.4 for table cell content (denser but still readable at high row counts).

## 5. Components

Built on shadcn/ui primitives (Radix + Tailwind), extended with domain-specific composites:

- **Core primitives** (from shadcn/ui, themed): Button, Input, Select, Dialog, Sheet, Tabs, Table, Badge, Tooltip, Popover, Toast, Command (for the global search/command palette), Skeleton (for the loading-state principle, §1).
- **Domain composites** (built on the primitives):
  - `EntityTable` — the shared table component for contacts/companies/deals lists: sortable columns, inline tag editing, saved views, bulk actions; ships with a defined skeleton-loading state and a defined empty state (§1).
  - `PipelineBoard` — kanban-style deal board, drag-to-change-stage, respects `pipeline_stages.sort_order`.
  - `ScoreBadge` — renders `lead_scores.grade` with the score breakdown available on hover/click, always showing the rules-based vs. agent-adjusted components separately (never a single opaque number).
  - `ConsentIndicator` — small, persistent badge on any contact/visitor record showing current consent status across all five consent types (`marketing_email`, `cookie_tracking`, `data_processing`, and the two higher-sensitivity Brain-related types `email_content_processing`/`meeting_recording_processing`), linking to the full `consent_records` history. The two Brain-related types render with a distinct, more prominent visual treatment than ordinary marketing/cookie consent, reflecting their higher sensitivity (private correspondence, recorded conversations).
  - `ActivityTimeline` — polymorphic timeline for activities/notes on a contact/company/deal detail page.
  - **`AISurfaceCard` — three variants, not one**, all sharing the `--ai-surface` background/border and a persistent "AI-generated" label, but differing in action model to match what kind of agent output they carry (`05-AI-Agent-Architecture.md` §1's `requires_human_approval` distinction maps directly onto which variant applies):
    - **Content variant**: a drafted, editable artifact (an email/message draft). Actions: Accept, Edit, Discard. This is the original, and still the most common, shape.
    - **Structured action variant**: a proposed discrete change with no free-text body to edit — a deal-stage move (`crm.propose_deal_stage_change`), a proposed meeting time (`calendar.propose_meeting`). Actions: Accept, Choose Different (re-opens the proposal with an alternative value, e.g. a different stage or time), Discard. There is no "Edit" action here, because there is no prose to edit.
    - **Living-document variant**: a continuously-updated synthesis rather than a one-time suggestion — the Research Agent's brief (`{summary, fit_signals, risk_signals, suggested_talking_points}`, confidence-tiered). Rendered via the new `ResearchBriefCard` (below), which nests inside this variant. No Accept/Discard actions apply, since nothing is being committed — instead it carries a persistent "AI-synthesized, last updated {date}" label and a confidence-tier indicator per section, consistent with `05-AI-Agent-Architecture.md` §4's requirement to distinguish confirmed data from inference.
  - `ResearchBriefCard` — renders the Research Agent's structured brief inside the living-document `AISurfaceCard` variant: summary, fit signals, risk signals, and suggested talking points as separate labeled sections, each tagged with its confidence tier (confirmed / inferred / low-confidence) rather than presented as uniformly certain.

## 6. Dashboard Layouts

- **App shell**: persistent left sidebar (primary navigation, collapsible), top bar (org/agency switcher, global search/command palette, notifications, user menu), main content area with a consistent page-header pattern (title, primary action button, contextual tabs).
- **Revenue Dashboard**: grid of stat tiles (pipeline value, win rate, avg. deal size, MRR if applicable) at top, trend chart below, breakdown tables (by owner, by stage, by source) beneath — denser, table-first, not a marketing-style single-hero-metric layout.
- **Agency Console**: distinct shell variant — client organization list/grid as the primary surface (not a single org's CRM data), with roll-up metrics per the `agency_rollup_*` views, and a clearly separate "impersonate/enter client org" action to switch context. **Whenever an agency user has switched into a client organization's view, a persistent, unmissable context band (`--context-band` token, §3) spans the top of every page, naming the active organization** — this is the UI-layer counterpart to the backend's per-request org-context resolution (`03-Database-Architecture.md` §5): the backend guarantees a switch takes effect immediately and correctly, and this band guarantees the human looking at the screen always knows which organization's data they're currently acting on, so a wrong-org mistake isn't just prevented at the data layer but made visually implausible at the interface layer too.
- **Customer Portal**: a deliberately reduced shell (no CRM navigation, no internal fields) — proposal status, documents, and a scoped chat entry point only, styled with the organization's inherited theme.

## 7. Navigation

- **Primary nav (sidebar)**: Dashboard, CRM (Contacts/Companies/Deals nested), Intelligence (Visitors/Enrichment/Scoring nested), Agents, Automations, Proposals, Reports, Settings — order fixed, not user-reorderable in v1 to keep support/onboarding predictable.
- **Context switcher**: agency users get an org switcher in the top bar; org-only users don't see it at all (not just disabled — absent, to avoid confusing single-org users with irrelevant chrome).
- **Command palette** (`Cmd+K`): jump to any contact/company/deal by name, or execute common actions (create deal, draft follow-up) without leaving the keyboard — important given the target user (agency ops staff) is a power user, not a casual visitor. **Search is always scoped to the currently active organization** (the same context the top bar's context band displays) — never a broader agency-wide search, even for agency users, unless the user is specifically inside the Agency Console's roll-up views (§6), which use the explicit `agency_rollup_*` read path rather than the command palette's own index. This is stated explicitly to prevent an implementation from accidentally building a cross-tenant search index.
- **Breadcrumbs** used only on nested detail pages (e.g., Company → Contact), not on top-level list pages where they'd add noise without aiding orientation.

## 8. Responsive Design

- **Primary target is desktop/laptop** (this is a RevOps power-user tool, not a mobile-first consumer app) — the design system is built desktop-first, with responsive collapse rather than mobile-first expansion.
- **Breakpoints** (Tailwind defaults): `sm` 640px, `md` 768px, `lg` 1024px, `xl` 1280px, `2xl` 1536px.
- **Below `lg`**: sidebar collapses to an icon rail with flyout labels; `PipelineBoard` degrades from multi-column kanban to a stacked, filterable list.
- **Below `md`**: `EntityTable` degrades to a card-per-row layout (no horizontal scroll-hunting for key fields); the Customer Portal (used by end customers, more likely on mobile) is the one surface explicitly designed mobile-first rather than desktop-first-degraded.
- **Touch targets**: minimum 44×44px on any interactive element reachable below the `md` breakpoint, per WCAG/mobile accessibility guidance, regardless of desktop-first origin.

## 9. Accessibility

- **Baseline**: WCAG 2.1 AA across the platform default theme; the theme editor (agency-configurable colors) validates minimum contrast ratios (4.5:1 text, 3:1 UI components) before allowing a custom theme to be saved, with the auto-adjustment fallback described in §2 — an agency cannot ship an inaccessible white-label theme through the platform's own tooling, and isn't blocked from onboarding by that safeguard either.
- **Keyboard navigation**: every interactive surface (tables, kanban board, command palette, dialogs) fully operable without a mouse; kanban drag-to-change-stage has a keyboard-accessible equivalent (context menu "Move to stage...") rather than being drag-only.
- **Screen reader**: semantic HTML and ARIA roles via Radix primitives (inherited from shadcn/ui); custom composites (`PipelineBoard`, `ScoreBadge`, the three `AISurfaceCard` variants) explicitly tested with a screen reader before shipping, not assumed accessible by virtue of using accessible primitives underneath.
- **Motion**: respects `prefers-reduced-motion` — transitions/animations (toast entrances, kanban drag feedback) degrade to instant state changes when set.
- **Color independence**: status is never conveyed by color alone (`ScoreBadge`, `ConsentIndicator`, deal stage indicators, and the context band all pair color with an icon or label).

## 10. AI Surface Pattern (Cross-Cutting)

Every piece of agent-generated content is visually marked as AI-generated and rendered inside the appropriate `AISurfaceCard` variant (§5) for what it actually is — content, structured action, or living document — regardless of which persona produced it. This is a hard product rule: there is no agent output anywhere in the product that renders outside one of these three variants. What changed from an earlier version of this document is the acknowledgment that "one component, one action set" doesn't survive contact with the different kinds of output `05-AI-Agent-Architecture.md`'s five personas actually produce — the rule now lives at the level of "always visually marked, always variant-appropriate," which is what actually keeps the "AI augments judgment, it doesn't replace accountability" core value (`01-Vision.md`) honest at the interface level, not just in backend logic.
