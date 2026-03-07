# @claimflow/db

Database package for ClaimFlow using Prisma and PostgreSQL.

## Commands

From repo root:

- `pnpm db:local:start`
- `pnpm db:local:stop`
- `pnpm db:local:restart`
- `pnpm db:local:status`
- `pnpm db:generate`
- `pnpm db:migrate:dev`
- `pnpm db:migrate:deploy`
- `pnpm --filter @claimflow/db prisma:migrate:status`
- `pnpm db:seed`

Or directly:

- `pnpm --filter @claimflow/db prisma:generate`
- `pnpm --filter @claimflow/db prisma:migrate:dev`
- `pnpm --filter @claimflow/db prisma:migrate:deploy`
- `pnpm --filter @claimflow/db prisma:migrate:status`
- `pnpm --filter @claimflow/db seed`

## Environment

Set `DATABASE_URL` in your environment (see `.env.example`).

## Notes

- Search optimizations use PostgreSQL `pg_trgm` indexes (created by migrations). Ensure extension creation is allowed in your target database.
- The local Postgres helper manages the repo-owned cluster in `.postgres-data` and reads `DATABASE_URL` from `.env` for the host/port.
- If you run `pnpm db:seed` from a plain shell, make sure `DATABASE_URL` is exported first. One reliable option is `bash -lc 'set -a && source .env && set +a && pnpm db:seed'`.
