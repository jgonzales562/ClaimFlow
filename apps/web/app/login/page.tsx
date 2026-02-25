import type { CSSProperties } from "react";
import Link from "next/link";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const error = resolvedSearchParams.error;
  const errorValue = Array.isArray(error) ? error[0] : error;

  return (
    <main style={{ maxWidth: 440, margin: "72px auto", padding: "0 24px" }}>
      <h1 style={{ marginBottom: 8 }}>Sign in to ClaimFlow</h1>
      <p style={{ marginTop: 0, color: "#495366" }}>
        Use your organization account to access claims.
      </p>

      {errorValue ? (
        <p
          style={{
            background: "#fff1f2",
            color: "#991b1b",
            border: "1px solid #fecdd3",
            borderRadius: 8,
            padding: 12,
            marginBottom: 16,
          }}
        >
          {errorValue === "no_membership"
            ? "This user has no organization membership."
            : "Invalid email or password."}
        </p>
      ) : null}

      <form action="/api/auth/login" method="post" style={{ display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Email</span>
          <input
            type="email"
            name="email"
            required
            defaultValue="admin@claimflow.local"
            style={inputStyle}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Password</span>
          <input type="password" name="password" required defaultValue="Moonbeem7!" style={inputStyle} />
        </label>

        <button type="submit" style={buttonStyle}>
          Sign in
        </button>
      </form>

      <p style={{ marginTop: 20, color: "#667084", fontSize: 14 }}>
        Seeded development account: <code>admin@claimflow.local</code> / <code>Moonbeem7!</code>
      </p>
      <p style={{ marginTop: 12, fontSize: 14 }}>
        <Link href="/">Back to home</Link>
      </p>
    </main>
  );
}

const inputStyle: CSSProperties = {
  border: "1px solid #d0d5dd",
  borderRadius: 8,
  padding: "10px 12px",
  fontSize: 14,
};

const buttonStyle: CSSProperties = {
  marginTop: 4,
  background: "#0f172a",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "10px 14px",
  fontWeight: 600,
  cursor: "pointer",
};
