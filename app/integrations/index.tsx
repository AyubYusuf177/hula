import { useAuth } from '@clerk/clerk-expo';
import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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
  integrationsByCategory,
} from '@/data/integrations';
import {
  connectGoogleCalendar,
  disconnectGoogleCalendar,
  fetchUserIntegrations,
  GOOGLE_CALENDAR_PROVIDER,
  GoogleCalendarNotConfiguredError,
  MissingApiUrlError,
  type IntegrationStatus,
} from '@/lib/hulaApi';
import {
  deriveIntegrationView,
  isStaleResponse,
  shouldRefetchOnAppState,
  shouldStartRequest,
  type IntegrationView,
} from '@/lib/integrationStatus';

// Lets a returning auth session dismiss cleanly where the platform supports it.
WebBrowser.maybeCompleteAuthSession();

const font = hula.typography.fontFamily;

/** Provider ids the screen renders (drives which statuses we care about). */
const PROVIDER_IDS = new Set(INTEGRATION_PROVIDERS.map((p) => p.id));

type StatusMap = Record<string, IntegrationStatus | null>;

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
  const { getToken } = useAuth();

  const [statuses, setStatuses] = useState<StatusMap>({});
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const mounted = useRef(true);
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

      const next: StatusMap = {};
      for (const item of all) {
        if (PROVIDER_IDS.has(item.provider)) next[item.provider] = item;
      }
      setStatuses(next);
    } catch (err) {
      // A status read failure leaves cards in their last known state rather than
      // flipping them to "connected"; the sheet's own actions surface errors.
      if (__DEV__) console.warn('[Integrations] status refresh failed:', err);
    } finally {
      coord.current.inFlight = false;
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

  // Connected provider configs drive the hero orbit (backend truth only).
  const connectedProviders = useMemo(
    () => INTEGRATION_PROVIDERS.filter((p) => statuses[p.id]?.connected),
    [statuses],
  );

  const categories = useMemo(() => integrationsByCategory(), []);

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

      // Only Google Calendar has a real OAuth flow in this section.
      if (providerId !== GOOGLE_CALENDAR_PROVIDER) {
        throw new Error('This integration isn’t available yet.');
      }

      // A deep link back into this screen so the backend callback can bounce the
      // user straight home. Google still redirects to the backend callback first.
      const returnUrl = Linking.createURL('/integrations');
      const { authorizationUrl } = await connectGoogleCalendar(token, {
        appReturnUrl: returnUrl,
      });

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
        err instanceof GoogleCalendarNotConfiguredError
          ? 'Google Calendar connect isn’t available yet. Please try again later.'
          : err instanceof MissingApiUrlError
            ? 'Hula backend URL is not configured.'
            : 'Couldn’t start the Google connection. Please try again.';
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
      if (providerId === GOOGLE_CALENDAR_PROVIDER) {
        await disconnectGoogleCalendar(token);
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

      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={10}
          style={({ pressed }) => [styles.backBtn, pressed && styles.pressed]}
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={22} color={hula.colors.text.primary} />
        </Pressable>
        <Text style={styles.headerTitle}>Integrations</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
      >
        <IntegrationHero connectedProviders={connectedProviders} />

        {/* Categories render immediately from static data (no loading spinner →
            no layout shift); status just decorates each card as it arrives. */}
        {categories.map((group) => (
          <IntegrationCategory key={group.category} label={group.label}>
            {group.providers.map((provider) => (
              <IntegrationCard
                key={provider.id}
                provider={provider}
                view={viewFor(provider.id)}
                onPress={() => openSheet(provider.id)}
              />
            ))}
          </IntegrationCategory>
        ))}

        <RequestIntegrationCard />
      </ScrollView>

      <IntegrationDetailsSheet
        visible={Boolean(selectedProvider)}
        provider={selectedProvider ?? null}
        view={selectedId ? viewFor(selectedId) : deriveIntegrationView(null)}
        errorText={selectedId ? errors[selectedId] ?? null : null}
        onClose={() => setSelectedId(null)}
        onConnect={() => selectedId && onConnect(selectedId)}
        onDisconnect={() => selectedId && onDisconnect(selectedId)}
        onRefresh={() => refreshStatuses(true)}
      />
    </SafeAreaView>
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
    justifyContent: 'space-between',
    paddingHorizontal: hula.spacing.xl,
    paddingTop: hula.spacing.sm,
    paddingBottom: hula.spacing.md,
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
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontFamily: font.bold,
    fontSize: 22,
    color: hula.colors.text.primary,
  },
  headerSpacer: {
    width: 40,
    height: 40,
  },
  body: {
    paddingHorizontal: hula.spacing.xl,
    paddingBottom: hula.spacing['3xl'],
  },
  pressed: {
    opacity: 0.6,
  },
});
