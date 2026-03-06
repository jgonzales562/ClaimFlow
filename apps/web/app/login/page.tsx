import Link from "next/link";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const error = resolvedSearchParams.error;
  const errorValue = Array.isArray(error) ? error[0] : error;

  return (
    <main className="login-shell">
      <section className="login-layout">
        <div className="login-hero">
          <div>
            <p className="eyebrow">Claim operations platform</p>
            <h1 className="login-lead">Warranty claims without the inbox chaos.</h1>
            <p className="login-copy">
              ClaimFlow gives operations teams a cleaner way to intake, review, and resolve claims
              while keeping every attachment, edit, and status change traceable.
            </p>
          </div>

          <div className="feature-list">
            <article className="feature-item">
              <h2 className="feature-title">Centralized intake</h2>
              <p className="feature-copy">
                Bring claim emails, documents, and extracted fields into a single working queue.
              </p>
            </article>
            <article className="feature-item">
              <h2 className="feature-title">Faster review cycles</h2>
              <p className="feature-copy">
                Surface missing information and warranty signals so analysts can focus on decisions,
                not cleanup.
              </p>
            </article>
            <article className="feature-item">
              <h2 className="feature-title">Defensible audit history</h2>
              <p className="feature-copy">
                Preserve status transitions, user edits, and supporting files from intake through
                resolution.
              </p>
            </article>
          </div>
        </div>

        <section className="surface-card login-panel">
          <div className="section-heading">
            <div>
              <p className="section-kicker">Access</p>
              <h2 className="section-title">Sign in to ClaimFlow</h2>
              <p className="section-copy">
                Use your organization credentials to enter the claims workspace.
              </p>
            </div>
          </div>

          {errorValue ? (
            <p className="notice notice--danger">
              {errorValue === "no_membership"
                ? "This user has no organization membership."
                : errorValue === "invalid_role"
                  ? "This user has an invalid organization role."
                  : "Invalid email or password."}
            </p>
          ) : null}

          <form action="/api/auth/login" method="post" className="login-form">
            <label className="field-label">
              <span>Email</span>
              <input
                className="control"
                type="email"
                name="email"
                required
                defaultValue="admin@claimflow.local"
              />
            </label>

            <label className="field-label">
              <span>Password</span>
              <input
                className="control"
                type="password"
                name="password"
                required
                defaultValue="Moonbeem7!"
              />
            </label>

            <button type="submit" className="button button--primary">
              Sign in
            </button>
          </form>

          <p className="dev-hint">
            Seeded development account: <code>admin@claimflow.local</code> / <code>Moonbeem7!</code>
          </p>

          <p className="copy-reset">
            <Link href="/" className="inline-link">
              Back to home
            </Link>
          </p>
        </section>
      </section>
    </main>
  );
}
