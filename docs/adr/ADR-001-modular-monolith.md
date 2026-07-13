# ADR-001: Modular Monolith Over Microservices

**Status**: Accepted
**Context**: `02-Software-Architecture.md` §1

## Decision

AI Revenue OS is built as a single Next.js application (`apps/web`) with strict internal package boundaries (`packages/*`), not as a set of independently deployed microservices.

## Rationale

A solo-founder-paced team cannot absorb the operational overhead of microservices — service discovery, distributed tracing, N deployment pipelines. A modular monolith with enforced package boundaries (`packages/*`, one-directional dependency graph, no cross-package internal imports) gets most of microservices' maintainability benefit — clear ownership, independent testability, replaceable modules — without the ops tax.

The one deliberate service boundary taken is n8n (ADR-002), because provider-facing automation genuinely benefits from a visual, non-redeploy-required workflow layer.

## Consequences

- All domain logic lives in `packages/*`, composed by `apps/web` — never scattered directly into route handlers (`10-CLAUDE.md` §2).
- Scaling is per-deployment (Vercel serverless + Supabase), not per-service.
- Revisit this decision only if team size grows meaningfully beyond solo-founder-plus-AI-assistance pace (`09-Development-Roadmap.md` Phase 8) and a specific package's independent scaling/deployment need becomes concrete, not speculative.
