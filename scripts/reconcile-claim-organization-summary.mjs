import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const dryRun = process.argv.includes("--dry-run");

try {
  const rows = await prisma.$queryRaw`
    WITH canonical AS (
      SELECT
        "organizationId",
        COUNT(*)::int AS "totalClaims",
        COUNT(*) FILTER (WHERE status = 'NEW')::int AS "newCount",
        COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS "processingCount",
        COUNT(*) FILTER (WHERE status = 'REVIEW_REQUIRED')::int AS "reviewRequiredCount",
        COUNT(*) FILTER (WHERE status = 'READY')::int AS "readyCount",
        COUNT(*) FILTER (WHERE status = 'ERROR')::int AS "errorCount"
      FROM "Claim"
      GROUP BY "organizationId"
    )
    SELECT
      canonical.*,
      summary."totalClaims" AS "summaryTotalClaims",
      summary."newCount" AS "summaryNewCount",
      summary."processingCount" AS "summaryProcessingCount",
      summary."reviewRequiredCount" AS "summaryReviewRequiredCount",
      summary."readyCount" AS "summaryReadyCount",
      summary."errorCount" AS "summaryErrorCount"
    FROM canonical
    LEFT JOIN "ClaimOrganizationSummary" summary
      ON summary."organizationId" = canonical."organizationId"
    WHERE
      summary."organizationId" IS NULL
      OR summary."totalClaims" <> canonical."totalClaims"
      OR summary."newCount" <> canonical."newCount"
      OR summary."processingCount" <> canonical."processingCount"
      OR summary."reviewRequiredCount" <> canonical."reviewRequiredCount"
      OR summary."readyCount" <> canonical."readyCount"
      OR summary."errorCount" <> canonical."errorCount"
    ORDER BY canonical."organizationId"
  `;

  if (!dryRun && rows.length > 0) {
    for (const row of rows) {
      await prisma.$executeRaw(
        Prisma.sql`
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
            ${row.organizationId},
            ${row.totalClaims},
            ${row.newCount},
            ${row.processingCount},
            ${row.reviewRequiredCount},
            ${row.readyCount},
            ${row.errorCount}
          )
          ON CONFLICT ("organizationId") DO UPDATE SET
            "totalClaims" = EXCLUDED."totalClaims",
            "newCount" = EXCLUDED."newCount",
            "processingCount" = EXCLUDED."processingCount",
            "reviewRequiredCount" = EXCLUDED."reviewRequiredCount",
            "readyCount" = EXCLUDED."readyCount",
            "errorCount" = EXCLUDED."errorCount",
            "updatedAt" = CURRENT_TIMESTAMP
        `,
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        driftedOrganizationCount: rows.length,
        driftedOrganizations: rows,
        reconciledOrganizationCount: dryRun ? 0 : rows.length,
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
