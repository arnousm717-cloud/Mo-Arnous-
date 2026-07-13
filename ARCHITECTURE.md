# AI Revenue OS — Architecture (superseded by `docs/`)

This file was the original planning snapshot from the first working session on this project. **It has been fully superseded by the numbered documentation set in `docs/`** and is kept only so old links don't 404 — do not read it for current architecture, and do not cite it from new work.

Everything it contained now lives, in far greater and more current detail, here:

| Topic | Current source of truth |
|---|---|
| Vision, GTM, competitive positioning, North Star Metric | [`docs/01-Vision.md`](docs/01-Vision.md) |
| System/application/modular architecture, ADRs, tech decisions | [`docs/02-Software-Architecture.md`](docs/02-Software-Architecture.md) |
| Database schema, ERD, RLS, multi-tenancy | [`docs/03-Database-Architecture.md`](docs/03-Database-Architecture.md) |
| REST API design, auth, webhooks | [`docs/04-API-Architecture.md`](docs/04-API-Architecture.md) |
| AI agent personas, tool layer, approval gating | [`docs/05-AI-Agent-Architecture.md`](docs/05-AI-Agent-Architecture.md) |
| n8n workflow catalog | [`docs/06-n8n-Workflow-Architecture.md`](docs/06-n8n-Workflow-Architecture.md) |
| Design system | [`docs/07-UI-UX-System.md`](docs/07-UI-UX-System.md) |
| Security, GDPR, encryption, DR | [`docs/08-Security.md`](docs/08-Security.md) |
| Phased development roadmap | [`docs/09-Development-Roadmap.md`](docs/09-Development-Roadmap.md) |
| Engineering rules for implementation | [`docs/10-CLAUDE.md`](docs/10-CLAUDE.md) |
| AI Revenue Brain (shared intelligence layer) | [`docs/11-AI-Revenue-Brain.md`](docs/11-AI-Revenue-Brain.md) |

**Why this file couldn't just be updated instead of retired**: its own roadmap used a different phase numbering (Phase 0-8, with different content per phase) than `docs/09`'s current Phase 1-8 structure, and it predated the AI Revenue Brain, the two-tier deletion model, and several other decisions that materially changed the architecture. Maintaining two documents that describe the same system is how they silently drift apart — which is exactly what had already started happening here. One numbered set, one source of truth.
