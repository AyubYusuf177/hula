/**
 * Safe validation of the mobile app's OAuth return URL (Section 13).
 *
 * After Google redirects to the backend callback and tokens are stored, the
 * callback tries to bounce the user straight back into Hula. The app supplies its
 * own return URL (from `expo-linking`'s `createURL`) at connect time; we store it
 * on the short-lived OAuth state and only redirect to it if it passes STRICT
 * validation here.
 *
 * Hard rule: NEVER create an open redirect. Only Hula's own app scheme and the
 * Expo development schemes are allowed. Arbitrary http/https targets are rejected —
 * so a stolen `state` can never turn the callback into a redirector to an
 * attacker's site.
 */

/** Schemes we will redirect back into. */
const ALLOWED_SCHEMES: readonly string[] = [
  "hulaai", // the app's own scheme (dev client / standalone builds)
  "exp", // Expo Go (exp://192.168.x.x:8081/--/…)
  "exp+hulaai", // Expo Go with a custom scheme
];

/** Max length we'll accept, to avoid pathological inputs. */
const MAX_LENGTH = 2048;

/**
 * PURE: return true only for a return URL Hula will redirect to. Accepts the app
 * scheme and Expo dev schemes; rejects http(s), missing scheme, and anything
 * oversized or malformed.
 */
export function isSafeAppReturnUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const url = value.trim();
  if (url.length === 0 || url.length > MAX_LENGTH) return false;

  // Extract the scheme (chars before the first ":") without a full URL parse,
  // since custom schemes like `exp+hulaai://` aren't parseable everywhere.
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  const scheme = match?.[1];
  if (!scheme) return false;
  return ALLOWED_SCHEMES.includes(scheme.toLowerCase());
}

/** Return the URL if safe, otherwise null. */
export function sanitizeAppReturnUrl(value: unknown): string | null {
  return isSafeAppReturnUrl(value) ? value.trim() : null;
}
