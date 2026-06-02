"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuthContext, hasMinimumRole } from "@/lib/auth/server";
import { createExtractionSettingsActionHandlers } from "@/lib/extraction/settings-actions";
import { assertSameOriginServerAction } from "@/lib/security/server-action";

const extractionSettingsActionHandlers = createExtractionSettingsActionHandlers({
  getAuthContextFn: getAuthContext,
  hasMinimumRoleFn: hasMinimumRole,
  redirectFn: redirect,
  revalidatePathFn: revalidatePath,
  assertSameOriginFn: assertSameOriginServerAction,
});

export const updateExtractionSettingsAction =
  extractionSettingsActionHandlers.updateExtractionSettingsAction;
