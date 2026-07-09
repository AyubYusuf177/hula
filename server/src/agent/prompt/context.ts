import type { UserProfile } from "../../users/types";

/**
 * Per-user context layer for the Hula prompt. Renders the known profile facts
 * into a compact block the model can use for personalization.
 *
 * Section 1: pure formatting placeholder — no persistence, no model call.
 */
export function buildUserContext(profile: UserProfile | undefined): string {
  if (!profile) return "No profile on file yet.";

  const lines: string[] = [];
  if (profile.displayName) lines.push(`Name: ${profile.displayName}`);
  if (profile.age !== undefined) lines.push(`Age: ${profile.age}`);
  if (profile.timezone) lines.push(`Timezone: ${profile.timezone}`);
  if (profile.locale) lines.push(`Locale: ${profile.locale}`);
  if (profile.country) lines.push(`Country: ${profile.country}`);
  if (profile.helpMost) lines.push(`Wants help most with: ${profile.helpMost}`);

  return lines.length > 0 ? lines.join("\n") : "No profile details on file yet.";
}
