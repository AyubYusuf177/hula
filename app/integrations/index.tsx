import { useAuth } from '@clerk/clerk-expo';
import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  IntegrationCard,
  IntegrationCategory,
  IntegrationDetailsSheet,
  IntegrationHero,
  RequestIntegrationCard,
} from '@/components/integrations';
import { hula } from '@/constants/theme';
import {
  getIntegrationProvider,
  INTEGRATION_PROVIDERS,
} from '@/data/integrations';
import {
  connectGmail,
  connectAsana,
  connectGoogleCalendar,
  connectTodoist,
  disconnectGmail,
  disconnectAsana,
  disconnectGoogleCalendar,
  disconnectTodoist,
  fetchUserIntegrations,
  GMAIL_PROVIDER,
  ASANA_PROVIDER,
  AsanaNotConfiguredError,
  GmailNotConfiguredError,
  GOOGLE_CALENDAR_PROVIDER,
  GoogleCalendarNotConfiguredError,
  MissingApiUrlError,
  TODOIST_PROVIDER,
  TodoistNotConfiguredError,
  type IntegrationStatus,
} from '@/lib/hulaApi';
import {
  deriveIntegrationView,
  isStaleResponse,
  shouldRefetchOnAppState,
  shouldStartRequest,
  type IntegrationView,
} from '@/lib/integrationStatus';
import {
  getMemoryStatuses,
  markProviderDisconnected,
} from '@/lib/integrationStatusCache';
import { loadCachedStatuses, persistStatuses } from '@/lib/integrationStatusStore';

// Lets a returning auth session dismiss cleanly where the platform supports it.
WebBrowser.maybeCompleteAuthSession();

const font = hula.typography.fontFamily;

/** Provider ids the screen renders (drives which statuses we care about). */
const PROVIDER_IDS = new Set(INTEGRATION_PROVIDERS.map((p) => p.id));

/**
 * Which providers can actually START an OAuth flow, and how.
 *
 * A table rather than a chain of `if (providerId === ...)`: connect and disconnect
 * were each their own branch, so every new provider meant editing several places,
 * and a provider present in the catalog but missing from ONE of them would render
 * a card that fails on tap or silently no-ops on disconnect. Membership here is the
 * single source of truth for "this integration is really connectable" — a provider
 * with no connect route can never present as available.
 */
type ConnectStarter = (
  token: string,
  returnUrl: string,
) => Promise<{ authorizationUrl: string }>;

const CONNECT_STARTERS: Record<string, ConnectStarter | undefined> = {
  [GOOGLE_CALENDAR_PROVIDER]: (token, appReturnUrl) =>
    connectGoogleCalendar(token, { appReturnUrl }),
  [GMAIL_PROVIDER]: (token, appReturnUrl) => connectGmail(token, { appReturnUrl }),
  [TODOIST_PROVIDER]: (token, appReturnUrl) => connectTodoist(token, { appReturnUrl }),
  [ASANA_PROVIDER]: (token, appReturnUrl) => connectAsana(token, { appReturnUrl }),
};

const DISCONNECTERS: Record<
  string,
  ((token: string) => Promise<{ ok: boolean; changed: boolean }>) | undefined
> = {
  [GOOGLE_CALENDAR_PROVIDER]: disconnectGoogleCalendar,
  [GMAIL_PROVIDER]: disconnectGmail,
  [TODOIST_PROVIDER]: disconnectTodoist,
  [ASANA_PROVIDER]: disconnectAsana,
};

type StatusMap = Record<string, IntegrationStatus | null>;

/** Build the screen's StatusMap from a backend/cache status list. */
function toStatusMap(list: IntegrationStatus[]): StatusMap {
  const next: StatusMap = {};
  for (const item of list) {
    if (PROVIDER_IDS.has(item.provider)) next[item.provider] = item;
  }
  return next;
}

/**
 * Integrations screen (Section 13).
 *
 * An ambient hero, category cards, a dismissible details sheet, and the Google
 * Calendar OAuth connect flow. The backend is ALWAYS the source of truth for
 * connection state — a provider is marked connected only after re-reading status,
 * never because a browser opened.
 *
 * Status is fetched EXACTLY when it should be — on focus, on a real
 * background→active transition, after the OAuth session returns, and on manual
 * refresh — with an in-flight guard + dedupe so repeated renders never spam
 * `GET /v1/me/integrations`.
 */
