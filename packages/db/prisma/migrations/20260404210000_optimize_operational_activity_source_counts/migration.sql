CREATE INDEX IF NOT EXISTS "ClaimEvent_operational_activity_org_created_source_idx"
  ON "ClaimEvent" ("organizationId", "createdAt", ((payload->>'source')))
  WHERE "eventType" = 'STATUS_TRANSITION'
    AND (payload->>'source') IN (
      'watchdog_processing_recovery',
      'manual_processing_recovery',
      'manual_retry'
    );
