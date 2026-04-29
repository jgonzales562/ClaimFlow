import { prisma } from "@claimflow/db";
import { cookies } from "next/headers";
import Link from "next/link";
import {
  isMembershipRole,
  PENDING_LOGIN_COOKIE_NAME,
  type MembershipRole,
  verifyPendingLoginToken,
} from "@/lib/auth/session";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type OrganizationSelectionState =
  | {
      kind: "ready";
      email: string;
      fullName: string | null;
      redirectTo: string | null;
      organizations: Array<{
        id: string;
        name: string;
        slug: string;
        role: MembershipRole;
      }>;
    }
  | {
      kind: "expired";
    };

const loginHighlights = [
  {
    title: "Structured intake",
    copy: "Review incoming claim emails, attachments, and extracted fields from one controlled workspace.",
  },
  {
    title: "Analyst workflow",
    copy: "Move claims through review, exception handling, and readiness decisions without leaving an audit trail gap.",
  },
  {
    title: "Operational recovery",
    copy: "Inspect failures, retry eligible claims, and recover stalled processing with role-scoped controls.",
  },
] as const;

const loginAssurances = [
  "Organization-scoped access",
  "Role-based review controls",
  "Audited workflow changes",
] as const;

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const error = resolvedSearchParams.error;
  const redirect = resolvedSearchParams.redirect;
  const selectOrg = resolvedSearchParams.select_org;
  const errorValue = Array.isArray(error) ? error[0] : error;
  const redirectValue = Array.isArray(redirect) ? redirect[0] : redirect;
  const selectOrgValue = Array.isArray(selectOrg) ? selectOrg[0] : selectOrg;
  const organizationSelection =
    selectOrgValue === "1" ? await resolveOrganizationSelectionState() : null;
  const activeSelection = organizationSelection?.kind === "ready" ? organizationSelection : null;
  const activeRedirect = activeSelection?.redirectTo ?? redirectValue;
  const noticeMessage = resolveNoticeMessage(
    organizationSelection?.kind === "expired" ? "selection_expired" : errorValue,
  );

  return (
    <main className="login-shell">
      <section className="login-layout">
        <div className="login-hero">
          <div className="login-hero-top">
            <div>
              <p className="eyebrow">Claims operations workspace</p>
              <h1 className="login-lead">
                Secure access to intake, review, and exception handling.
              </h1>
              <p className="login-copy">
                ClaimFlow is built for teams working live warranty queues. Access stays scoped to
                organization membership, role permissions, and auditable workflow actions.
              </p>
            </div>

            <div className="login-context-grid">
              {loginAssurances.map((assurance) => (
                <article key={assurance} className="login-context-card">
                  <p className="login-context-label">{assurance}</p>
                </article>
              ))}
            </div>
          </div>

          <div className="feature-list">
            {loginHighlights.map((item) => (
              <article key={item.title} className="feature-item">
                <h2 className="feature-title">{item.title}</h2>
                <p className="feature-copy">{item.copy}</p>
              </article>
            ))}
          </div>

          <div className="login-trust-note">
            <p className="login-trust-kicker">Why it matters</p>
            <p className="login-trust-copy">
              Operators need a queue they can trust. ClaimFlow keeps the working record, supporting
              files, retries, and status transitions in one place instead of spreading them across
              inboxes, ad hoc notes, and manual follow-up.
            </p>
          </div>
        </div>

        <section className="surface-card login-panel">
          <div className="login-panel-head">
            <div>
              <p className="section-kicker">Workspace access</p>
              <h2 className="section-title">
                {activeSelection ? "Choose an organization" : "Sign in to ClaimFlow"}
              </h2>
              <p className="section-copy">
                {activeSelection
                  ? "This account can access multiple organizations. Select the workspace for this session."
                  : "Use your organization credentials to open the live claims workspace."}
              </p>
            </div>

            <div className="login-access-note">
              <p className="login-access-label">Access policy</p>
              <p className="login-access-copy">
                Sessions are limited by organization membership and the permissions attached to your
                role.
              </p>
            </div>
          </div>

          {noticeMessage ? <p className="notice notice--danger">{noticeMessage}</p> : null}

          {activeSelection ? (
            <>
              <div className="login-selection-intro">
                <p className="copy-reset subtle-text">
                  Signed in as{" "}
                  <strong>{activeSelection.fullName?.trim() || activeSelection.email}</strong>
                </p>
              </div>

              <form action="/api/auth/login" method="post" className="login-form">
                <input type="hidden" name="intent" value="select_organization" />
                {activeRedirect ? (
                  <input type="hidden" name="redirect" value={activeRedirect} />
                ) : null}

                <div className="feature-list">
                  {activeSelection.organizations.map((organization) => (
                    <button
                      key={organization.id}
                      type="submit"
                      name="organizationId"
                      value={organization.id}
                      className="feature-item"
                    >
                      <span className="feature-title">{organization.name}</span>
                      <span className="feature-copy">
                        {organization.slug} · {formatRoleLabel(organization.role)}
                      </span>
                    </button>
                  ))}
                </div>
              </form>

              <div className="login-footer">
                <p className="copy-reset subtle-text">
                  Organization choice applies only to this session and keeps the workspace scope
                  explicit for multi-org users.
                </p>
                <p className="copy-reset">
                  <Link href={buildLoginHref(activeRedirect ?? null)} className="inline-link">
                    Use a different account
                  </Link>
                </p>
              </div>
            </>
          ) : (
            <>
              <form action="/api/auth/login" method="post" className="login-form">
                {activeRedirect ? (
                  <input type="hidden" name="redirect" value={activeRedirect} />
                ) : null}

                <label className="field-label">
                  <span>Email</span>
                  <input className="control" type="email" name="email" required />
                </label>

                <label className="field-label">
                  <span>Password</span>
                  <input className="control" type="password" name="password" required />
                </label>

                <button type="submit" className="button button--primary">
                  Sign in
                </button>
              </form>

              <div className="login-footer">
                <p className="copy-reset subtle-text">
                  Every manual edit, status transition, retry, and recovery action remains auditable
                  after sign-in.
                </p>
                <p className="copy-reset">
                  <Link href="/" className="inline-link">
                    Back to home
                  </Link>
                </p>
              </div>
            </>
          )}
        </section>
      </section>
    </main>
  );
}

