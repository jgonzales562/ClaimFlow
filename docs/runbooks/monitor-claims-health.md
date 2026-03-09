# ClaimFlow Runbook: Monitor Claims Health

## Purpose

Use the claims health endpoint and the scheduled GitHub Actions workflow to detect stalled claim processing before operators notice it manually.

## What Exists in the Repo

- Health endpoint: `GET /api/ops/claims/health`
- Local/scripted checker: `pnpm ops:check-health`
- Scheduled workflow: `.github/workflows/claims-health.yml`

The endpoint returns:

- `200` when health is within threshold
- `503` when stale processing exceeds `CLAIMS_HEALTH_MAX_STALE_PROCESSING_COUNT`
- `401` when the bearer token is missing or invalid

## Required Configuration

Application environment:

- `CLAIMS_HEALTH_BEARER_TOKEN`
- `CLAIMS_HEALTH_MAX_STALE_PROCESSING_COUNT`
- `CLAIMS_PROCESSING_STALE_MINUTES`

GitHub repository secrets for the scheduled workflow:

- `CLAIMS_HEALTHCHECK_URL`
- `CLAIMS_HEALTH_BEARER_TOKEN`

Suggested URL:

```text
https://<your-web-host>/api/ops/claims/health
```

## Local Check

Run the checker directly:

```bash
CLAIMS_HEALTHCHECK_URL="http://localhost:3000/api/ops/claims/health" \
CLAIMS_HEALTH_BEARER_TOKEN="replace-me" \
pnpm ops:check-health
```

Optional timeout override:

```bash
CLAIMS_HEALTHCHECK_TIMEOUT_MS="15000"
```

## Scheduled Check

The workflow runs every 10 minutes and can also be triggered manually from GitHub Actions.

Failure behavior:

- non-`2xx` responses fail the workflow
- degraded health (`503`) fails the workflow
- timeout or transport failures fail the workflow

That gives you a repo-native alert surface through normal GitHub Actions failure notifications.

## Recommended Threshold

Start with:

- `CLAIMS_HEALTH_MAX_STALE_PROCESSING_COUNT="0"`

That means any stalled processing claim is treated as an incident.

If your queue normally tolerates some worker lag, raise the threshold deliberately rather than silently accepting `PROCESSING` buildup.

## Triage

When the health check fails:

1. Open the dashboard and confirm stalled intake on `/dashboard`.
2. Inspect affected claims from the queue or claim detail page.
3. Confirm whether the watchdog is enabled and running.
4. Review worker logs for lease conflicts, retries, watchdog recoveries, or queue failures.
5. If claims have moved to the DLQ, use [retry-claims-from-dlq.md](./retry-claims-from-dlq.md).
