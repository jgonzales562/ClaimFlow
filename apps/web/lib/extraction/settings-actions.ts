import {
  ExtractionSettingsValidationError,
  updateOrganizationExtractionSettings,
} from "./settings";

type MembershipRole = "OWNER" | "ADMIN" | "ANALYST" | "VIEWER";

type ExtractionSettingsActionAuthContext = {
  userId: string;
  organizationId: string;
  role: MembershipRole;
};

type ExtractionSettingsActionDependencies = {
  getAuthContextFn: () => Promise<ExtractionSettingsActionAuthContext | null>;
  hasMinimumRoleFn: (currentRole: MembershipRole, requiredRole: MembershipRole) => boolean;
  redirectFn: (location: string) => void;
  revalidatePathFn: (path: string) => void;
  assertSameOriginFn?: () => Promise<boolean> | boolean;
  updateOrganizationExtractionSettingsFn?: typeof updateOrganizationExtractionSettings;
};

const SETTINGS_PATH = "/dashboard/settings/extraction";

export function createExtractionSettingsActionHandlers(
  dependencies: ExtractionSettingsActionDependencies,
): {
  updateExtractionSettingsAction: (formData: FormData) => Promise<void>;
} {
  const assertSameOriginFn = dependencies.assertSameOriginFn ?? (() => true);
  const updateOrganizationExtractionSettingsFn =
    dependencies.updateOrganizationExtractionSettingsFn ?? updateOrganizationExtractionSettings;

  async function updateExtractionSettingsAction(formData: FormData): Promise<void> {
    if (!(await assertSameOriginFn())) {
      dependencies.redirectFn(`${SETTINGS_PATH}?error=invalid_request`);
      return;
    }

    const auth = await dependencies.getAuthContextFn();
    if (!auth) {
      dependencies.redirectFn(`/login?redirect=${encodeURIComponent(SETTINGS_PATH)}`);
      return;
    }

    if (!dependencies.hasMinimumRoleFn(auth.role, "ADMIN")) {
      dependencies.redirectFn("/dashboard?error=forbidden");
      return;
    }

    try {
      const result = await updateOrganizationExtractionSettingsFn({
        organizationId: auth.organizationId,
        actorUserId: auth.userId,
        scanKeywordsText: readFormString(formData.get("scanKeywords")),
      });

      dependencies.revalidatePathFn(SETTINGS_PATH);
      dependencies.revalidatePathFn("/dashboard");

      if (result.kind === "no_changes") {
        dependencies.redirectFn(`${SETTINGS_PATH}?notice=no_changes`);
        return;
      }

      dependencies.redirectFn(`${SETTINGS_PATH}?notice=settings_updated`);
    } catch (error: unknown) {
      if (error instanceof ExtractionSettingsValidationError) {
        dependencies.redirectFn(`${SETTINGS_PATH}?error=${error.code}`);
        return;
      }

      throw error;
    }
  }

  return {
    updateExtractionSettingsAction,
  };
}

function readFormString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value : "";
}
