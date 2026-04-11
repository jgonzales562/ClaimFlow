CREATE TABLE "ClaimOrganizationSummary" (
  "organizationId" TEXT NOT NULL,
  "totalClaims" INTEGER NOT NULL DEFAULT 0,
  "newCount" INTEGER NOT NULL DEFAULT 0,
  "processingCount" INTEGER NOT NULL DEFAULT 0,
  "reviewRequiredCount" INTEGER NOT NULL DEFAULT 0,
  "readyCount" INTEGER NOT NULL DEFAULT 0,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ClaimOrganizationSummary_pkey" PRIMARY KEY ("organizationId"),
  CONSTRAINT "ClaimOrganizationSummary_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "ClaimOrganizationSummary" (
  "organizationId",
  "totalClaims",
  "newCount",
  "processingCount",
  "reviewRequiredCount",
  "readyCount",
  "errorCount"
)
SELECT
  c."organizationId",
  COUNT(*)::int AS "totalClaims",
  COUNT(*) FILTER (WHERE c.status = 'NEW')::int AS "newCount",
  COUNT(*) FILTER (WHERE c.status = 'PROCESSING')::int AS "processingCount",
  COUNT(*) FILTER (WHERE c.status = 'REVIEW_REQUIRED')::int AS "reviewRequiredCount",
  COUNT(*) FILTER (WHERE c.status = 'READY')::int AS "readyCount",
  COUNT(*) FILTER (WHERE c.status = 'ERROR')::int AS "errorCount"
FROM "Claim" c
GROUP BY c."organizationId";

CREATE OR REPLACE FUNCTION "claimflow_increment_claim_organization_summary"(
  target_organization_id TEXT,
  target_status "ClaimStatus"
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "ClaimOrganizationSummary" (
    "organizationId",
    "totalClaims",
    "newCount",
    "processingCount",
    "reviewRequiredCount",
    "readyCount",
    "errorCount"
  )
  VALUES (
    target_organization_id,
    1,
    CASE WHEN target_status = 'NEW' THEN 1 ELSE 0 END,
    CASE WHEN target_status = 'PROCESSING' THEN 1 ELSE 0 END,
    CASE WHEN target_status = 'REVIEW_REQUIRED' THEN 1 ELSE 0 END,
    CASE WHEN target_status = 'READY' THEN 1 ELSE 0 END,
    CASE WHEN target_status = 'ERROR' THEN 1 ELSE 0 END
  )
  ON CONFLICT ("organizationId") DO UPDATE
  SET
    "totalClaims" = "ClaimOrganizationSummary"."totalClaims" + 1,
    "newCount" =
      "ClaimOrganizationSummary"."newCount" + CASE WHEN target_status = 'NEW' THEN 1 ELSE 0 END,
    "processingCount" =
      "ClaimOrganizationSummary"."processingCount" + CASE WHEN target_status = 'PROCESSING' THEN 1 ELSE 0 END,
    "reviewRequiredCount" =
      "ClaimOrganizationSummary"."reviewRequiredCount" + CASE WHEN target_status = 'REVIEW_REQUIRED' THEN 1 ELSE 0 END,
    "readyCount" =
      "ClaimOrganizationSummary"."readyCount" + CASE WHEN target_status = 'READY' THEN 1 ELSE 0 END,
    "errorCount" =
      "ClaimOrganizationSummary"."errorCount" + CASE WHEN target_status = 'ERROR' THEN 1 ELSE 0 END,
    "updatedAt" = CURRENT_TIMESTAMP;
END;
$$;

CREATE OR REPLACE FUNCTION "claimflow_decrement_claim_organization_summary"(
  target_organization_id TEXT,
  target_status "ClaimStatus"
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "ClaimOrganizationSummary"
  SET
    "totalClaims" = "totalClaims" - 1,
    "newCount" = "newCount" - CASE WHEN target_status = 'NEW' THEN 1 ELSE 0 END,
    "processingCount" = "processingCount" - CASE WHEN target_status = 'PROCESSING' THEN 1 ELSE 0 END,
    "reviewRequiredCount" = "reviewRequiredCount" - CASE WHEN target_status = 'REVIEW_REQUIRED' THEN 1 ELSE 0 END,
    "readyCount" = "readyCount" - CASE WHEN target_status = 'READY' THEN 1 ELSE 0 END,
    "errorCount" = "errorCount" - CASE WHEN target_status = 'ERROR' THEN 1 ELSE 0 END,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "organizationId" = target_organization_id;

  DELETE FROM "ClaimOrganizationSummary"
  WHERE "organizationId" = target_organization_id
    AND "totalClaims" <= 0;
END;
$$;

CREATE OR REPLACE FUNCTION "claimflow_transition_claim_organization_summary"(
  target_organization_id TEXT,
  previous_status "ClaimStatus",
  next_status "ClaimStatus"
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF previous_status = next_status THEN
    RETURN;
  END IF;

  UPDATE "ClaimOrganizationSummary"
  SET
    "newCount" =
      "newCount"
      + CASE WHEN next_status = 'NEW' THEN 1 ELSE 0 END
      - CASE WHEN previous_status = 'NEW' THEN 1 ELSE 0 END,
    "processingCount" =
      "processingCount"
      + CASE WHEN next_status = 'PROCESSING' THEN 1 ELSE 0 END
      - CASE WHEN previous_status = 'PROCESSING' THEN 1 ELSE 0 END,
    "reviewRequiredCount" =
      "reviewRequiredCount"
      + CASE WHEN next_status = 'REVIEW_REQUIRED' THEN 1 ELSE 0 END
      - CASE WHEN previous_status = 'REVIEW_REQUIRED' THEN 1 ELSE 0 END,
    "readyCount" =
      "readyCount"
      + CASE WHEN next_status = 'READY' THEN 1 ELSE 0 END
      - CASE WHEN previous_status = 'READY' THEN 1 ELSE 0 END,
    "errorCount" =
      "errorCount"
      + CASE WHEN next_status = 'ERROR' THEN 1 ELSE 0 END
      - CASE WHEN previous_status = 'ERROR' THEN 1 ELSE 0 END,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "organizationId" = target_organization_id;
END;
$$;

CREATE OR REPLACE FUNCTION "claimflow_sync_claim_organization_summary"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM "claimflow_increment_claim_organization_summary"(NEW."organizationId", NEW.status);
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM "claimflow_decrement_claim_organization_summary"(OLD."organizationId", OLD.status);
    RETURN OLD;
  END IF;

  IF NEW."organizationId" <> OLD."organizationId" THEN
    PERFORM "claimflow_decrement_claim_organization_summary"(OLD."organizationId", OLD.status);
    PERFORM "claimflow_increment_claim_organization_summary"(NEW."organizationId", NEW.status);
    RETURN NEW;
  END IF;

  IF NEW.status <> OLD.status THEN
    PERFORM "claimflow_transition_claim_organization_summary"(
      NEW."organizationId",
      OLD.status,
      NEW.status
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "Claim_sync_claim_organization_summary"
AFTER INSERT OR DELETE OR UPDATE OF "organizationId", status ON "Claim"
FOR EACH ROW
EXECUTE FUNCTION "claimflow_sync_claim_organization_summary"();