async function resolveOrganizationSelectionState(): Promise<OrganizationSelectionState> {
  const cookieStore = await cookies();
  const token = cookieStore.get(PENDING_LOGIN_COOKIE_NAME)?.value;
  if (!token) {
    return { kind: "expired" };
  }

  const payload = verifyPendingLoginToken(token);
  if (!payload) {
    return { kind: "expired" };
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    select: {
      email: true,
      fullName: true,
      memberships: {
        select: {
          organizationId: true,
          role: true,
          organization: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });
  if (!user) {
    return { kind: "expired" };
  }

  const organizations = user.memberships
    .filter(
      (
        membership,
      ): membership is {
        organizationId: string;
        role: MembershipRole;
        organization: {
          id: string;
          name: string;
          slug: string;
        };
      } => isMembershipRole(membership.role),
    )
    .map((membership) => ({
      id: membership.organizationId,
      name: membership.organization.name,
      slug: membership.organization.slug,
      role: membership.role,
    }));

  if (organizations.length === 0) {
    return { kind: "expired" };
  }

  return {
    kind: "ready",
    email: user.email,
    fullName: user.fullName,
    redirectTo: payload.redirectTo,
    organizations,
  };
}

function resolveNoticeMessage(error: string | undefined): string | null {
  if (!error) {
    return null;
  }

  if (error === "no_membership") {
    return "This user has no organization membership.";
  }

  if (error === "multiple_memberships") {
    return "Select the organization workspace you want to open.";
  }

  if (error === "invalid_role") {
    return "This user has an invalid organization role.";
  }

  if (error === "invalid_organization") {
    return "Select a valid organization to continue.";
  }

  if (error === "selection_expired") {
    return "Your organization selection expired. Sign in again.";
  }

  if (error === "rate_limited") {
    return "Too many sign-in attempts. Try again later.";
  }

  return "Invalid email or password.";
}

function formatRoleLabel(role: MembershipRole): string {
  return role.charAt(0) + role.slice(1).toLowerCase();
}

function buildLoginHref(redirectTo: string | null): string {
  if (!redirectTo) {
    return "/login";
  }

  const url = new URL("/login", "http://localhost");
  url.searchParams.set("redirect", redirectTo);
  return `${url.pathname}${url.search}`;
}
