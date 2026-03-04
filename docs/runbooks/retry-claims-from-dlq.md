# ClaimFlow Runbook: Retry Failed Claims from DLQ

## Purpose

Use this runbook when claim ingest jobs fail repeatedly and are moved to the dead-letter queue (DLQ).

## Prerequisites

- AWS CLI is configured (`aws sts get-caller-identity` succeeds).
- `jq` is installed (required for the CLI redrive loop in step 3B).
- You know the queue URLs in `.env`:
  - `CLAIMS_INGEST_QUEUE_URL`
  - `CLAIMS_INGEST_DLQ_URL`
- Region is set (`AWS_REGION`, for example `us-west-2`).

## 1. Inspect DLQ Depth

```bash
aws sqs get-queue-attributes \
  --queue-url "$CLAIMS_INGEST_DLQ_URL" \
  --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
  --region "$AWS_REGION"
```

If both values are `0`, there is nothing to retry.

## 2. Pull a Sample Message and Identify Failure Reason

```bash
aws sqs receive-message \
  --queue-url "$CLAIMS_INGEST_DLQ_URL" \
  --max-number-of-messages 1 \
  --message-attribute-names All \
  --region "$AWS_REGION"
```

The body contains:

- `reason`: processing failure reason
- `retryable`: whether worker considered it retryable
- `queueMessage`: original claim ingest payload (`claimId`, `organizationId`, `inboundMessageId`)

Fix the underlying issue first (for example missing env var, AWS permission issue, service outage).

## 3. Requeue Messages from DLQ to Main Queue

### Option A: Redrive with AWS Console (recommended)

1. Open SQS -> DLQ -> **Start DLQ redrive**.
2. Select destination queue = `CLAIMS_INGEST_QUEUE_URL`.
3. Choose message count and start.

### Option B: Redrive via CLI (single message loop)

```bash
while true; do
  message_json=$(aws sqs receive-message \
    --queue-url "$CLAIMS_INGEST_DLQ_URL" \
    --max-number-of-messages 1 \
    --visibility-timeout 30 \
    --wait-time-seconds 1 \
    --region "$AWS_REGION")

  body=$(echo "$message_json" | jq -r '.Messages[0].Body // empty')
  receipt=$(echo "$message_json" | jq -r '.Messages[0].ReceiptHandle // empty')

  if [ -z "$body" ] || [ -z "$receipt" ]; then
    break
  fi

  original=$(echo "$body" | jq -c '.queueMessage')

  aws sqs send-message \
    --queue-url "$CLAIMS_INGEST_QUEUE_URL" \
    --message-body "$original" \
    --region "$AWS_REGION" >/dev/null

  aws sqs delete-message \
    --queue-url "$CLAIMS_INGEST_DLQ_URL" \
    --receipt-handle "$receipt" \
    --region "$AWS_REGION" >/dev/null

done
```

## 4. Verify Recovery

- Check worker logs for `claim_ingest_processed` events.
- Confirm claim status changes from `ERROR/PROCESSING` to `REVIEW_REQUIRED` or `READY` in dashboard.
- Re-check DLQ depth (step 1) until near zero.

## 5. Optional API Triage View

You can fetch organization-scoped error claims plus latest worker failure metadata:

```bash
curl -sS \
  -H "cookie: claimflow_session=<your_session_cookie>" \
  "http://localhost:3000/api/claims/errors?limit=50&search=&created_from=&created_to="
```

Notes:

- Requires an authenticated session with `ADMIN` or `OWNER` role.
- Response includes `failure.reason`, `failure.retryable`, `failure.receiveCount`, and `failure.failureDisposition` when available.

## 6. Escalation Criteria

Escalate if any of these are true:

- DLQ keeps growing after redrive.
- More than 10% of redriven messages fail again.
- Failures involve data corruption or cross-organization claim mismatches.
