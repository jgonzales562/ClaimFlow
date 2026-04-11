import Link from "next/link";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
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
  const errorValue = Array.isArray(error) ? error[0] : error;
  const redirectValue = Array.isArray(redirect) ? redirect[0] : redirect;

  return (
    <main className="login-shell">
      <section className="login-layout">
        <div className="login-hero">
          <div className="login-hero-top">
            <div>
              <p className="eyebrow">Claims operations workspace</p>
              <h1 className="login-lead">Secure access to intake, review, and exception handling.</h1>
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
              <h2 className="section-title">Sign in to ClaimFlow</h2>
              <p className="section-copy">
                Use your organization credentials to open the live claims workspace.
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

          {errorValue ? (
            <p className="notice notice--danger">
              {errorValue === "no_membership"
                ? "This user has no organization membership."
                : errorValue === "multiple_memberships"
                  ? "This user belongs to multiple organizations and needs an organization-specific sign-in flow."
                : errorValue === "invalid_role"
                  ? "This user has an invalid organization role."
                  : "Invalid email or password."}
            </p>
          ) : null}

          <form action="/api/auth/login" method="post" className="login-form">
            {redirectValue ? <input type="hidden" name="redirect" value={redirectValue} /> : null}

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
        </section>
      </section>
    </main>
  );
}
