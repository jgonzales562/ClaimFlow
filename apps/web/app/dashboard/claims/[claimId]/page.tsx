import { prisma } from "@claimflow/db";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";
import { getAuthContext, hasMinimumRole } from "@/lib/auth/server";
import { transitionClaimStatusAction, updateClaimReviewAction } from "./actions";

type ClaimDetailPageProps = {
  params: Promise<{ claimId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const WARRANTY_STATUSES = ["LIKELY_IN_WARRANTY", "LIKELY_EXPIRED", "UNCLEAR"] as const;

export default async function ClaimDetailPage({ params, searchParams }: ClaimDetailPageProps) {
  const auth = await getAuthContext();
  if (!auth) {
    redirect("/login");
  }

  if (!hasMinimumRole(auth.role, "VIEWER")) {
    redirect("/dashboard?error=forbidden");
  }

  const { claimId } = await params;
  const resolvedSearchParams = (await searchParams) ?? {};
  const notice = mapNotice(readSearchParam(resolvedSearchParams, "notice"));
  const error = mapError(readSearchParam(resolvedSearchParams, "error"));
  const canEdit = hasMinimumRole(auth.role, "ANALYST");

  const claim = await prisma.claim.findFirst({
    where: {
      id: claimId,
      organizationId: auth.organizationId,
    },
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
      warrantyStatus: true,
      missingInfo: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      attachments: {
        orderBy: {
          createdAt: "desc",
        },
        take: 10,
        select: {
          id: true,
          uploadStatus: true,
          originalFilename: true,
          contentType: true,
          byteSize: true,
          createdAt: true,
        },
      },
      extractions: {
        orderBy: {
          createdAt: "desc",
        },
        take: 1,
        select: {
          id: true,
          provider: true,
          model: true,
          confidence: true,
          extraction: true,
          createdAt: true,
        },
      },
    },
  });

  if (!claim) {
    notFound();
  }

  const events = await prisma.claimEvent.findMany({
    where: {
      claimId: claim.id,
      organizationId: auth.organizationId,
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 25,
    select: {
      id: true,
      eventType: true,
      payload: true,
      createdAt: true,
      actorUser: {
        select: {
          email: true,
          fullName: true,
        },
      },
    },
  });

  const latestExtraction = claim.extractions[0] ?? null;

  return (
    <main style={{ maxWidth: 1080, margin: "42px auto", padding: "0 24px 40px" }}>
      <header
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
      >
        <div>
          <p style={{ margin: "0 0 6px" }}>
            <Link href="/dashboard" style={inlineLinkStyle}>
              Back to Dashboard
            </Link>
          </p>
          <h1 style={{ margin: 0 }}>Claim Review</h1>
          <p style={{ margin: "8px 0 0", color: "#495366" }}>
            {claim.externalClaimId ?? claim.id} | Status: {claim.status}
          </p>
        </div>
      </header>

      {notice ? <p style={noticeStyle}>{notice}</p> : null}
      {error ? <p style={errorStyle}>{error}</p> : null}

      <section style={cardStyle}>
        <h2 style={sectionHeadingStyle}>Claim Metadata</h2>
        <div style={metadataGridStyle}>
          <MetadataRow label="Claim ID" value={claim.externalClaimId ?? claim.id} />
          <MetadataRow label="Source Email" value={claim.sourceEmail ?? "-"} />
          <MetadataRow label="Created" value={formatDateTime(claim.createdAt)} />
          <MetadataRow label="Updated" value={formatDateTime(claim.updatedAt)} />
        </div>
      </section>

      <section style={cardStyle}>
        <h2 style={sectionHeadingStyle}>Review and Edit</h2>
        <form action={updateClaimReviewAction} style={{ display: "grid", gap: 10 }}>
          <input type="hidden" name="claimId" value={claim.id} />
          <div style={fieldGridStyle}>
            <Field label="Customer Name">
              <input
                type="text"
                name="customerName"
                defaultValue={claim.customerName ?? ""}
                style={inputStyle}
                disabled={!canEdit}
              />
            </Field>
            <Field label="Product Name">
              <input
                type="text"
                name="productName"
                defaultValue={claim.productName ?? ""}
                style={inputStyle}
                disabled={!canEdit}
              />
            </Field>
            <Field label="Serial Number">
              <input
                type="text"
                name="serialNumber"
                defaultValue={claim.serialNumber ?? ""}
                style={inputStyle}
                disabled={!canEdit}
              />
            </Field>
            <Field label="Purchase Date">
              <input
                type="date"
                name="purchaseDate"
                defaultValue={formatDateIso(claim.purchaseDate)}
                style={inputStyle}
                disabled={!canEdit}
              />
            </Field>
            <Field label="Retailer">
              <input
                type="text"
                name="retailer"
                defaultValue={claim.retailer ?? ""}
                style={inputStyle}
                disabled={!canEdit}
              />
            </Field>
            <Field label="Warranty Status">
              <select
                name="warrantyStatus"
                defaultValue={claim.warrantyStatus}
                style={inputStyle}
                disabled={!canEdit}
              >
                {WARRANTY_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Issue Summary">
            <textarea
              name="issueSummary"
              defaultValue={claim.issueSummary ?? ""}
              rows={5}
              style={textareaStyle}
              disabled={!canEdit}
            />
          </Field>

          <Field label="Missing Info (one per line)">
            <textarea
              name="missingInfo"
              defaultValue={claim.missingInfo.join("\n")}
              rows={4}
              style={textareaStyle}
              disabled={!canEdit}
            />
          </Field>

          <div>
            {canEdit ? (
              <button type="submit" style={primaryButtonStyle}>
                Save Claim Updates
              </button>
            ) : (
              <p style={{ margin: 0, color: "#667084" }}>
                Your role is read-only. Analyst/Admin/Owner is required to edit.
              </p>
            )}
          </div>
        </form>
      </section>

      <section style={cardStyle}>
        <h2 style={sectionHeadingStyle}>Status Transition</h2>
        <p style={{ marginTop: 0, color: "#475467" }}>Current status: {claim.status}</p>

        {canEdit ? (
          <div style={{ display: "flex", gap: 8 }}>
            {claim.status === "REVIEW_REQUIRED" ? (
              <form action={transitionClaimStatusAction}>
                <input type="hidden" name="claimId" value={claim.id} />
                <input type="hidden" name="targetStatus" value="READY" />
                <button type="submit" style={primaryButtonStyle}>
                  Mark as READY
                </button>
              </form>
            ) : null}

            {claim.status === "READY" ? (
              <form action={transitionClaimStatusAction}>
                <input type="hidden" name="claimId" value={claim.id} />
                <input type="hidden" name="targetStatus" value="REVIEW_REQUIRED" />
                <button type="submit" style={secondaryButtonStyle}>
                  Return to REVIEW_REQUIRED
                </button>
              </form>
            ) : null}

            {claim.status !== "REVIEW_REQUIRED" && claim.status !== "READY" ? (
              <p style={{ margin: 0, color: "#667084" }}>
                Transition buttons appear when the claim reaches review-ready states.
              </p>
            ) : null}
          </div>
        ) : (
          <p style={{ margin: 0, color: "#667084" }}>
            Your role is read-only. Analyst/Admin/Owner is required to transition status.
          </p>
        )}
      </section>

      <section style={cardStyle}>
        <h2 style={sectionHeadingStyle}>Latest Extraction Snapshot</h2>
        {latestExtraction ? (
          <div style={{ display: "grid", gap: 6 }}>
            <MetadataRow label="Provider" value={latestExtraction.provider} />
            <MetadataRow label="Model" value={latestExtraction.model} />
            <MetadataRow label="Confidence" value={latestExtraction.confidence.toFixed(2)} />
            <MetadataRow label="Extracted At" value={formatDateTime(latestExtraction.createdAt)} />
            <MetadataRow
              label="Reasoning"
              value={readExtractionReasoning(latestExtraction.extraction) ?? "-"}
            />
          </div>
        ) : (
          <p style={{ margin: 0, color: "#667084" }}>No extraction has been recorded yet.</p>
        )}
      </section>

      <section style={cardStyle}>
        <h2 style={sectionHeadingStyle}>Attachments ({claim.attachments.length})</h2>
        {claim.attachments.length === 0 ? (
          <p style={{ margin: 0, color: "#667084" }}>No attachments stored for this claim.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead style={{ textAlign: "left", background: "#f9fafb" }}>
              <tr>
                <th style={thStyle}>Filename</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Size</th>
                <th style={thStyle}>Uploaded</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {claim.attachments.map((attachment) => (
                <tr key={attachment.id} style={{ borderTop: "1px solid #eef2f6" }}>
                  <td style={tdStyle}>{attachment.originalFilename}</td>
                  <td style={tdStyle}>{attachment.contentType ?? "-"}</td>
                  <td style={tdStyle}>{formatBytes(attachment.byteSize)}</td>
                  <td style={tdStyle}>{formatDateTime(attachment.createdAt)}</td>
                  <td style={tdStyle}>
                    {attachment.uploadStatus === "STORED" ? (
                      <div style={attachmentActionStyle}>
                        {isInlinePreviewable(attachment.contentType) ? (
                          <a
                            href={`/api/claims/${claim.id}/attachments/${attachment.id}/download?disposition=inline`}
                            style={inlineLinkStyle}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View
                          </a>
                        ) : null}
                        <a
                          href={`/api/claims/${claim.id}/attachments/${attachment.id}/download`}
                          style={inlineLinkStyle}
                        >
                          Download
                        </a>
                      </div>
                    ) : (
                      "Unavailable"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={cardStyle}>
        <h2 style={sectionHeadingStyle}>Audit Events</h2>
        {events.length === 0 ? (
          <p style={{ margin: 0, color: "#667084" }}>No audit events yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead style={{ textAlign: "left", background: "#f9fafb" }}>
              <tr>
                <th style={thStyle}>Time</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Actor</th>
                <th style={thStyle}>Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} style={{ borderTop: "1px solid #eef2f6" }}>
                  <td style={tdStyle}>{formatDateTime(event.createdAt)}</td>
                  <td style={tdStyle}>{event.eventType}</td>
                  <td style={tdStyle}>
                    {event.actorUser?.fullName ?? event.actorUser?.email ?? "System"}
                  </td>
                  <td style={tdStyle}>{describeEvent(event.eventType, event.payload)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={fieldLabelStyle}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <p style={{ margin: 0 }}>
      <strong>{label}:</strong> {value}
    </p>
  );
}

function mapNotice(value: string | null): string | null {
  switch (value) {
    case "claim_updated":
      return "Claim updates saved.";
    case "status_updated":
      return "Claim status updated.";
    case "status_unchanged":
      return "Status was already set to that value.";
    case "no_changes":
      return "No claim field changes were detected.";
    default:
      return null;
  }
}

function mapError(value: string | null): string | null {
  switch (value) {
    case "forbidden":
      return "You do not have permission to perform that action.";
    case "invalid_warranty_status":
      return "Warranty status selection is invalid.";
    case "invalid_purchase_date":
      return "Purchase date must be in YYYY-MM-DD format.";
    case "invalid_status_target":
      return "Selected status transition target is invalid.";
    case "invalid_status_transition":
      return "This status transition is not allowed.";
    case "claim_not_found":
      return "Claim not found.";
    default:
      return null;
  }
}

function readSearchParam(
  searchParams: Record<string, string | string[] | undefined>,
  key: string,
): string | null {
  const value = searchParams[key];
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return value[0];
  }

  return null;
}

function readExtractionReasoning(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.reasoning !== "string") {
    return null;
  }

  return record.reasoning;
}

function describeEvent(eventType: string, payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return eventType === "MANUAL_EDIT" ? "Manual claim edits were saved." : "Status updated.";
  }

  const record = payload as Record<string, unknown>;

  if (eventType === "STATUS_TRANSITION") {
    const fromStatus = typeof record.fromStatus === "string" ? record.fromStatus : "unknown";
    const toStatus = typeof record.toStatus === "string" ? record.toStatus : "unknown";
    const source = typeof record.source === "string" ? record.source : null;
    return source ? `${fromStatus} -> ${toStatus} (${source})` : `${fromStatus} -> ${toStatus}`;
  }

  if (eventType === "MANUAL_EDIT") {
    const changedFields = record.changedFields;
    if (Array.isArray(changedFields)) {
      const names = changedFields
        .map((entry) => {
          if (typeof entry !== "object" || entry === null) {
            return null;
          }

          const field = (entry as Record<string, unknown>).field;
          return typeof field === "string" ? field : null;
        })
        .filter((value): value is string => Boolean(value));

      if (names.length > 0) {
        return `Updated fields: ${names.join(", ")}`;
      }
    }

    return "Manual claim edits were saved.";
  }

  return eventType;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateIso(value: Date | null): string {
  if (!value) {
    return "";
  }

  return value.toISOString().slice(0, 10);
}

function formatDateTime(value: Date): string {
  return value.toISOString().replace("T", " ").slice(0, 19);
}

function isInlinePreviewable(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }

  const normalized = contentType.trim().toLowerCase();
  return normalized === "application/pdf" || normalized.startsWith("image/");
}

const cardStyle: CSSProperties = {
  border: "1px solid #e4e7ec",
  borderRadius: 10,
  background: "#fff",
  padding: 16,
  marginTop: 14,
};

const sectionHeadingStyle: CSSProperties = {
  marginTop: 0,
  marginBottom: 12,
  fontSize: 18,
};

const metadataGridStyle: CSSProperties = {
  display: "grid",
  gap: 6,
};

const fieldGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 10,
};

const fieldLabelStyle: CSSProperties = {
  display: "grid",
  gap: 6,
  color: "#344054",
  fontSize: 13,
};

const inputStyle: CSSProperties = {
  border: "1px solid #d0d5dd",
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 14,
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  resize: "vertical",
};

const primaryButtonStyle: CSSProperties = {
  border: "1px solid #0f172a",
  borderRadius: 8,
  background: "#0f172a",
  color: "#fff",
  padding: "8px 12px",
  cursor: "pointer",
  fontWeight: 600,
};

const secondaryButtonStyle: CSSProperties = {
  border: "1px solid #d0d5dd",
  borderRadius: 8,
  background: "#fff",
  color: "#1d2939",
  padding: "8px 12px",
  cursor: "pointer",
};

const inlineLinkStyle: CSSProperties = {
  color: "#155eef",
  textDecoration: "none",
};

const attachmentActionStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
};

const thStyle: CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid #eaecf0",
  fontWeight: 600,
  color: "#344054",
};

const tdStyle: CSSProperties = {
  padding: "10px 12px",
  color: "#1d2939",
};

const noticeStyle: CSSProperties = {
  marginTop: 12,
  background: "#ecfdf3",
  color: "#027a48",
  border: "1px solid #abefc6",
  borderRadius: 8,
  padding: "10px 12px",
};

const errorStyle: CSSProperties = {
  marginTop: 12,
  background: "#fef3f2",
  color: "#b42318",
  border: "1px solid #fecdca",
  borderRadius: 8,
  padding: "10px 12px",
};