export default function IntegrationsScreen() {
  const router = useRouter();
  const { getToken, userId } = useAuth();

  // Seed synchronously from the shared in-memory cache (warmed by Home's prefetch
  // or a previous visit this session) so returning renders instantly, scoped to
  // the current Clerk user. Null when nothing is cached for THIS user yet.
  const initialCached = getMemoryStatuses(userId);
  const [statuses, setStatuses] = useState<StatusMap>(() =>
    initialCached ? toStatusMap(initialCached) : {},
  );
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Gates the final cards behind the first KNOWN status (cache OR backend) so a
  // user NEVER sees a disconnected/connect-button flash before truth arrives.
  // Cache-first: if we already have last-known truth in memory, skip the skeleton.
  const [hydrated, setHydrated] = useState(initialCached != null);

  const mounted = useRef(true);
  // Keep the latest userId for the (dep-free) refresh/persist paths.
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  // Keep the latest getToken without making refresh depend on its identity (Clerk
  // can hand back a new function each render, which is what caused the old loop).
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  // Request coordinator: dedupe + in-flight guard + stale-response id.
  const coord = useRef({ inFlight: false, lastStartedAt: 0, latestId: 0 });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Cache-first: if nothing was seeded from memory, try the user-scoped disk
  // cache while the background refresh runs. Only applied if a network result
  // hasn't already landed, and never shown before Clerk resolves the user id.
  useEffect(() => {
    if (!userId || hydrated) return;
    let active = true;
    loadCachedStatuses(userId).then((cached) => {
      if (!active || !cached || !mounted.current) return;
      // A newer network read may have won the race — don't clobber it.
      setStatuses((prev) => (Object.keys(prev).length > 0 ? prev : toStatusMap(cached)));
      setHydrated(true);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  /**
   * Re-read backend truth for every configured provider. Stable identity (no deps)
   * so effects that call it don't re-subscribe on every render. `force` bypasses
   * only the time-window dedupe (manual refresh), never the in-flight guard.
   */
  const refreshStatuses = useCallback(async (force = false) => {
    const now = Date.now();
    if (coord.current.inFlight) return;
    if (!force && !shouldStartRequest(coord.current, now)) return;

    const requestId = coord.current.latestId + 1;
    coord.current = { inFlight: true, lastStartedAt: now, latestId: requestId };

    try {
      const token = await getTokenRef.current();
      if (!token) throw new Error('Not signed in');
      const all = await fetchUserIntegrations(token);
      if (!mounted.current) return;
      // Ignore a response that a newer request has already superseded.
      if (isStaleResponse(requestId, coord.current.latestId)) return;

      setStatuses(toStatusMap(all));
      // Cache the fresh truth so the next open (this session or the next) renders
      // instantly. Only ever written after a SUCCESSFUL read — a failure below
      // never touches the cache, so cards stay in their last known-good state.
      void persistStatuses(userIdRef.current, all);
    } catch (err) {
      // A status read failure leaves cards in their last known state rather than
      // flipping them to "connected"; the sheet's own actions surface errors.
      if (__DEV__) console.warn('[Integrations] status refresh failed:', err);
    } finally {
      coord.current.inFlight = false;
      // The first settled read (success OR failure) unblocks rendering; we never
      // hang on the skeleton, and subsequent refreshes never re-show it.
      if (mounted.current) setHydrated(true);
    }
  }, []);

  // Fetch once each time the screen focuses.
  useFocusEffect(
    useCallback(() => {
      refreshStatuses();
    }, [refreshStatuses]),
  );

  // Fetch once on a REAL background/inactive → active transition (covers returning
  // to the app), never merely because AppState is currently active.
  useEffect(() => {
    let prev = AppState.currentState;
    const sub = AppState.addEventListener('change', (nextState) => {
      if (shouldRefetchOnAppState(prev, nextState)) refreshStatuses();
      prev = nextState;
    });
    return () => sub.remove();
  }, [refreshStatuses]);

  const viewFor = useCallback(
    (providerId: string): IntegrationView =>
      deriveIntegrationView(statuses[providerId] ?? null, {
        connecting: connectingId === providerId,
        errored: Boolean(errors[providerId]),
      }),
    [statuses, connectingId, errors],
  );

  // Split providers by backend truth so each lands in its section. Only
  // meaningful once hydrated — before that we render a skeleton, never these.
  const connectedProviders = useMemo(
    () => INTEGRATION_PROVIDERS.filter((p) => statuses[p.id]?.connected),
    [statuses],
  );
  const availableProviders = useMemo(
    () => INTEGRATION_PROVIDERS.filter((p) => !statuses[p.id]?.connected),
    [statuses],
  );

  const openSheet = (providerId: string) => {
    setErrors((prev) => ({ ...prev, [providerId]: null }));
    setSelectedId(providerId);
  };

  const onConnect = async (providerId: string) => {
    if (connectingId) return;
    setErrors((prev) => ({ ...prev, [providerId]: null }));
    setConnectingId(providerId);
    try {
      const token = await getTokenRef.current();
      if (!token) throw new Error('Not signed in');

      // Each live provider has its own real OAuth flow. A provider absent from
      // this table has no connect route yet and must never present as available.
      const starter = CONNECT_STARTERS[providerId];
      if (!starter) {
        throw new Error('This integration isn’t available yet.');
      }

      // A deep link back into this screen so the backend callback can bounce the
      // user straight home. The provider still redirects to the backend callback
      // first.
      const returnUrl = Linking.createURL('/integrations');
      const { authorizationUrl } = await starter(token, returnUrl);

      // Prefer the auth session (auto-dismisses on the return-URL scheme); fall
      // back to a plain system-browser open if it isn't available. Never a WebView.
      if (WebBrowser.openAuthSessionAsync) {
        await WebBrowser.openAuthSessionAsync(authorizationUrl, returnUrl);
      } else {
        await WebBrowser.openBrowserAsync(authorizationUrl);
      }
    } catch (err) {
      if (__DEV__) console.warn('[Integrations] connect failed:', err);
      const message =
        err instanceof GoogleCalendarNotConfiguredError ||
        err instanceof GmailNotConfiguredError ||
        err instanceof TodoistNotConfiguredError
        || err instanceof AsanaNotConfiguredError
          ? 'This connection isn’t available yet. Please try again later.'
          : err instanceof MissingApiUrlError
            ? 'Hula backend URL is not configured.'
            : 'Couldn’t start the connection. Please try again.';
      if (mounted.current) setErrors((prev) => ({ ...prev, [providerId]: message }));
    } finally {
      if (mounted.current) setConnectingId(null);
      // Re-read backend truth once to learn the real outcome (never assume).
      await refreshStatuses(true);
    }
  };

  const onDisconnect = async (providerId: string) => {
    if (connectingId) return;
    setErrors((prev) => ({ ...prev, [providerId]: null }));
    setConnectingId(providerId);
    try {
      const token = await getTokenRef.current();
      if (!token) throw new Error('Not signed in');
      await DISCONNECTERS[providerId]?.(token);
      // Optimistically flip ONLY this provider in state + cache so the change is
      // instant; the refresh below still confirms backend truth. Other providers
      // are left untouched.
      if (mounted.current) {
        setStatuses((prev) => {
          const current = prev[providerId];
          if (!current) return prev;
          return { ...prev, [providerId]: { ...current, connectionStatus: 'disconnected', connected: false, providerAccountEmail: null, connectedAt: null } };
        });
      }
      const cached = getMemoryStatuses(userIdRef.current);
      if (cached) {
        void persistStatuses(userIdRef.current, markProviderDisconnected(cached, providerId));
      }
    } catch (err) {
      if (__DEV__) console.warn('[Integrations] disconnect failed:', err);
      if (mounted.current) {
        setErrors((prev) => ({
          ...prev,
          [providerId]: 'Couldn’t disconnect. Please try again.',
        }));
      }
    } finally {
      if (mounted.current) setConnectingId(null);
      await refreshStatuses(true);
    }
  };

  const selectedProvider = selectedId ? getIntegrationProvider(selectedId) : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <StatusBar style="light" />
      <AmbientGlow />

      {/* Header: back only — the title lives in the scroll body, left-aligned. */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color={hula.colors.text.primary} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Integrations</Text>
        <Text style={styles.subtitle}>Connect the apps Hula can work with.</Text>

        <View style={styles.heroWrap}>
          <IntegrationHero />
        </View>

        {/* Never render final cards until backend truth has arrived — a skeleton
            holds the space so no disconnected state can flash. */}
        {!hydrated ? (
          <SkeletonSection />
        ) : (
          <>
            {connectedProviders.length > 0 ? (
              <IntegrationCategory label="Connected">
                {connectedProviders.map((provider) => (
                  <IntegrationCard
                    key={provider.id}
                    provider={provider}
                    view={viewFor(provider.id)}
                    onPress={() => openSheet(provider.id)}
                  />
                ))}
              </IntegrationCategory>
            ) : null}

            <IntegrationCategory label="Available">
              {availableProviders.map((provider) => (
                <IntegrationCard
                  key={provider.id}
                  provider={provider}
                  view={viewFor(provider.id)}
                  onPress={() => openSheet(provider.id)}
                />
              ))}
              <RequestIntegrationCard />
            </IntegrationCategory>
          </>
        )}
      </ScrollView>

      <IntegrationDetailsSheet
        visible={Boolean(selectedProvider)}
        provider={selectedProvider ?? null}
        view={selectedId ? viewFor(selectedId) : deriveIntegrationView(null)}
        errorText={selectedId ? errors[selectedId] ?? null : null}
        onClose={() => setSelectedId(null)}
        onConnect={() => selectedId && onConnect(selectedId)}
        onDisconnect={() => selectedId && onDisconnect(selectedId)}
      />
    </SafeAreaView>
  );
}

/** A pulsing skeleton that reserves the cards' space during the first load. */
function SkeletonSection() {
  const pulse = useSharedValue(0.5);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 900 }), -1, true);
  }, [pulse]);
  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <View style={styles.skeletonSection}>
      <Animated.View style={[styles.skeletonLabel, pulseStyle]} />
      {[0, 1].map((i) => (
        <Animated.View key={i} style={[styles.skeletonCard, pulseStyle]}>
          <View style={styles.skeletonIcon} />
          <View style={styles.skeletonTextCol}>
            <View style={styles.skeletonLineWide} />
            <View style={styles.skeletonLineNarrow} />
          </View>
        </Animated.View>
      ))}
    </View>
  );
}

