# 01 — Vision

> **Reading note**: this document distinguishes what is **true today** (nothing — no code has shipped yet) from what is **roadmap-dependent** (most of the differentiation claims below, which depend on `09-Development-Roadmap.md` Phases 4-5 shipping). Claims are labeled accordingly. A vision document that can't tell the difference between "built" and "planned" doesn't survive diligence.
>
> **Audience note**: this is the **internal strategy version** — it deliberately names its own weaknesses (moat fragility, model-provider commoditization risk, roadmap-dependent claims) because that's what an internal document is for. Do not hand this to an investor or prospect verbatim; a shorter, external-facing derivative should be drafted separately from this one when actually needed, with the self-critique removed and the numbers below replaced by whatever is validated at the time.

## Product Vision

AI Revenue OS is the operating system that runs a B2B company's entire revenue motion — CRM, intelligence, outreach, automation, and reporting — coordinated by AI agents instead of stitched together by a stack of disconnected point tools.

Today, a growing B2B company runs revenue on 6-10 disconnected tools: a CRM, a visitor-identification tool, an enrichment provider, an email sequencer, a LinkedIn automation tool, a proposal tool, a BI dashboard. Each tool holds a partial view of the customer. None of them act — they report, and a human has to stitch the story together and decide what to do next. Ripping out that stack is expensive and risky for a buyer, which is exactly why Go-To-Market (below) leads with an additive wedge, not a rip-and-replace pitch.

AI Revenue OS's ambition is to collapse that stack into one system of record, with AI agents that don't just surface data but act on it — scoring a lead, drafting the follow-up, updating the deal stage, flagging the at-risk account — inside the same platform that holds the data. The category is "Revenue OS" — not "another CRM," not "another automation tool," but the layer that unifies both and adds judgment on top. **This is the destination, reached incrementally across the roadmap phases below — not a description of what exists at Phase 1.**

**(Roadmap-dependent, Phase 4+)** What is meant to make this more than five AI features bolted onto a CRM is the **AI Revenue Brain** (`11-AI-Revenue-Brain.md`): one centralized intelligence layer, shared by every agent persona, continuously learning from CRM data, emails, meetings, website visitors, tasks, knowledge, conversations, customer history, revenue, support, and marketing. Instead of a Sales Agent, a Scoring Agent, and a Support Agent each reconstructing their own partial view of a contact from scratch, they draw on the same living picture. This is the intended core differentiator — see §"Competitive Positioning" for an honest accounting of how defensible it actually is against incumbents already shipping AI today.

## North Star Metric

Everything below is unfalsifiable without a number to check it against. The metric this business is built to move:

**Revenue-influencing actions an organization's team accepts from AI agents per month** (drafted follow-ups sent, score adjustments trusted, research briefs used, proposals generated) — not agent *activity* (runs, tokens, API calls), but agent *output a human actually acted on*. This is the one number that proves the Brain/agent thesis is real and not just impressive-sounding automation nobody uses. It is tracked from the first agent persona shipped (Phase 4) and is the metric that gates further AI investment: if acceptance rate stays low across multiple personas, the fix is prompt/product iteration before more personas are added, not more personas.

**Year 1 wedge-validation metric** (the actual pass/fail bar for continuing past the CRM + Intelligence wedge) — stated as ranges, not false-precision single numbers, since none of this is validated against real market data yet: **roughly 6-12 independent design-partner agencies**, collectively managing **roughly 30-60 client organizations**, with **90-day organization retention meaningfully above typical early-SaaS churn (directionally 70-85%, to be replaced with a real benchmark once available)** and **no single agency representing more than a quarter of active organizations** (channel-concentration ceiling — see Go-To-Market Strategy). Falling short of the low end of this range by the end of Year 1 is the trigger to revisit the agency-channel bet before investing further in Phases 4-8.

## Mission

Give every B2B company — and every agency serving multiple B2B clients — access to a revenue engine that used to require a full RevOps team and six-figure tool budgets, at a fraction of the cost, with routine revenue-operations work increasingly handled by AI under human-approved guardrails.

**Tagline (for decks/one-liners)**: *The Revenue OS that acts, not just reports.*

## Core Values

Durable identity commitments — these are meant to survive a GTM pivot. (The agency-first *strategy* decision, which should not have this same permanence, is stated explicitly in Go-To-Market Strategy instead, with its own revisit trigger.)

