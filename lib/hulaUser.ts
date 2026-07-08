/**
 * Shared display-name / initials resolution for Home and Account Overview.
 *
 * Precedence: local profile override → Clerk fullName → firstName (+ lastName)
 * → email prefix → "User". Keeping this in one place means Home and Settings
 * never drift.
 */

/** The minimal slice of the Clerk user we read (decoupled from the SDK type). */
export type ClerkUserLike =
  | {
      fullName?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      primaryEmailAddress?: { emailAddress?: string | null } | null;
    }
  | null
  | undefined;

/** Resolves the name to show, honouring a local override first. */
export function resolveDisplayName(user: ClerkUserLike, override?: string | null): string {
  const name = override?.trim();
  if (name) return name;
  if (user?.fullName) return user.fullName;
  const parts = [user?.firstName, user?.lastName].filter(Boolean);
  if (parts.length) return parts.join(' ');
  const email = user?.primaryEmailAddress?.emailAddress;
  if (email) return email.split('@')[0];
  return 'User';
}

/** Two-letter initials derived from the resolved display name (or email). */
export function resolveInitials(user: ClerkUserLike, override?: string | null): string {
  const name = override?.trim()
    || user?.fullName
    || [user?.firstName, user?.lastName].filter(Boolean).join(' ');
  if (name) {
    const words = name.trim().split(/\s+/);
    const first = words[0]?.[0] ?? '';
    const second = words[1]?.[0] ?? '';
    return (first + second).toUpperCase() || 'HU';
  }
  const email = user?.primaryEmailAddress?.emailAddress;
  if (email) return email.slice(0, 2).toUpperCase();
  return 'HU';
}