/** Soft ambient purple/blue bloom, clipped so it never scrolls horizontally. */
function AmbientGlow() {
  return (
    <View pointerEvents="none" style={styles.glowLayer}>
      <View style={[styles.glow, styles.glowPurple]} />
      <View style={[styles.glow, styles.glowBlue]} />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: hula.colors.voidBlack,
  },
  glowLayer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  glow: {
    position: 'absolute',
    width: 340,
    height: 340,
    borderRadius: 170,
    ...Platform.select({
      ios: { shadowOpacity: 0.7, shadowRadius: 100, shadowOffset: { width: 0, height: 0 } },
      default: {},
    }),
  },
  glowPurple: {
    left: -160,
    top: '18%',
    backgroundColor: 'rgba(123,77,255,0.16)',
    shadowColor: hula.glow.purple,
  },
  glowBlue: {
    right: -160,
    top: '8%',
    backgroundColor: 'rgba(62,123,255,0.12)',
    shadowColor: hula.glow.blue,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: hula.spacing.xl,
    paddingTop: hula.spacing.sm,
    paddingBottom: hula.spacing.sm,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    paddingHorizontal: hula.spacing.xl,
    paddingBottom: hula.spacing['3xl'],
  },
  title: {
    marginTop: hula.spacing.sm,
    fontFamily: font.bold,
    fontSize: 34,
    color: hula.colors.text.primary,
  },
  subtitle: {
    marginTop: hula.spacing.xs,
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 21,
    color: hula.colors.text.tertiary,
  },
  heroWrap: {
    marginTop: hula.spacing.xl,
  },
  skeletonSection: {
    marginTop: hula.spacing['2xl'],
    gap: hula.spacing.md,
  },
  skeletonLabel: {
    width: 96,
    height: 12,
    borderRadius: 6,
    backgroundColor: 'rgba(150,160,210,0.14)',
    marginBottom: hula.spacing.sm,
  },
  skeletonCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: hula.spacing.md,
    paddingVertical: hula.spacing.lg,
    paddingHorizontal: hula.spacing.lg,
    borderRadius: hula.radius.tile,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
  },
  skeletonIcon: {
    width: 54,
    height: 54,
    borderRadius: 16,
    backgroundColor: 'rgba(150,160,210,0.12)',
  },
  skeletonTextCol: {
    flex: 1,
    gap: 8,
  },
  skeletonLineWide: {
    width: '55%',
    height: 14,
    borderRadius: 7,
    backgroundColor: 'rgba(150,160,210,0.16)',
  },
  skeletonLineNarrow: {
    width: '80%',
    height: 11,
    borderRadius: 6,
    backgroundColor: 'rgba(150,160,210,0.10)',
  },
  pressed: {
    opacity: 0.6,
  },
});
