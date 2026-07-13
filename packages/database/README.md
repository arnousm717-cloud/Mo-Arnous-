# packages/database

Supabase schema, migrations, and generated types (`03-Database-Architecture.md`). Wraps the Supabase CLI rather than a hand-written `docker-compose.yml` — `supabase start` already runs Postgres/Auth/Storage locally via Docker, so there is nothing to duplicate.

## Local development

```bash
pnpm --filter @ai-revenue-os/database start   # starts the local Supabase stack (requires Docker running)
pnpm --filter @ai-revenue-os/database stop
```

No migrations exist yet — the first ones (tenancy schema, RLS policies) land in Milestone M1.2.
