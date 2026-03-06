import type { Prisma } from "@prisma/client";

export type TimestampCursor = {
  timestamp: Date;
  id: string;
};

export type PageDirection = "next" | "prev";

export function parseTimestampCursor(value: string | null): TimestampCursor | null {
  if (!value) {
    return null;
  }

  const [timestampRaw, idRaw] = value.split("~");
  if (!timestampRaw || !idRaw) {
    return null;
  }

  const timestamp = new Date(timestampRaw);
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }

  const id = idRaw.trim();
  if (!id) {
    return null;
  }

  return { timestamp, id };
}

export function encodeTimestampCursor(cursor: TimestampCursor): string {
  return `${cursor.timestamp.toISOString()}~${cursor.id}`;
}

export function parsePageDirection(value: string | null): PageDirection {
  return value?.trim().toLowerCase() === "prev" ? "prev" : "next";
}

export function applyTimestampCursor(
  where: Prisma.ClaimWhereInput,
  cursor: TimestampCursor | null,
  direction: PageDirection,
  field: "createdAt" | "updatedAt",
): Prisma.ClaimWhereInput {
  if (!cursor) {
    return where;
  }

  const timestampComparison: Prisma.DateTimeFilter =
    direction === "prev" ? { gt: cursor.timestamp } : { lt: cursor.timestamp };
  const idComparison: Prisma.StringFilter = direction === "prev" ? { gt: cursor.id } : { lt: cursor.id };

  const timestampRangeWhere: Prisma.ClaimWhereInput =
    field === "createdAt"
      ? {
          createdAt: timestampComparison,
        }
      : {
          updatedAt: timestampComparison,
        };

  const timestampTieWhere: Prisma.ClaimWhereInput =
    field === "createdAt"
      ? {
          createdAt: cursor.timestamp,
        }
      : {
          updatedAt: cursor.timestamp,
        };

  return {
    AND: [
      where,
      {
        OR: [
          timestampRangeWhere,
          {
            AND: [timestampTieWhere, { id: idComparison }],
          },
        ],
      },
    ],
  };
}
