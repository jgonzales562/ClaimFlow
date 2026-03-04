# ClaimFlow Handoff

## Project Snapshot
- Repository: `ClaimFlow`
- Active branch: `main` (expected)
- Current HEAD: run `git rev-parse --short HEAD` in your clone for exact revision
- Last updated: 2026-03-04
- Plan doc: `IMPLEMENTATION_PLAN_V1.md`

## Milestone Status
- Ticket 1: Done (monorepo/tooling baseline).
- Ticket 2: Done (Prisma schema + migrations + seed flow).
- Ticket 3: Done (basic auth/RBAC path in web app).
- Ticket 4: Done (Postmark inbound webhook + idempotency).
- Ticket 5: Done (S3 attachment persistence + metadata).
- Ticket 6: Done (SQS enqueue + worker consumer + DLQ handling).
- Ticket 7: Done (structured extraction service + `ClaimExtraction` persistence).
- Ticket 8: Done (Textract OCR fallback and extraction source metadata).
- Ticket 9: Done (dashboard list/detail with review workflow).
- Ticket 10: Done (claim export and observability baseline).

## Repository Layout (Current)
- `apps/web`: Next.js app (dashboard + API routes).
- `apps/worker`: queue consumer + extraction pipeline.
- `packages/db`: Prisma schema, migrations, seed, Prisma client package.
- `docs/runbooks`: operational procedures.

## API Surface (Current)
- Auth:
  - `POST /api/auth/login`
  - `POST /api/auth/logout`
- Claims:
  - `GET /api/claims/export`
  - `GET /api/claims/errors`
  - `GET /api/claims/[claimId]/attachments/[attachmentId]/download`
- Inbound:
  - `POST /api/webhooks/postmark/inbound`

## Database Changes Implemented
- `ClaimAttachment` table and enums:
  - Migration: `20260227021049_add_claim_attachment_storage`
- `ClaimExtraction` table and `ClaimExtractionProvider` enum:
  - Migration: `20260227042625_add_claim_extraction`
- Initial migration folder normalized to timestamp format:
  - `20260225000000_init`

## Runtime Behavior (Current)
- Webhook route:
  - Validates HTTP basic auth (`POSTMARK_WEBHOOK_BASIC_AUTH_USER/PASS`).
  - Parses Postmark payload.
  - Resolves org by mailbox hash/fallback slug.
  - Enforces idempotency by `(organizationId, provider, providerMessageId)`.
  - Stores attachments in S3 and metadata in `ClaimAttachment`.
  - Enqueues claim ingest job to SQS.
  - Sets claim to `PROCESSING` when enqueue succeeds.
- Worker:
  - Polls SQS with long polling.
  - Validates message schema.
  - Processes job and writes extraction rows to `ClaimExtraction`.
  - Updates claim fields/status:
    - `READY` when confidence threshold is met and `missingInfo` is empty.
    - otherwise `REVIEW_REQUIRED`.
  - On failures:
    - retries by leaving message in queue.
    - moves to DLQ when non-retryable or receive count threshold is reached.

## Extraction Behavior
- Module: `apps/worker/src/extraction.ts`
- OpenAI structured output path:
  - Uses JSON schema + Zod validation.
  - Returns retryable errors on invalid/empty model output.
- Fallback path:
  - If `OPENAI_API_KEY` is unset, uses local heuristic extraction.
  - Stores provider as `FALLBACK` and lower confidence.

## Environment Setup
Use `.env.example` as source of truth. Never commit `.env`.

Important variables for end-to-end:
- `DATABASE_URL`
- `SESSION_SECRET`
- `POSTMARK_WEBHOOK_BASIC_AUTH_USER`
- `POSTMARK_WEBHOOK_BASIC_AUTH_PASS`
- `POSTMARK_DEFAULT_ORG_SLUG`
- `AWS_REGION`
- `ATTACHMENTS_S3_BUCKET`
- `ATTACHMENTS_S3_PREFIX`
- `ATTACHMENTS_SIGNED_URL_TTL_SECONDS`
- `CLAIMS_INGEST_QUEUE_URL`
- `CLAIMS_INGEST_DLQ_URL`
- `CLAIMS_QUEUE_POLL_WAIT_SECONDS`
- `CLAIMS_QUEUE_MAX_MESSAGES`
- `CLAIMS_QUEUE_MAX_RECEIVE_COUNT`
- `CLAIMS_QUEUE_VISIBILITY_TIMEOUT_SECONDS`
- `CLAIMS_QUEUE_IDLE_DELAY_MS`
- `CLAIMS_QUEUE_ERROR_DELAY_MS`
- `OPENAI_API_KEY` (optional; fallback extraction is used when absent)
- `OPENAI_MODEL`
- `CLAIMS_EXTRACTION_READY_CONFIDENCE`
- `CLAIMS_EXTRACTION_MAX_INPUT_CHARS`
- `CLAIMS_TEXTRACT_FALLBACK_ENABLED`
- `CLAIMS_TEXTRACT_FALLBACK_CONFIDENCE_THRESHOLD`
- `CLAIMS_TEXTRACT_FALLBACK_MISSING_INFO_COUNT`
- `CLAIMS_TEXTRACT_FALLBACK_MIN_INBOUND_CHARS`
- `CLAIMS_TEXTRACT_MAX_ATTACHMENTS`
- `CLAIMS_TEXTRACT_MAX_TEXT_CHARS`
- `SENTRY_DSN`
- `SENTRY_ENVIRONMENT`
- `SENTRY_TRACES_SAMPLE_RATE`

## Bring-Up on Another Device
1. Clone repo and checkout `main`.
2. Run `pnpm install`.
3. Create `.env` from `.env.example` and set values.
4. Run migrations: `pnpm db:migrate:deploy` (or `pnpm db:migrate:dev` for local dev).
5. Start web: `pnpm --filter @claimflow/web dev`.
6. Start worker with env loaded, for example:
   - `set -a; source .env; set +a; pnpm --filter @claimflow/worker start`

## Recommended Codex Bootstrap Prompt (Next Device)
Use this as the first prompt:

`Read IMPLEMENTATION_PLAN_V1.md and HANDOFF.md, run git status, then continue with V1 hardening tasks (tests, monitoring refinements, and operational runbooks).`

## Known Non-Blocking Notes
- Next build logs a warning about Next ESLint plugin detection in custom ESLint config.
- Next build logs Sentry/OpenTelemetry "critical dependency" warnings from upstream packages.
