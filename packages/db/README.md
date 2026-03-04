# @claimflow/db

Database package for ClaimFlow using Prisma and PostgreSQL.

## Commands

From repo root:

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
