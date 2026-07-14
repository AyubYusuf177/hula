import { getConnectionForUserProvider } from "./connections";
import { findConsumedOAuthState } from "./oauthState";

/**
 * OAuth callback REPLAY resolution (Section 18 real-device fix).
 *
 * THE REAL FAILURE THIS FIXES. On a real device, reconnecting Google Calendar
 * logged `callback connected` (scopes stored, connection live) and then, moments
 * later, `callback rejected state` — and the phone showed "Couldn't connect
 * Google Calendar". Both log lines were correct. The browser issued the SAME
 * callback GET twice; the first consumed the single-use state and connected the
 * account, and the second found the state already consumed and rendered the
 * error page over the top of a success that had genuinely happened.
 *
 * WHY THE BROWSER ASKS TWICE. The callback is a plain GET, and a GET can be
 * re-issued by the browser for reasons entirely outside our control: a bfcache
 * restore, a pull-to-refresh, a history restore after the `hula://` deep link
 * prompt is dismissed, or a speculative/prefetch load. The success page's own
 * auto-redirect makes a restore more likely, because it navigates away
 * immediately after render. So the second request is not a bug we can delete —
 * it is a condition we must be correct under.
 *
 * THE DISTINCTION THAT MAKES THIS SAFE. `consumed` means the exchange was
 * STARTED, not that it succeeded — a state consumed by a callback whose token
 * exchange then failed is also `consumed`. Rendering success for that would be a
 * lie. So this module never treats the state row as evidence of anything. It
 * asks the authoritative source — the connection itself — and requires PROOF
 * that this exact callback completed:
 *
 *   1. the state exists, matches the provider, and is `consumed`;
 *   2. it was consumed RECENTLY (a genuine double-callback lands in seconds);
 *   3. a `connected` connection exists for that user + provider;
 *   4. its `connectedAt` is at/after the state's `consumedAt` — i.e. it was
 *      established BY this callback, not left over from an earlier grant.
 *
 * Step 4 is what stops the nastiest false positive: a user who was already
 * connected, reconnects, and whose token exchange FAILS. The old connection is
 * still `connected`, but its `connectedAt` predates this attempt, so the replay
 * correctly fails closed rather than reporting a success that never happened.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It performs NO token exchange (it is never
 * even given the PKCE verifier — `findConsumedOAuthState` withholds it), writes
 * NO credentials, and creates NO connection. It is a pure read that decides
 * which PAGE to render. Single-use state protection, CSRF protection, expiry,
 * provider filtering, and credential encryption are all untouched: the atomic
 * `pending → consumed` claim in `consumeOAuthState` still wins exactly once, and
 * that remains the only path that can ever exchange a code.
 */

/**
 * How long after a successful callback an exact replay still renders success.
 *
 * A real double-callback arrives within seconds. This bounds the window in which
 * a leaked state token could be used to observe "this account is connected" —
 * already a minor leak (the page carries no secrets), and one that requires the
 * unguessable state in the first place. Short enough to be tight, long enough to
 * cover a slow deep-link prompt the user takes a moment to dismiss.
 */
export const OAUTH_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Clock skew allowance between `consumedAt` and `connectedAt`.
 *
 * Both are written by this backend within the same request, `consumedAt` first,
 * so `connectedAt >= consumedAt` holds naturally. The small allowance only
 * guards against sub-millisecond ordering noise across separate statements — it
 * is far too small to let a stale connection from an earlier grant qualify.
 */
const CLOCK_SKEW_MS = 2_000;

/** The safe result of a proven replay: enough to re-render the same page. */
export interface OAuthReplayResult {
  /** The validated app deep-link recorded at connect time (re-validate before use). */
  appReturnUrl: string | null;
}

/** Injectable dependencies so the whole decision is testable with NO database. */
export interface OAuthReplayDeps {
  findConsumedState?: typeof findConsumedOAuthState;
  getConnection?: (
    userId: string,
    provider: string,
  ) => Promise<{ status: string; connectedAt: Date | string | null } | null>;
  now?: Date;
}

/** PURE: read a timestamp that may arrive as a Date or an ISO string. */
function toMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Decide whether this callback is an EXACT replay of an already-SUCCESSFUL one.
 *
 * Returns the details needed to re-render the original success page, or `null`
 * — meaning fail closed, and the caller renders its normal error page. Never
 * throws: a lookup failure resolves to `null`, so an unprovable replay is always
 * a failure rather than an accidental success.
 */
export async function resolveOAuthCallbackReplay(
  state: string,
  provider: string,
  deps: OAuthReplayDeps = {},
): Promise<OAuthReplayResult | null> {
  const findState = deps.findConsumedState ?? findConsumedOAuthState;
  const getConnection = deps.getConnection ?? getConnectionForUserProvider;
  const nowMs = (deps.now ?? new Date()).getTime();

  try {
    // 1. The state must exist, match the provider, and already be consumed.
    //    Missing / wrong-provider / pending / expired all return null here.
    const consumed = await findState(state, provider);
    if (!consumed) return null;

    // 2. It must have been consumed recently.
    const consumedMs = toMs(consumed.consumedAt);
    if (consumedMs === null) return null;
    if (nowMs - consumedMs > OAUTH_REPLAY_WINDOW_MS) return null;
    // A consumedAt meaningfully in the future is nonsense — refuse it.
    if (consumedMs - nowMs > CLOCK_SKEW_MS) return null;

    // 3 + 4. The connection must exist, be live, and have been established BY
    //        this callback rather than by an earlier grant.
    const connection = await getConnection(consumed.userId, provider);
    if (!connection || connection.status !== "connected") return null;

    const connectedMs = toMs(connection.connectedAt);
    if (connectedMs === null) return null;
    if (connectedMs < consumedMs - CLOCK_SKEW_MS) return null;

    return { appReturnUrl: consumed.appReturnUrl };
  } catch {
    // Unprovable → not a success. Fail closed.
    return null;
  }
}
