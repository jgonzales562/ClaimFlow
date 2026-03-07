# ClaimFlow V1 Implementation Plan

## Status Snapshot (2026-03-07)
- This document started as the V1 planning backlog.
- Tickets 1-10 listed below have been implemented in the current repository baseline.
- The repository now also includes post-V1 hardening work that was not in the original backlog.
- The "First 10 Tickets" section is retained for historical traceability.

## Current Baseline (2026-03-07)

Implemented beyond the original first 10 tickets:

- Deterministic validation pipeline for Next.js route types
- DB-backed tests for routes, loaders, worker branches, and status transitions
- Full pipeline smoke tests for success, DLQ failure, and DLQ publish failure paths
- Playwright operator flows for login, review, export, attachments, error triage, retry, and stale-processing recovery
- Manual retry for retryable `ERROR` claims
- Stale `PROCESSING` detection and manual recovery
- Worker watchdog for stale `PROCESSING` claims
- Processing attempt and lease-token protections to stop stale or duplicate workers from winning writes
- Admin operations snapshot endpoint: `/api/claims/operations`
- Bearer-token health endpoint: `/api/ops/claims/health`
- Local PostgreSQL lifecycle helper in `scripts/local-postgres.mjs`

## Current Next-Step Areas

The main remaining work is operational integration rather than baseline feature delivery:

- Wire `/api/ops/claims/health` into real uptime checks and alerting
- Decide whether non-retryable `ERROR` claims need an explicit escalation or resolution workflow
- Add deployment-facing documentation for web, worker, S3, SQS, and watchdog settings
- Add machine-readable metrics export if logs and the current health endpoint are not enough

## 1) V1 Objective
Build a production-usable MVP for warranty claim intake automation:

- Ingest warranty claim emails and attachments
- Extract structured claim data with AI + OCR fallback
- Show claims in a web dashboard
- Support human review, correction, and export

## 2) Locked Tech Stack (V1)
- Web app + API: Next.js (App Router) + TypeScript
- Background workers: Node.js + TypeScript
- Database: PostgreSQL (Neon) + Prisma + Prisma Migrate
- Inbound email: Postmark Inbound Webhook
- File storage: Amazon S3
- Queue: Amazon SQS (+ dead-letter queue)
- Extraction: OpenAI Structured Outputs
- OCR fallback: AWS Textract (for low-quality/image-heavy docs)
- Hosting: Vercel (web/API routes) + AWS (S3, SQS, Textract)
- Observability: Sentry + structured JSON logs

## 3) Initial Repository Structure
```text
claimflow/
  apps/
    web/                      # Next.js app (dashboard + API routes)
    worker/                   # Background processing workers
  packages/
    db/                       # Prisma schema, client, migrations
  docs/
    runbooks/                 # Ops docs (queue failures, reprocessing)
  .github/
    workflows/                # CI (lint, test, build)
```

## 4) Core Data Model (V1)
Main tables:

- `organizations` (workspace/tenant)
- `users`
- `memberships` (org/user role mapping)
- `claims`
- `claim_attachments`
- `claim_extractions` (raw model outputs, confidence, version)
- `claim_events` (audit trail)
- `integration_mailboxes` (Postmark inbound metadata per org)

Minimum claim fields:

- `external_claim_id` (nullable)
- `customer_name`
- `product_name`
- `serial_number`
- `purchase_date`
- `issue_summary`
- `retailer`
- `warranty_status` (`LIKELY_IN_WARRANTY`, `LIKELY_EXPIRED`, `UNCLEAR`)
- `missing_info` (string array)
- `status` (`NEW`, `PROCESSING`, `REVIEW_REQUIRED`, `READY`, `ERROR`)

## 5) System Flow (End-to-End)
1. Warranty email sent to Postmark inbound alias.
2. Postmark webhook hits `apps/web` API route.
3. API persists raw email metadata, stores attachments to S3, creates claim in `NEW`.
4. API enqueues claim ID to SQS.
5. Worker consumes queue message and extracts text.
6. Worker calls OpenAI structured extraction.
7. If extraction confidence is low or text quality poor, worker runs Textract and retries extraction.
8. Worker writes extraction output + confidence + model version to DB.
9. Claim moves to `REVIEW_REQUIRED` or `READY`.
10. User reviews/edits in dashboard and exports CSV/JSON.

