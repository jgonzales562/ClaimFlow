# ClaimFlow Handoff

## Project Snapshot
- Repository: `ClaimFlow`
- Active branch: `main`
- Latest commit: `86b571d` (`feat: implement ingestion pipeline with attachments, queue worker, and extraction`)
- Plan doc: `IMPLEMENTATION_PLAN_V1.md`

## Milestone Status
- Ticket 1: Done (monorepo/tooling baseline).
- Ticket 2: Done (Prisma schema + migrations + seed flow).
- Ticket 3: Done (basic auth/RBAC path in web app).
- Ticket 4: Done (Postmark inbound webhook + idempotency).
- Ticket 5: Done (S3 attachment persistence + metadata).
- Ticket 6: Done (SQS enqueue + worker consumer + DLQ handling).
- Ticket 7: Done (structured extraction service + `ClaimExtraction` persistence).
- Ticket 8: Next (Textract OCR fallback).

## Infrastructure (Dev)
- AWS region: `us-west-2`
- S3 bucket: `claimflow-attachments-dev-754417747596`
- S3 prefix: `claimflow`
- SQS main queue: `claimflow-ingest-dev`
  - URL: `https://us-west-2.queue.amazonaws.com/754417747596/claimflow-ingest-dev`
- SQS DLQ: `claimflow-ingest-dev-dlq`
  - URL: `https://us-west-2.queue.amazonaws.com/754417747596/claimflow-ingest-dev-dlq`
- Main queue redrive policy:
  - Dead-letter target: `claimflow-ingest-dev-dlq`
  - `maxReceiveCount`: `5`

## Database Changes Implemented
- `ClaimAttachment` table and enums:
  - Migration: `20260227021049_add_claim_attachment_storage`
- `ClaimExtraction` table and `ClaimExtractionProvider` enum:
  - Migration: `20260227042625_add_claim_extraction`
- Initial migration folder normalized to timestamp format:
  - `20260225000000_init`

## Runtime Behavior (Current)
- Webhook route:
  - Validates basic auth.
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

## Extraction Behavior (Ticket 7)
- Module: `apps/worker/src/extraction.ts`
- OpenAI structured output path:
  - Uses JSON schema + Zod validation.
  - Returns retryable errors on invalid/empty model output.
- Fallback path:
  - If `OPENAI_API_KEY` is unset, uses local heuristic extraction.
  - Stores provider as `FALLBACK` and lower confidence.

## Environment Setup
Use `.env.example` as source of truth. Never commit `.env`.

Current local status on this machine:
- OpenAI extraction variables have been set in local `.env`:
  - `OPENAI_API_KEY`
  - `OPENAI_MODEL=gpt-4o-mini`
  - `CLAIMS_EXTRACTION_READY_CONFIDENCE=0.85`
  - `CLAIMS_EXTRACTION_MAX_INPUT_CHARS=12000`
- The secret key value is intentionally not stored in this repo/handoff file.
- On the next device, set these same variables manually in `.env` from your secret source.

Important variables for end-to-end:
- `DATABASE_URL`
- `SESSION_SECRET`
- `POSTMARK_WEBHOOK_BASIC_AUTH_USER`
- `POSTMARK_WEBHOOK_BASIC_AUTH_PASS`
- `POSTMARK_DEFAULT_ORG_SLUG`
- `AWS_REGION`
- `ATTACHMENTS_S3_BUCKET`
- `ATTACHMENTS_S3_PREFIX`
- `CLAIMS_INGEST_QUEUE_URL`
- `CLAIMS_INGEST_DLQ_URL`
- `OPENAI_API_KEY` (required for real model extraction; fallback is used when absent)
- `OPENAI_MODEL` (default `gpt-4o-mini`)
- `CLAIMS_EXTRACTION_READY_CONFIDENCE`
- `CLAIMS_EXTRACTION_MAX_INPUT_CHARS`

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

`Read IMPLEMENTATION_PLAN_V1.md and HANDOFF.md, run git status, then continue with Ticket 8 (Textract OCR fallback) using the existing worker pipeline and claim_extractions model.`

## Next Task: Ticket 8 (OCR Fallback with Textract)
Target outcomes:
- Detect low-quality extraction outcomes (low confidence or poor text quality).
- Run AWS Textract for attachments that need OCR.
- Re-run structured extraction using Textract text.
- Persist fallback usage and confidence source in `ClaimExtraction` output/metadata.
- Keep retry/DLQ behavior safe and deterministic.

Suggested implementation shape:
- Add Textract client/service in worker.
- Add text quality gate before final status assignment.
- Update extraction pipeline to support second-pass extraction source.
- Extend `ClaimExtraction.rawOutput` with fields like:
  - `source: "openai_direct" | "textract_fallback"`
  - `fallbackUsed: boolean`
  - `textractDocumentCount`

## Known Non-Blocking Notes
- Next build logs a warning about Next ESLint plugin detection in custom ESLint config.
- Worker logs an SQS endpoint warning about QueueUrl host resolution; functionality is working.
