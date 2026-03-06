import type { Prisma } from "@prisma/client";

export const CLAIM_STATUSES = ["NEW", "PROCESSING", "REVIEW_REQUIRED", "READY", "ERROR"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export type ClaimFilters = {
  status: ClaimStatus | null;
  search: string | null;
  createdFrom: Date | null;
  createdTo: Date | null;
};

export function parseClaimFiltersFromRecord(
  searchParams: Record<string, string | string[] | undefined>,
): ClaimFilters {
  return {
    status: normalizeClaimStatus(readSearchParam(searchParams, "status")),
    search: normalizeSearchTerm(readSearchParam(searchParams, "search")),
    createdFrom: parseIsoDate(readSearchParam(searchParams, "created_from")),
    createdTo: parseIsoDate(readSearchParam(searchParams, "created_to")),
  };
}

export function parseClaimFiltersFromUrlSearchParams(searchParams: URLSearchParams): ClaimFilters {
  return {
    status: normalizeClaimStatus(searchParams.get("status")),
    search: normalizeSearchTerm(searchParams.get("search")),
    createdFrom: parseIsoDate(searchParams.get("created_from")),
    createdTo: parseIsoDate(searchParams.get("created_to")),
  };
}

export function buildClaimWhereInput(
  organizationId: string,
  filters: ClaimFilters,
): Prisma.ClaimWhereInput {
  const whereClause: Prisma.ClaimWhereInput = {
    organizationId,
  };

  if (filters.status) {
    whereClause.status = filters.status;
  }

  if (filters.createdFrom || filters.createdTo) {
    whereClause.createdAt = {
      gte: filters.createdFrom ?? undefined,
      lt: filters.createdTo
        ? new Date(filters.createdTo.getTime() + 24 * 60 * 60 * 1000)
        : undefined,
    };
  }

  if (filters.search) {
    whereClause.OR = [
      {
        externalClaimId: {
          contains: filters.search,
          mode: "insensitive",
        },
      },
      {
        customerName: {
          contains: filters.search,
          mode: "insensitive",
        },
      },
      {
        productName: {
          contains: filters.search,
          mode: "insensitive",
        },
      },
      {
        issueSummary: {
          contains: filters.search,
          mode: "insensitive",
        },
      },
      {
        sourceEmail: {
          contains: filters.search,
          mode: "insensitive",
        },
      },
    ];
  }

  return whereClause;
}

export function serializeFiltersToQueryParams(filters: ClaimFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search) {
    params.set("search", filters.search);
  }

  if (filters.status) {
    params.set("status", filters.status);
  }

  if (filters.createdFrom) {
    params.set("created_from", formatDateInput(filters.createdFrom));
  }

  if (filters.createdTo) {
    params.set("created_to", formatDateInput(filters.createdTo));
  }

  return params;
}

export function clampLimit(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

export function formatDateInput(value: Date | null): string {
  if (!value) {
    return "";
  }

  return value.toISOString().slice(0, 10);
}

export function readSearchParam(
  searchParams: Record<string, string | string[] | undefined>,
  key: string,
): string | null {
  const value = searchParams[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    const trimmed = value[0].trim();
    return trimmed ? trimmed : null;
  }

  return null;
}

function normalizeSearchTerm(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, 120);
}

function normalizeClaimStatus(value: string | null): ClaimStatus | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  if (
    normalized === "NEW" ||
    normalized === "PROCESSING" ||
    normalized === "REVIEW_REQUIRED" ||
    normalized === "READY" ||
    normalized === "ERROR"
  ) {
    return normalized;
  }

  return null;
}

function parseIsoDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return null;
  }

  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
