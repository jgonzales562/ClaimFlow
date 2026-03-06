import { prisma } from "@claimflow/db";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { isInlinePreviewableAttachment } from "@/lib/attachments";
import { getCachedAuthContext, hasMinimumRole } from "@/lib/auth/server";
import { formatUtcDateTime } from "@/lib/format";
import { formatDateInput, readSearchParam } from "@/lib/claims/filters";
import { cx, formatTokenLabel, getClaimStatusTone, getWarrantyTone } from "@/lib/ui";
import { transitionClaimStatusAction, updateClaimReviewAction } from "./actions";

type ClaimDetailPageProps = {
  params: Promise<{ claimId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const WARRANTY_STATUSES = ["LIKELY_IN_WARRANTY", "LIKELY_EXPIRED", "UNCLEAR"] as const;

export default async function ClaimDetailPage({ params, searchParams }: ClaimDetailPageProps) {
  const auth = await getCachedAuthContext();
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
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          provider: true,
          model: true,
          confidence: true,
          extraction: true,
          createdAt: true,
        },
      },
      events: {
        where: {
          organizationId: auth.organizationId,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
      },
    },
  });

  if (!claim) {
    notFound();
  }

  const latestExtraction = claim.extractions[0] ?? null;
  const claimReference = claim.externalClaimId ?? claim.id;

  return (
    <main className="app-shell page-stack">
      <section className="hero-card">
        <div>
          <p className="hero-breadcrumb">
            <Link href="/dashboard" className="hero-link">
              Back to dashboard
            </Link>
          </p>
          <p className="eyebrow">Claim workspace</p>
          <h1 className="page-title">Claim Review</h1>
          <p className="page-subtitle">
            Review extracted details, capture missing information, and keep the claim moving with a
            complete audit trail.
          </p>
        </div>

        <div className="hero-meta">
          <div className="hero-details">
            <span className="hero-chip">{claimReference}</span>
            <span className={cx("pill", `pill--${getClaimStatusTone(claim.status)}`)}>
              {formatTokenLabel(claim.status)}
            </span>
            <span className={cx("pill", `pill--${getWarrantyTone(claim.warrantyStatus)}`)}>
              {formatTokenLabel(claim.warrantyStatus)}
            </span>
          </div>
          <p className="hero-note">
            {auth.organizationName} - updated {formatUtcDateTime(claim.updatedAt)}
          </p>
        </div>
      </section>

      {notice ? <p className="notice notice--success">{notice}</p> : null}
      {error ? <p className="notice notice--danger">{error}</p> : null}

      <section className="summary-strip">
        <article className="stat-card">
          <p className="stat-label">Missing info</p>
          <strong className="stat-value">{claim.missingInfo.length}</strong>
          <p className="stat-note">Outstanding details still needed to complete the review.</p>
        </article>
        <article className="stat-card">
          <p className="stat-label">Attachments</p>
          <strong className="stat-value">{claim.attachments.length}</strong>
          <p className="stat-note">Stored files available to inspect alongside the claim.</p>
        </article>
        <article className="stat-card">
          <p className="stat-label">Audit events</p>
          <strong className="stat-value">{claim.events.length}</strong>
          <p className="stat-note">Recent workflow changes and user actions on this claim.</p>
        </article>
      </section>

      <section className="content-grid">
        <div className="side-stack">
          <section className="surface-card panel section-stack">
            <div className="section-heading">
              <div>
                <p className="section-kicker">Editable fields</p>
                <h2 className="section-title">Review and edit</h2>
                <p className="section-copy">
                  {canEdit
                    ? "Update the claim record with corrected customer, product, and warranty details."
                    : "This record is visible to you, but editing is limited to Analyst, Admin, and Owner roles."}
                </p>
              </div>
            </div>

            <form action={updateClaimReviewAction} className="section-stack">
              <input type="hidden" name="claimId" value={claim.id} />

              <div className="claim-field-grid">
                <Field label="Customer Name">
                  <input
                    className="control"
                    type="text"
                    name="customerName"
                    defaultValue={claim.customerName ?? ""}
                    disabled={!canEdit}
                  />
                </Field>

                <Field label="Product Name">
                  <input
                    className="control"
                    type="text"
                    name="productName"
                    defaultValue={claim.productName ?? ""}
                    disabled={!canEdit}
                  />
                </Field>

                <Field label="Serial Number">
                  <input
                    className="control"
                    type="text"
                    name="serialNumber"
                    defaultValue={claim.serialNumber ?? ""}
                    disabled={!canEdit}
                  />
                </Field>

                <Field label="Purchase Date">
                  <input
                    className="control"
                    type="date"
                    name="purchaseDate"
                    defaultValue={formatDateInput(claim.purchaseDate)}
                    disabled={!canEdit}
                  />
                </Field>

                <Field label="Retailer">
                  <input
                    className="control"
                    type="text"
                    name="retailer"
                    defaultValue={claim.retailer ?? ""}
                    disabled={!canEdit}
                  />
                </Field>

                <Field label="Warranty Status">
                  <select
                    className="control"
                    name="warrantyStatus"
                    defaultValue={claim.warrantyStatus}
                    disabled={!canEdit}
                  >
                    {WARRANTY_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {formatTokenLabel(status)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field label="Issue Summary">
                <textarea
                  className="control"
                  name="issueSummary"
                  defaultValue={claim.issueSummary ?? ""}
                  rows={5}
                  disabled={!canEdit}
                />
              </Field>

              <Field label="Missing Info (one per line)">
                <textarea
                  className="control"
                  name="missingInfo"
                  defaultValue={claim.missingInfo.join("\n")}
                  rows={4}
                  disabled={!canEdit}
                />
              </Field>

              <div className="cluster">
                {canEdit ? (
                  <button type="submit" className="button button--primary">
                    Save claim updates
                  </button>
                ) : (
                  <p className="section-copy copy-reset">Your role is read-only for claim edits.</p>
                )}
              </div>
            </form>
          </section>

          <section className="surface-card panel section-stack">
            <div className="section-heading">
              <div>
                <p className="section-kicker">Workflow control</p>
                <h2 className="section-title">Status transition</h2>
                <p className="section-copy">
                  Advance or return the claim when it reaches the review-ready states.
                </p>
              </div>
              <span className={cx("pill", `pill--${getClaimStatusTone(claim.status)}`)}>
                {formatTokenLabel(claim.status)}
              </span>
            </div>

            {canEdit ? (
              <div className="cluster">
                {claim.status === "REVIEW_REQUIRED" ? (
                  <form action={transitionClaimStatusAction}>
                    <input type="hidden" name="claimId" value={claim.id} />
                    <input type="hidden" name="targetStatus" value="READY" />
                    <button type="submit" className="button button--primary">
                      Mark as READY
                    </button>
                  </form>
                ) : null}

                {claim.status === "READY" ? (
                  <form action={transitionClaimStatusAction}>
                    <input type="hidden" name="claimId" value={claim.id} />
                    <input type="hidden" name="targetStatus" value="REVIEW_REQUIRED" />
                    <button type="submit" className="button button--secondary">
                      Return to REVIEW_REQUIRED
                    </button>
                  </form>
                ) : null}

                {claim.status !== "REVIEW_REQUIRED" && claim.status !== "READY" ? (
                  <p className="section-copy copy-reset">
                    Transition actions appear once the claim reaches review-ready states.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="section-copy copy-reset">
                Your role is read-only. Analyst, Admin, or Owner access is required to transition
                claim status.
              </p>
            )}
          </section>
        </div>

        <div className="side-stack">
          <section className="surface-card panel section-stack">
            <div className="section-heading">
              <div>
                <p className="section-kicker">Claim summary</p>
                <h2 className="section-title">Metadata</h2>
                <p className="section-copy">
                  Core identifiers and intake metadata for this claim record.
                </p>
              </div>
            </div>

            <div className="kv-grid">
              <MetadataRow label="Claim ID" value={claimReference} />
              <MetadataRow label="Source Email" value={claim.sourceEmail ?? "-"} />
              <MetadataRow
                label="Purchase Date"
                value={formatDateInput(claim.purchaseDate) || "-"}
              />
              <MetadataRow label="Retailer" value={claim.retailer ?? "-"} />
              <MetadataRow label="Created" value={formatUtcDateTime(claim.createdAt)} />
              <MetadataRow label="Updated" value={formatUtcDateTime(claim.updatedAt)} />
            </div>
          </section>

          <section className="surface-card panel section-stack">
            <div className="section-heading">
              <div>
                <p className="section-kicker">Extraction snapshot</p>
                <h2 className="section-title">Latest model output</h2>
                <p className="section-copy">
                  The most recent extraction payload used to inform warranty and review decisions.
                </p>
              </div>
            </div>

            {latestExtraction ? (
              <div className="kv-grid">
                <MetadataRow label="Provider" value={latestExtraction.provider} />
                <MetadataRow label="Model" value={latestExtraction.model} />
                <MetadataRow
                  label="Confidence"
                  value={`${Math.round(latestExtraction.confidence * 100)}%`}
                />
                <MetadataRow
                  label="Extracted At"
                  value={formatUtcDateTime(latestExtraction.createdAt)}
                />
                <MetadataRow
                  label="Reasoning"
                  value={readExtractionReasoning(latestExtraction.extraction) ?? "-"}
                />
              </div>
            ) : (
              <p className="section-copy copy-reset">No extraction has been recorded yet.</p>
            )}
          </section>
        </div>
      </section>

      <section className="surface-card table-card">
        <div className="table-toolbar">
          <div>
            <p className="section-kicker">Supporting documents</p>
            <h2 className="section-title">Attachments</h2>
            <p className="section-copy">
              Review stored files, preview inline assets, or download originals for offline review.
            </p>
          </div>
        </div>

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Filename</th>
                <th>Type</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {claim.attachments.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty-state">
                    No attachments stored for this claim.
                  </td>
                </tr>
              ) : (
                claim.attachments.map((attachment) => (
                  <tr key={attachment.id}>
                    <td>
                      <div>{attachment.originalFilename}</div>
                      <span className="subtle-text">
                        {formatTokenLabel(attachment.uploadStatus)}
                      </span>
                    </td>
                    <td>{attachment.contentType ?? "-"}</td>
                    <td>{formatBytes(attachment.byteSize)}</td>
                    <td>{formatUtcDateTime(attachment.createdAt)}</td>
                    <td>
                      {attachment.uploadStatus === "STORED" ? (
                        <div className="cluster">
                          {isInlinePreviewableAttachment(attachment.contentType) ? (
                            <a
                              href={`/api/claims/${claim.id}/attachments/${attachment.id}/download?disposition=inline`}
                              className="table-link"
                              target="_blank"
                              rel="noreferrer"
                            >
                              View
                            </a>
                          ) : null}
                          <a
                            href={`/api/claims/${claim.id}/attachments/${attachment.id}/download`}
                            className="table-link"
                          >
                            Download
                          </a>
                        </div>
                      ) : (
                        "Unavailable"
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="surface-card table-card">
        <div className="table-toolbar">
          <div>
            <p className="section-kicker">Recent history</p>
            <h2 className="section-title">Audit events</h2>
            <p className="section-copy">
              Status transitions and manual edits recorded against this claim.
            </p>
          </div>
        </div>

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Actor</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {claim.events.length === 0 ? (
                <tr>
                  <td colSpan={4} className="empty-state">
                    No audit events yet.
                  </td>
                </tr>
              ) : (
                claim.events.map((event) => (
                  <tr key={event.id}>
                    <td>{formatUtcDateTime(event.createdAt)}</td>
                    <td>
                      <span className={cx("pill", `pill--${getEventTone(event.eventType)}`)}>
                        {formatTokenLabel(event.eventType)}
                      </span>
                    </td>
                    <td>{event.actorUser?.fullName ?? event.actorUser?.email ?? "System"}</td>
                    <td>{describeEvent(event.eventType, event.payload)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field-label">
      <span>{label}</span>
      {children}
    </label>
  );
}

function MetadataRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="kv-row">
      <p className="kv-label">{label}</p>
      <div className="kv-value">{value}</div>
    </div>
  );
}

function getEventTone(eventType: string): "neutral" | "info" {
  return eventType === "STATUS_TRANSITION" ? "info" : "neutral";
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
    return source
      ? `${formatTokenLabel(fromStatus)} to ${formatTokenLabel(toStatus)} (${source})`
      : `${formatTokenLabel(fromStatus)} to ${formatTokenLabel(toStatus)}`;
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

  return formatTokenLabel(eventType);
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
