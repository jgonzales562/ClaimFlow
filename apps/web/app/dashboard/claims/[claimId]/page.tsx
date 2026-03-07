import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { isInlinePreviewableAttachment } from "@/lib/attachments";
import { getCachedAuthContext, hasMinimumRole } from "@/lib/auth/server";
import { loadClaimDetail } from "@/lib/claims/claim-detail";
import {
  describeClaimEvent,
  formatClaimProcessingAttempt,
  formatClaimAttachmentBytes,
  getClaimEventTone,
  getClaimProcessingLeaseSignal,
  getClaimReviewSignal,
  mapClaimDetailError,
  mapClaimDetailNotice,
  readClaimExtractionReasoning,
} from "@/lib/claims/claim-detail-ui";
import { formatUtcDateTime } from "@/lib/format";
import { formatDateInput, readSearchParam } from "@/lib/claims/filters";
import {
  GlanceCard,
  KeyValueRow,
  NoticeBanner,
  PageHero,
  PanelSection,
  Pill,
  StatCard,
  TableSection,
} from "@/components/ui/dashboard";
import { formatTokenLabel, getClaimStatusTone, getWarrantyTone } from "@/lib/ui";
import {
  recoverProcessingAction,
  retryClaimAction,
  transitionClaimStatusAction,
  updateClaimReviewAction,
} from "./actions";

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
  const notice = mapClaimDetailNotice(readSearchParam(resolvedSearchParams, "notice"));
  const error = mapClaimDetailError(readSearchParam(resolvedSearchParams, "error"));
  const canEdit = hasMinimumRole(auth.role, "ANALYST");

  const claim = await loadClaimDetail({
    organizationId: auth.organizationId,
    claimId,
  });

  if (!claim) {
    notFound();
  }

  const latestExtraction = claim.extractions[0] ?? null;
  const claimReference = claim.externalClaimId ?? claim.id;
  const extractionConfidence = latestExtraction
    ? Math.round(latestExtraction.confidence * 100)
    : null;
  const reviewSignal = getClaimReviewSignal(
    claim.status,
    claim.missingInfo.length,
    claim.isProcessingStale,
  );
  const processingLeaseSignal = getClaimProcessingLeaseSignal({
    status: claim.status,
    processingLeaseToken: claim.processingLeaseToken,
    processingLeaseClaimedAt: claim.processingLeaseClaimedAt,
    isProcessingStale: claim.isProcessingStale,
  });

  return (
    <main className="app-shell page-stack">
      <PageHero
        eyebrow="Claim workspace"
        title="Claim Review"
        subtitle="Review extracted details, capture missing information, and keep the claim moving with a complete audit trail."
        breadcrumbHref="/dashboard"
        breadcrumbLabel="Back to dashboard"
        meta={
          <>
            <span className="hero-chip">{claimReference}</span>
            <Pill tone={getClaimStatusTone(claim.status)}>{formatTokenLabel(claim.status)}</Pill>
            <Pill tone={getWarrantyTone(claim.warrantyStatus)}>
              {formatTokenLabel(claim.warrantyStatus)}
            </Pill>
          </>
        }
        note={`${auth.organizationName} - updated ${formatUtcDateTime(claim.updatedAt)}`}
      />

      {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
      {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}

      <section className="summary-strip">
        <StatCard
          label="Missing info"
          value={claim.missingInfo.length}
          note="Outstanding details still needed to complete the review."
        />
        <StatCard
          label="Attachments"
          value={claim.storedAttachmentCount}
          note="Stored files currently available to inspect alongside the claim."
        />
        <StatCard
          label="Audit events"
          value={claim.events.length}
          note="Recent workflow changes and user actions on this claim."
        />
      </section>

      <section className="content-grid">
        <div className="side-stack">
          <PanelSection
            kicker="Editable fields"
            title="Review and edit"
            copy={
              canEdit
                ? "Update the claim record with corrected customer, product, and warranty details."
                : "This record is visible to you, but editing is limited to Analyst, Admin, and Owner roles."
            }
          >
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
          </PanelSection>

          <PanelSection
            kicker="Workflow control"
            title="Status transition"
            copy="Advance or return the claim when it reaches the review-ready states."
            accessory={
              <Pill tone={getClaimStatusTone(claim.status)}>{formatTokenLabel(claim.status)}</Pill>
            }
          >
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

                {claim.status === "ERROR" && claim.latestFailure?.retryable === true ? (
                  <form action={retryClaimAction}>
                    <input type="hidden" name="claimId" value={claim.id} />
                    <button type="submit" className="button button--primary">
                      Retry claim
                    </button>
                  </form>
                ) : null}

                {claim.status === "ERROR" && claim.latestFailure?.retryable === true ? (
                  <p className="section-copy copy-reset">
                    The latest worker failure is marked retryable, so you can send this claim back
                    through intake processing.
                  </p>
                ) : null}

                {claim.status === "PROCESSING" && claim.isProcessingStale ? (
                  <form action={recoverProcessingAction}>
                    <input type="hidden" name="claimId" value={claim.id} />
                    <button type="submit" className="button button--secondary">
                      Recover processing
                    </button>
                  </form>
                ) : null}

                {claim.status === "PROCESSING" && claim.isProcessingStale ? (
                  <p className="section-copy copy-reset">
                    This claim has been processing longer than expected. Queue a fresh recovery
                    attempt if intake appears stalled.
                  </p>
                ) : null}

                {claim.status !== "REVIEW_REQUIRED" &&
                claim.status !== "READY" &&
                !(claim.status === "PROCESSING" && claim.isProcessingStale) &&
                !(claim.status === "ERROR" && claim.latestFailure?.retryable === true) ? (
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
          </PanelSection>
        </div>

        <div className="side-stack">
          <PanelSection
            kicker="Review posture"
            title="Current operating signal"
            copy="A compact read on whether this claim can move forward or still needs manual work."
            accessory={<Pill tone={reviewSignal.tone}>{reviewSignal.badge}</Pill>}
          >
            <div className="glance-grid">
              <GlanceCard
                tone={reviewSignal.tone}
                label="Next action"
                value={reviewSignal.title}
                copy={reviewSignal.copy}
              />
              <GlanceCard
                tone="info"
                label="Model confidence"
                value={extractionConfidence == null ? "Pending" : `${extractionConfidence}%`}
                copy={
                  extractionConfidence == null
                    ? "No extraction output is available yet."
                    : "Use this as a directional signal alongside the supporting documents."
                }
              />
              <GlanceCard
                tone={canEdit ? "success" : "neutral"}
                label="Access level"
                value={canEdit ? "Editable" : "Read only"}
                copy={
                  canEdit
                    ? "You can update fields and transition this claim."
                    : "You can review the record, but edits and transitions are disabled."
                }
              />
              <GlanceCard
                tone={claim.missingInfo.length > 0 ? "warning" : "success"}
                label="Outstanding follow-up"
                value={claim.missingInfo.length > 0 ? claim.missingInfo.length : "None"}
                copy={
                  claim.missingInfo.length > 0
                    ? "Missing details are still recorded and may need outreach before completion."
                    : "No missing information is currently flagged on the claim."
                }
              />
            </div>
          </PanelSection>

          <PanelSection
            kicker="Processing telemetry"
            title="Attempt and lease state"
            copy="Operational context for the current intake attempt, worker ownership, and recovery posture."
          >
            <div className="glance-grid">
              <GlanceCard
                tone={claim.processingAttempt > 1 ? "warning" : "info"}
                label="Processing attempt"
                value={formatClaimProcessingAttempt(claim.status, claim.processingAttempt)}
                copy={
                  claim.processingAttempt > 1
                    ? "This claim has already re-entered automated intake after an earlier retry or recovery."
                    : claim.processingAttempt === 1
                      ? "This claim is on its first tracked automated intake attempt."
                      : claim.status === "NEW"
                        ? "The claim has not entered tracked processing yet."
                        : "This claim predates the current attempt-tracking model."
                }
              />
              <GlanceCard
                tone={processingLeaseSignal.tone}
                label="Lease posture"
                value={processingLeaseSignal.value}
                copy={processingLeaseSignal.copy}
              />
            </div>
          </PanelSection>

          <PanelSection
            kicker="Claim summary"
            title="Metadata"
            copy="Core identifiers and intake metadata for this claim record."
          >
            <div className="kv-grid">
              <KeyValueRow label="Claim ID" value={claimReference} />
              <KeyValueRow label="Source Email" value={claim.sourceEmail ?? "-"} />
              <KeyValueRow
                label="Purchase Date"
                value={formatDateInput(claim.purchaseDate) || "-"}
              />
              <KeyValueRow label="Retailer" value={claim.retailer ?? "-"} />
              <KeyValueRow
                label="Lease Claimed"
                value={
                  claim.processingLeaseClaimedAt
                    ? formatUtcDateTime(claim.processingLeaseClaimedAt)
                    : claim.status === "PROCESSING" && claim.processingLeaseToken
                      ? "Pending worker claim"
                      : "-"
                }
              />
              <KeyValueRow label="Created" value={formatUtcDateTime(claim.createdAt)} />
              <KeyValueRow label="Updated" value={formatUtcDateTime(claim.updatedAt)} />
            </div>
          </PanelSection>

          <PanelSection
            kicker="Extraction snapshot"
            title="Latest model output"
            copy="The most recent extraction payload used to inform warranty and review decisions."
          >
            {latestExtraction ? (
              <div className="kv-grid">
                <KeyValueRow label="Provider" value={latestExtraction.provider} />
                <KeyValueRow label="Model" value={latestExtraction.model} />
                <KeyValueRow
                  label="Confidence"
                  value={`${Math.round(latestExtraction.confidence * 100)}%`}
                />
                <KeyValueRow
                  label="Extracted At"
                  value={formatUtcDateTime(latestExtraction.createdAt)}
                />
                <KeyValueRow
                  label="Reasoning"
                  value={readClaimExtractionReasoning(latestExtraction.extraction) ?? "-"}
                />
              </div>
            ) : (
              <p className="section-copy copy-reset">No extraction has been recorded yet.</p>
            )}
          </PanelSection>
        </div>
      </section>

      <TableSection
        kicker="Supporting documents"
        title="Attachments"
        copy="Review stored files, preview inline assets, or download originals for offline review."
      >
        <div className="table-scroll">
          <table className="data-table data-table--responsive">
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
                    <td data-label="Filename">
                      <div>{attachment.originalFilename}</div>
                      <span className="subtle-text">
                        {formatTokenLabel(attachment.uploadStatus)}
                      </span>
                    </td>
                    <td data-label="Type">{attachment.contentType ?? "-"}</td>
                    <td data-label="Size">{formatClaimAttachmentBytes(attachment.byteSize)}</td>
                    <td data-label="Uploaded">{formatUtcDateTime(attachment.createdAt)}</td>
                    <td data-label="Actions">
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
      </TableSection>

      <TableSection
        kicker="Recent history"
        title="Audit events"
        copy="Status transitions and manual edits recorded against this claim."
      >
        <div className="table-scroll">
          <table className="data-table data-table--responsive">
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
                    <td data-label="Time">{formatUtcDateTime(event.createdAt)}</td>
                    <td data-label="Type">
                      <Pill tone={getClaimEventTone(event.eventType)}>
                        {formatTokenLabel(event.eventType)}
                      </Pill>
                    </td>
                    <td data-label="Actor">
                      {event.actorUser?.fullName ?? event.actorUser?.email ?? "System"}
                    </td>
                    <td data-label="Details">
                      {describeClaimEvent(event.eventType, event.payload)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </TableSection>
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
