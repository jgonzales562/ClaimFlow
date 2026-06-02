import React from "react";
import { redirect } from "next/navigation";
import { PageHero, Pill, TableSection } from "@/components/ui/dashboard";
import { getCachedAuthContext, hasMinimumRole } from "@/lib/auth/server";
import {
  describeAuditEvent,
  getAuditEventTone,
  listOrganizationAuditEvents,
  type OrganizationAuditEvent,
} from "@/lib/security/audit-history";
import { formatUtcDateTime } from "@/lib/format";
import { formatTokenLabel } from "@/lib/ui";

type MembershipRole = "OWNER" | "ADMIN" | "ANALYST" | "VIEWER";
type AuditHistoryPageAuthContext = {
  userId: string;
  email: string;
  organizationId: string;
  organizationName: string;
  role: MembershipRole;
};

type AuditHistoryPageDependencies = {
  getAuthContextFn: () => Promise<AuditHistoryPageAuthContext | null>;
  hasMinimumRoleFn: (currentRole: MembershipRole, requiredRole: MembershipRole) => boolean;
  listOrganizationAuditEventsFn: (input: {
    organizationId: string;
    limit?: number;
  }) => Promise<OrganizationAuditEvent[]>;
  redirectFn: (location: string) => void;
};

export function createAuditHistoryPage(dependencies: Partial<AuditHistoryPageDependencies> = {}) {
  const {
    getAuthContextFn = getCachedAuthContext,
    hasMinimumRoleFn = hasMinimumRole,
    listOrganizationAuditEventsFn = listOrganizationAuditEvents,
    redirectFn = redirect,
  } = dependencies;

  return async function AuditHistoryPage() {
    const authContext = await getAuthContextFn();
    if (!authContext) {
      redirectFn("/login");
    }
    const auth = authContext as NonNullable<typeof authContext>;

    if (!hasMinimumRoleFn(auth.role, "ADMIN")) {
      redirectFn("/dashboard?error=forbidden");
    }

    const auditEvents = await listOrganizationAuditEventsFn({
      organizationId: auth.organizationId,
      limit: 100,
    });

    return (
      <main className="app-shell app-shell--ops page-stack">
        <PageHero
          compact
          eyebrow="Audit history"
          title="Export and Access History"
          subtitle={`Review organization-level audit events for ${auth.organizationName}, including claim exports, attachment access, and extraction settings updates.`}
          breadcrumbHref="/dashboard"
          breadcrumbLabel="Back to dashboard"
          meta={
            <>
              <span className="hero-chip">{auth.organizationName}</span>
              <Pill tone="info">{formatTokenLabel(auth.role)}</Pill>
            </>
          }
          note={`Showing ${auditEvents.length} recent event${auditEvents.length === 1 ? "" : "s"}`}
        />

        <TableSection
          kicker="Organization audit"
          title="Recent audited activity"
          copy="Security-sensitive access and export events recorded for this organization."
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
                {auditEvents.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="empty-state">
                      No audit events have been recorded yet.
                    </td>
                  </tr>
                ) : (
                  auditEvents.map((event) => (
                    <tr
                      key={event.id}
                      className={`data-row data-row--${getAuditEventTone(event.eventType)}`}
                    >
                      <td data-label="Time">
                        <span className="mono-text mono-text--quiet">
                          {formatUtcDateTime(event.createdAt)}
                        </span>
                      </td>
                      <td data-label="Type">
                        <Pill tone={getAuditEventTone(event.eventType)}>
                          {formatTokenLabel(event.eventType)}
                        </Pill>
                      </td>
                      <td data-label="Actor">
                        {event.actorUser?.fullName ?? event.actorUser?.email ?? "System"}
                      </td>
                      <td data-label="Details">
                        {describeAuditEvent(event.eventType, event.payload)}
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
  };
}

const AuditHistoryPage = createAuditHistoryPage();

export default AuditHistoryPage;
