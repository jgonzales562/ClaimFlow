export type WorkerFailureEvent = {
  source: "worker_failure";
  occurredAt: string;
  reason: string | null;
  retryable: boolean | null;
  receiveCount: number | null;
  failureDisposition: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  inboundMessageId?: string;
  providerMessageId?: string;
  queueMessageId?: string;
};

export type WorkerFailureSnapshot = {
  latestWorkerFailureAt: Date | null;
  latestWorkerFailureReason: string | null;
  latestWorkerFailureRetryable: boolean | null;
  latestWorkerFailureReceiveCount: number | null;
  latestWorkerFailureDisposition: string | null;
};

export function parseWorkerFailureEvent(payload: unknown, createdAt: Date): WorkerFailureEvent | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  if (record.source !== "worker_failure") {
    return null;
  }

  return {
    source: "worker_failure",
    occurredAt: createdAt.toISOString(),
    reason: typeof record.reason === "string" ? record.reason : null,
    retryable: typeof record.retryable === "boolean" ? record.retryable : null,
    receiveCount: typeof record.receiveCount === "number" ? record.receiveCount : null,
    failureDisposition:
      typeof record.failureDisposition === "string" ? record.failureDisposition : null,
    fromStatus: typeof record.fromStatus === "string" ? record.fromStatus : null,
    toStatus: typeof record.toStatus === "string" ? record.toStatus : null,
    ...(typeof record.inboundMessageId === "string"
      ? { inboundMessageId: record.inboundMessageId }
      : {}),
    ...(typeof record.providerMessageId === "string"
      ? { providerMessageId: record.providerMessageId }
      : {}),
    ...(typeof record.queueMessageId === "string" ? { queueMessageId: record.queueMessageId } : {}),
  };
}

export function readWorkerFailureSnapshot(input: WorkerFailureSnapshot): WorkerFailureEvent | null {
  if (!input.latestWorkerFailureAt) {
    return null;
  }

  return {
    source: "worker_failure",
    occurredAt: input.latestWorkerFailureAt.toISOString(),
    reason: input.latestWorkerFailureReason,
    retryable: input.latestWorkerFailureRetryable,
    receiveCount: input.latestWorkerFailureReceiveCount,
    failureDisposition: input.latestWorkerFailureDisposition,
    fromStatus: "PROCESSING",
    toStatus: "ERROR",
  };
}