## 6) Security and Reliability Baseline
- Per-org data isolation in queries and API authorization
- Role-based access (`OWNER`, `ADMIN`, `ANALYST`, `VIEWER`)
- Audit events for state changes and manual edits
- Idempotency key for inbound webhook processing
- Queue retry policy + DLQ handling
- Signed S3 URLs for attachment access
- PII-safe logging (no full raw documents in logs)

## 7) Milestones
M1: Foundation
- Monorepo scaffolding
- CI, linting, typing, env validation
- Prisma baseline schema + migrations

M2: Ingestion
- Postmark webhook
- S3 attachment persistence
- SQS enqueue

M3: Processing
- Worker consumer
- OpenAI structured extraction
- Textract fallback + confidence handling

M4: Dashboard
- Claims list, details, filters
- Human review/edit
- Export CSV/JSON

M5: Hardening
- Auth + org RBAC
- Sentry + dashboards
- Runbooks and basic load test

Current state:
- M1-M5 are in place for the current MVP baseline.
- Additional post-V1 hardening listed above is also implemented.

## 8) First 10 Tickets (Original Backlog, Now Implemented)

### Ticket 1: Monorepo bootstrap and developer tooling
Scope:
- Set up `pnpm` workspace with `apps/web`, `apps/worker`, and `packages/db`
- Add TypeScript configs, ESLint, Prettier, basic scripts

Acceptance criteria:
- `pnpm install`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` succeed
- CI workflow runs same checks on pull requests

### Ticket 2: Database foundation (Prisma + Neon)
Scope:
- Implement initial Prisma schema for orgs/users/memberships/claims
- Add migration and seed script for local development

Acceptance criteria:
- Local and hosted DB migrations run successfully
- Seed creates one org, one admin user, and sample claim

### Ticket 3: Auth + organization RBAC
Scope:
- Add authentication (email/password or managed provider)
- Enforce org-scoped access in API routes and UI data loading

Acceptance criteria:
- Unauthorized users cannot access claims
- Users only see claims in their organization

### Ticket 4: Postmark inbound webhook endpoint
Scope:
- Create secure inbound endpoint in `apps/web`
- Validate webhook auth and parse inbound payload
- Persist normalized email metadata

Acceptance criteria:
- Test webhook payload creates `NEW` claim
- Duplicate webhook payload is idempotent

### Ticket 5: Attachment storage in S3
Scope:
- Store all inbound attachments in S3 with structured key naming
- Save attachment metadata records in DB

Acceptance criteria:
- Attachments are retrievable with signed URLs
- Metadata links each file to the correct claim

### Ticket 6: Queue plumbing (SQS + DLQ)
Scope:
- Create enqueue operation from webhook handler
- Implement SQS consumer in worker app
- Configure retry + dead-letter queue policy

Acceptance criteria:
- New claims enqueue and are processed by worker
- Failed jobs eventually land in DLQ with reason logged

### Ticket 7: Structured extraction service (OpenAI)
Scope:
- Define Zod/JSON schema for extraction output
- Implement extraction prompt and parser with strict schema validation

Acceptance criteria:
- Worker stores extraction JSON in `claim_extractions`
- Invalid model outputs are rejected and retried safely

### Ticket 8: OCR fallback with Textract
Scope:
- Detect low-quality text extraction cases
- Run Textract and re-attempt structured extraction
- Store confidence source and fallback usage

Acceptance criteria:
- Low-quality PDFs/images produce improved extracted fields
- Claim record indicates fallback path used

### Ticket 9: Dashboard list + claim review screen
Scope:
- Build claims table with filters (`status`, date, search)
- Build claim detail page with editable extracted fields
- Add status transitions (`REVIEW_REQUIRED` -> `READY`)

Acceptance criteria:
- Analyst can review and correct extracted values
- All manual edits generate `claim_events` audit entries

### Ticket 10: Export + observability baseline
Scope:
- Add CSV/JSON export for filtered claims
- Integrate Sentry in web and worker
- Add structured logging and minimal operations runbook

Acceptance criteria:
- Users can export filtered claims from dashboard
- Runtime errors appear in Sentry with trace context
- Runbook exists for retrying failed claims from DLQ

## 9) Definition of Done for V1
- End-to-end flow works with real forwarded emails and attachments
- Extraction results are reviewable and editable before export
- Org-level isolation and RBAC enforced
- Error handling and retry paths documented and tested
- One pilot customer can process claims daily without manual file wrangling

Status:
- This definition of done has been met by the current repository baseline.
