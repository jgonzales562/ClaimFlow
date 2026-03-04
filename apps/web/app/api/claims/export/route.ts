import { prisma } from "@claimflow/db";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getAuthContext, hasMinimumRole } from "@/lib/auth/server";
import {
  buildClaimWhereInput,
  clampLimit,
  parseClaimFiltersFromUrlSearchParams,
} from "@/lib/claims/filters";
import { captureWebException } from "@/lib/observability/sentry";
import { extractErrorMessage, logError, logInfo } from "@/lib/observability/log";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasMinimumRole(auth.role, "VIEWER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const filters = parseClaimFiltersFromUrlSearchParams(request.nextUrl.searchParams);
    const limit = clampLimit(request.nextUrl.searchParams.get("limit"), 1000, 1, 5000);
    const formatRaw = request.nextUrl.searchParams.get("format")?.trim().toLowerCase() ?? "csv";
    const format = formatRaw === "json" ? "json" : formatRaw === "csv" ? "csv" : null;

    if (!format) {
      return NextResponse.json(
        { error: "Invalid format. Use format=csv or format=json." },
        { status: 400 },
      );
    }

    const claims = await prisma.claim.findMany({
      where: buildClaimWhereInput(auth.organizationId, filters),
      orderBy: {
        createdAt: "desc",
      },
      take: limit,
      select: {
        id: true,
        externalClaimId: true,
        sourceEmail: true,
        customerName: true,
        productName: true,
        serialNumber: true,
        purchaseDate: true,
        issueSummary: true,
        retailer: true,
        status: true,
        warrantyStatus: true,
        missingInfo: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    logInfo("claims_export_completed", {
      organizationId: auth.organizationId,
      userId: auth.userId,
      format,
      count: claims.length,
      limit,
      status: filters.status,
      hasSearch: Boolean(filters.search),
      createdFrom: filters.createdFrom?.toISOString() ?? null,
      createdTo: filters.createdTo?.toISOString() ?? null,
    });

    if (format === "json") {
      const payload = {
        exportedAt: new Date().toISOString(),
        format,
        count: claims.length,
        filters: {
          status: filters.status,
          search: filters.search,
          createdFrom: filters.createdFrom?.toISOString().slice(0, 10) ?? null,
          createdTo: filters.createdTo?.toISOString().slice(0, 10) ?? null,
        },
        claims,
      };

      return new NextResponse(JSON.stringify(payload, null, 2), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="claims-export-${buildTimestampToken()}.json"`,
        },
      });
    }

    const csvRows: string[] = [];
    csvRows.push(
      [
        "claim_id",
        "external_claim_id",
        "source_email",
        "customer_name",
        "product_name",
        "serial_number",
        "purchase_date",
        "issue_summary",
        "retailer",
        "status",
        "warranty_status",
        "missing_info",
        "created_at",
        "updated_at",
      ].join(","),
    );

    for (const claim of claims) {
      csvRows.push(
        [
          claim.id,
          claim.externalClaimId,
          claim.sourceEmail,
          claim.customerName,
          claim.productName,
          claim.serialNumber,
          formatDate(claim.purchaseDate),
          claim.issueSummary,
          claim.retailer,
          claim.status,
          claim.warrantyStatus,
          claim.missingInfo.join("|"),
          claim.createdAt.toISOString(),
          claim.updatedAt.toISOString(),
        ]
          .map(csvEscape)
          .join(","),
      );
    }

    return new NextResponse(`${csvRows.join("\n")}\n`, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="claims-export-${buildTimestampToken()}.csv"`,
      },
    });
  } catch (error: unknown) {
    captureWebException(error, {
      route: "/api/claims/export",
      organizationId: auth.organizationId,
      userId: auth.userId,
    });

    logError("claims_export_failed", {
      organizationId: auth.organizationId,
      userId: auth.userId,
      error: extractErrorMessage(error),
    });

    return NextResponse.json({ error: "Unable to export claims" }, { status: 500 });
  }
}

function csvEscape(value: string | null): string {
  if (!value) {
    return "";
  }

  const escaped = value.replace(/"/g, '""');
  return /[",\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

function formatDate(value: Date | null): string {
  if (!value) {
    return "";
  }

  return value.toISOString().slice(0, 10);
}

function buildTimestampToken(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