1. **Own the outcome, not the activity.** Every feature should move a deal forward or surface a decision, not just log data. If a feature only produces a report nobody acts on, it's not done. This is also why the North Star Metric above tracks *accepted* agent actions, not agent activity volume.
2. **Provider-agnostic by default.** We integrate with providers (email senders, enrichment APIs, LinkedIn, and — critically — AI model providers themselves) — we do not depend on any single one for our core value. Any external provider, including Claude or OpenAI, must be swappable without a platform redesign. This is a direct hedge against foundation-model providers eventually commoditizing pieces of what we build (see Competitive Positioning).
3. **Privacy and trust are product features, not compliance overhead.** GDPR-readiness, consent, and data minimization are sold as trust, not hidden as legal boilerplate. This matters especially because the platform processes third-party personal data (visitors, leads) that never opted into being profiled, and because the AI Revenue Brain is, by design, the single largest aggregation of that data in the platform.
4. **Ship narrow, ship real.** A working wedge beats a broad, half-finished platform. We resist building all 15 modules before any of them are excellent — and we resist letting "operating system" ambition (above) leak into simultaneous work across every module.
5. **AI augments judgment, it doesn't replace accountability — and autonomy is earned, not assumed.** Agents draft, score, and recommend; a human (or an explicit automation rule the human approved) remains accountable for what actually executes, especially for anything customer-facing or compliance-sensitive. Autonomy expands in stages as acceptance-rate data (North Star Metric) earns trust for a given persona and action type — never granted upfront on the assumption the model will get it right.
6. **Trust is a feature: explainable outputs, portable data.** Every AI output traces to the data that produced it — a user can always ask "why did it suggest this" and get a real, sourced answer, not a plausible-sounding one (already a design principle for individual agent personas, `05-AI-Agent-Architecture.md`, elevated here to a company-level commitment). And every customer's data is fully exportable at any time, in a usable format — no lock-in through data hostage-taking. Both halves of this value exist for the same reason: the AI Revenue Brain aggregates more of a customer's data than any single point-solution competitor does, so the response to "you now hold more of our data" has to be "you can see exactly why it reasoned that way, and take all of it back whenever you want" — not a shrug.

## Long-Term Goals

Planning targets, not commitments — the first real checkpoint is the Year 1 wedge-validation metric above. Funding/profitability posture: **to be determined alongside real pricing and design-partner discovery**; these goals are stated independent of that decision and should be revisited once it's made.

- **Year 1**: Prove the core wedge (CRM + Visitor Intelligence + Lead Scoring, Roadmap Phases 1-3) against the wedge-validation metric range above: roughly 6-12 design-partner agencies, roughly 30-60 client organizations, retention meaningfully above typical early-SaaS churn, no single agency over a quarter of concentration.
- **Year 2**: Full AI agent layer live (Sales, Marketing, Research, Scoring, Support) and automation backbone (n8n-powered) mature enough that agencies build their own workflows without engineering support from us. Paired trust milestone: agent acceptance rate (North Star Metric) sustained above a defined floor per persona before any persona's autonomy is expanded, and the AI Revenue Brain's deletion/consent cascade independently verified, not just documented. Directional target: several multiples of Year 1's organization count, refined once Year 1's actual growth rate is observed rather than assumed in advance.
- **Year 3**: Platform-level maturity — public API, marketplace of integrations/workflow templates, SOC2 Type II, first direct enterprise-tier logos alongside the agency channel. This is also the natural point to revisit the solo-founder-paced assumption underlying the entire roadmap to date (`09-Development-Roadmap.md` Phase 8 risk note) — Year 3 goals assume the team has grown, not that one person is still building everything.
- **Beyond**: AI Revenue OS becomes the default system of record that B2B companies and the agencies serving them run revenue through. Getting there requires the moat to be real (see Competitive Positioning) — distribution and vertical depth, not just having built the Brain first.

## Competitive Positioning

| Competitor category | Examples | What they do well | Where AI Revenue OS differentiates | Status |
|---|---|---|---|---|
| Traditional CRM | HubSpot, Salesforce, Pipedrive | Deep pipeline/deal management, ecosystem maturity | Native white-labeling for agencies, which they don't support at all | **Live from Phase 1** |
| Traditional CRM + native AI | **HubSpot (Breeze), Salesforce (Agentforce)** | Ship AI agents over CRM data *today*, with vastly more existing customer data and distribution than we have | Vertical depth for the agency-resale motion neither is built for, plus a unified cross-source context layer (Brain) rather than CRM-data-only agents | **Roadmap, Phase 4-5 — see honest risk note below** |
| Data enrichment / signals | Clay, Apollo, ZoomInfo | Best-in-class enrichment breadth | We treat enrichment as one input into an agent's decision, not the end product a human still has to act on manually | Roadmap, Phase 3-4 |
| Outbound automation | Outreach, Instantly, lemlist | Strong sequencing engines | Sequencing fused with CRM state and agent judgment instead of running blind | Roadmap, Phase 5 |
| Workflow/automation | Zapier, Make, n8n (self-hosted) | Flexible, general-purpose automation | Pre-built RevOps-specific workflows so agencies don't build automation from scratch | Roadmap, Phase 5 |
| Vertical AI SDRs | 11x, Artisan | AI-first outbound | Broader than outbound — CRM + intelligence + automation + portal in one system, explicitly built for agency resale | Roadmap, Phase 4-6 |

