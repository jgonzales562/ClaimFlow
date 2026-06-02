import React from "react";
import { redirect } from "next/navigation";
import { NoticeBanner, PageHero, PanelSection, Pill } from "@/components/ui/dashboard";
import { getCachedAuthContext, hasMinimumRole } from "@/lib/auth/server";
import { readSearchParam } from "@/lib/claims/filters";
import {
  loadOrganizationExtractionSettings,
  MAX_SCAN_KEYWORDS,
  MAX_SCAN_KEYWORD_LENGTH,
  type OrganizationExtractionSettings,
} from "@/lib/extraction/settings";
import { formatUtcDateTime } from "@/lib/format";
import { formatTokenLabel } from "@/lib/ui";
import { updateExtractionSettingsAction } from "./actions";

type ExtractionSettingsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type MembershipRole = "OWNER" | "ADMIN" | "ANALYST" | "VIEWER";
type ExtractionSettingsPageAuthContext = {
  userId: string;
  email: string;
  organizationId: string;
  organizationName: string;
  role: MembershipRole;
};

type ExtractionSettingsPageDependencies = {
  getAuthContextFn: () => Promise<ExtractionSettingsPageAuthContext | null>;
  hasMinimumRoleFn: (currentRole: MembershipRole, requiredRole: MembershipRole) => boolean;
  loadOrganizationExtractionSettingsFn: (
    organizationId: string,
  ) => Promise<OrganizationExtractionSettings>;
  updateExtractionSettingsActionFn: (formData: FormData) => Promise<void>;
  redirectFn: (location: string) => void;
};

const SETTINGS_PATH = "/dashboard/settings/extraction";

export function createExtractionSettingsPage(
  dependencies: Partial<ExtractionSettingsPageDependencies> = {},
) {
  const {
    getAuthContextFn = getCachedAuthContext,
    hasMinimumRoleFn = hasMinimumRole,
    loadOrganizationExtractionSettingsFn = loadOrganizationExtractionSettings,
    updateExtractionSettingsActionFn = updateExtractionSettingsAction,
    redirectFn = redirect,
  } = dependencies;

  return async function ExtractionSettingsPage({ searchParams }: ExtractionSettingsPageProps) {
    const authContext = await getAuthContextFn();
    if (!authContext) {
      redirectFn(`/login?redirect=${encodeURIComponent(SETTINGS_PATH)}`);
    }
    const auth = authContext as NonNullable<typeof authContext>;

    if (!hasMinimumRoleFn(auth.role, "ADMIN")) {
      redirectFn("/dashboard?error=forbidden");
    }

    const resolvedSearchParams = (await searchParams) ?? {};
    const notice = mapExtractionSettingsNotice(readSearchParam(resolvedSearchParams, "notice"));
    const error = mapExtractionSettingsError(readSearchParam(resolvedSearchParams, "error"));
    const settings = await loadOrganizationExtractionSettingsFn(auth.organizationId);
    const scanKeywordsText = settings.scanKeywords.join("\n");

    return (
      <main className="app-shell app-shell--ops page-stack">
        <PageHero
          compact
          eyebrow="Extraction settings"
          title="Company Scan Keywords"
          subtitle={`Tune extraction vocabulary for ${auth.organizationName}. These terms are passed to claim intake so company-specific product, failure, and document language is prioritized.`}
          breadcrumbHref="/dashboard"
          breadcrumbLabel="Back to dashboard"
          meta={
            <>
              <span className="hero-chip">{auth.organizationName}</span>
              <Pill tone="info">{formatTokenLabel(auth.role)}</Pill>
            </>
          }
          note={
            settings.updatedAt
              ? `Last updated ${formatUtcDateTime(settings.updatedAt)}`
              : "No custom keywords saved yet"
          }
        />

        {notice ? <NoticeBanner tone="success">{notice}</NoticeBanner> : null}
        {error ? <NoticeBanner tone="danger">{error}</NoticeBanner> : null}

        <PanelSection
          kicker="Keyword profile"
          title="Terms to scan during intake"
          copy={`Use one keyword or phrase per line. Up to ${MAX_SCAN_KEYWORDS} terms are allowed, with ${MAX_SCAN_KEYWORD_LENGTH} characters per term.`}
          accessory={
            <Pill tone={settings.scanKeywords.length > 0 ? "success" : "neutral"}>
              {settings.scanKeywords.length} configured
            </Pill>
          }
        >
          <form action={updateExtractionSettingsActionFn} className="section-stack">
            <label className="field-label">
              <span>Scan Keywords</span>
              <textarea
                className="control control--tall mono-text"
                name="scanKeywords"
                defaultValue={scanKeywordsText}
                placeholder={"serial number\nproof of purchase\ncompressor failure"}
              />
            </label>
            <div className="cluster">
              <button type="submit" className="button button--primary">
                Save Keywords
              </button>
              <a href="/dashboard" className="button button--secondary">
                Cancel
              </a>
            </div>
          </form>
        </PanelSection>
      </main>
    );
  };
}

const ExtractionSettingsPage = createExtractionSettingsPage();

export default ExtractionSettingsPage;

function mapExtractionSettingsNotice(value: string | null): string | null {
  switch (value) {
    case "settings_updated":
      return "Extraction scan keywords saved.";
    case "no_changes":
      return "No extraction keyword changes were detected.";
    default:
      return null;
  }
}

function mapExtractionSettingsError(value: string | null): string | null {
  switch (value) {
    case "forbidden":
      return "You do not have permission to edit extraction settings.";
    case "invalid_request":
      return "Request origin could not be verified.";
    case "keyword_too_long":
      return `Each scan keyword must be ${MAX_SCAN_KEYWORD_LENGTH} characters or fewer.`;
    case "too_many_keywords":
      return `Use ${MAX_SCAN_KEYWORDS} scan keywords or fewer.`;
    default:
      return null;
  }
}