**Honest risk note on the row that matters most**: HubSpot and Salesforce are not hypothetical future competitors — they ship AI agents over CRM data today, with orders of magnitude more customer data and distribution than this platform will have for years. Claiming to "out-AI" them on raw model capability would be a losing argument. The actual bet is narrower and more defensible: (1) **vertical depth for the agency-resale motion**, which neither incumbent is built for (they sell to the end customer directly, not through a white-labeled channel); (2) **a context layer that spans sources incumbents keep siloed** (email, meetings, support, not just their own CRM data) — though this advantage compresses if either incumbent decides to build the same connectors, which they have the resources to do; and (3) **agency-channel distribution** as the actual moat candidate, since it doesn't require winning a feature race, it requires being the platform an agency's existing client relationships run through.

**Model-provider commoditization risk**: the Brain's core mechanism (retrieval-augmented shared context) is not proprietary technology — Anthropic or OpenAI could ship an equivalent "unified memory" primitive natively within the model layer itself, which would erode this differentiator faster than any CRM competitor could copy it. Value #2 (provider-agnostic by default) is the direct hedge: if a foundation-model provider commoditizes the retrieval layer, the response is to consume that primitive rather than compete with it, and re-center the moat on vertical workflow depth and agency distribution, which are harder to commoditize from the model layer down.

**Positioning statement**: *For agencies and B2B companies drowning in a fragmented revenue tool stack, AI Revenue OS is the AI-native Revenue Operating System that unifies CRM, intelligence, and automation under one roof — and unlike HubSpot or Salesforce, it's built from day one to be resold under an agency's own brand, for teams who'd rather run one system than referee six.*

## Target Customers

**Primary beachhead (v1 GTM)**: small-to-mid-sized **B2B-focused growth/RevOps agencies** — target profile: **5-30 person agencies managing 5-25 B2B clients each**, currently running their clients on a stitched-together stack of HubSpot/Pipedrive + Clay/Apollo + Instantly/lemlist, who want to:
- Offer a branded "revenue platform" to their clients instead of assembling and maintaining client stacks manually
- Differentiate their retainer with proprietary-feeling AI capabilities instead of reselling the same point tools every competitor agency also resells
- Manage many client organizations from one place (roll-up reporting, templated onboarding)

**Buyer persona**: the agency founder, COO, or head of operations — the person accountable for retainer margin and client retention, not an individual account manager.

**Geography**: **EU-first**, consistent with the platform's GDPR-by-design hosting decision (`08-Security.md`) — EU-based agencies and their (largely EU) client base are the initial target market, with expansion to other regions a later-phase decision, not a day-one assumption.

**Secondary (direct, later phases)**: mid-market B2B companies (20-500 employees) with an existing but fragmented revenue stack, who want to consolidate and reduce tool sprawl — pursued only once the agency channel validates the product (Year 3+, per Long-Term Goals).

**Not targeting initially**: large enterprises requiring SOC2/SSO from day one (explicitly deferred per architecture decisions); solo-founder/pre-revenue startups with no consistent revenue motion yet; agencies below the ~5-client threshold, where per-organization pricing doesn't yet clear a viable unit economics bar for either side.

## Go-To-Market Strategy

1. **Channel-led, not direct-led, in Phase 1 — and here's why over PLG specifically**: a self-serve motion would require winning each end-customer's trust from zero, in a category (RevOps tooling) where trust is earned slowly. Recruiting design-partner agencies buys distribution through relationships that already exist. Self-serve is explicitly **not now** — the trigger to reconsider it is the agency channel plateauing below the Year 2 organization target despite the wedge validating in Year 1.
2. **White-label as the wedge feature for agency acquisition.** The pitch to an agency isn't "use our tool" — it's "resell your own branded revenue platform, we run the infrastructure."
3. **Land with the CRM + Intelligence wedge, expand into automation and AI agents.** Agencies onboard client orgs on the core wedge (Roadmap Phases 1-3), then upsell their own clients on AI agents and automation as those mature — a natural expansion motion without us having to sell each feature separately.
4. **Pricing** (directional, pending real design-partner pricing discovery — not yet validated): per-organization SaaS pricing to the agency, in the range agencies already budget per client for the point tools being replaced, with the agency setting their own end-client pricing on top. We do not compete with the agency for the end-customer relationship — a policy with real consequences already reflected in the two-level tenancy model (`03-Database-Architecture.md`).
5. **Channel-concentration mitigation**: no single design-partner agency should represent more than roughly a quarter of active client organizations during Year 1 (per the wedge-validation metric range) — over-indexing on one agency's continued participation is a single point of failure for early revenue, and is tracked explicitly, not left as an implicit risk.
6. **Content and proof-of-concept driven for direct mid-market customers** once the agency channel validates the product (Phase 6+), using case studies generated from agency deployments.
7. **Open question, deliberately not designed yet**: the agency/end-client conflict scenario (an agency's client wants to leave the agency relationship but keep the platform) is a real dynamic this business model will eventually hit. It is not solved here — it is flagged as a contract-design question to resolve before it happens in practice, not after.
