import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
// No custom `easing` is passed to withTiming: in Expo Go a JS easing fn isn't a
// worklet and crashes on the UI thread, so we use withTiming's default easing.
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hula } from '@/constants/theme';
import { authorizationRedirectCopy, type IntegrationProviderConfig } from '@/data/integrations';
import { deriveSheetCopy, type IntegrationView } from '@/lib/integrationStatus';
import { IntegrationProviderIcon } from './IntegrationProviderIcon';

const font = hula.typography.fontFamily;
const SCREEN_H = Dimensions.get('window').height;

/** Drag distance / velocity past which a downward swipe dismisses the sheet. */
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 800;

/**
 * Simplified integration details sheet (Integrations V2).
 *
 * Deliberately SHORT so it always fits without scrolling — there is no
 * ScrollView, so the swipe-down gesture never fights scroll and dismissal is
 * reliable every time. The whole card is a drag zone; the X button and a
 * backdrop tap also dismiss.
 *
 * Connected: icon → name → EMERALD "Connected" → honest read-only copy →
 * connected account email → one Disconnect action (never red).
 * Disconnected: desaturated icon → "Not connected" → copy → Connect button →
 * a small OAuth disclosure.
 *
 * Connection state is EMERALD only (never red); a provider's brand colour lives
 * only inside its product icon; CONNECTED copy comes only from backend truth, so
 * there is no reconnect/disconnected flash.
 */
export function IntegrationDetailsSheet({
  visible,
  provider,
  view,
  errorText,
  onClose,
  onConnect,
  onDisconnect,
}: {
  visible: boolean;
  provider: IntegrationProviderConfig | null;
  view: IntegrationView;
  errorText: string | null;
  onClose: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const insets = useSafeAreaInsets();
  const translateY = useSharedValue(SCREEN_H);

  // Keep the latest onClose so the worklet's runOnJS never fires a stale one.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (visible) {
      translateY.value = SCREEN_H;
      translateY.value = withSpring(0, { damping: 24, stiffness: 220, mass: 0.9 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const dismiss = () => {
    translateY.value = withTiming(
      SCREEN_H,
      { duration: 240 },
      (finished) => {
        if (finished) runOnJS(onCloseRef.current)();
      },
    );
  };

  const settle = () => {
    translateY.value = withSpring(0, { damping: 24, stiffness: 220, mass: 0.9 });
  };

  // The whole sheet is one drag zone — no scroll lives inside it, so the gesture
  // never competes with a ScrollView. That's what makes dismissal reliable.
  const pan = Gesture.Pan()
    .activeOffsetY(8)
    .failOffsetX([-24, 24])
    .onUpdate((e) => {
      if (e.translationY > 0) translateY.value = e.translationY;
    })
    .onEnd((e) => {
      if (e.translationY > DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY) {
        runOnJS(dismiss)();
      } else {
        runOnJS(settle)();
      }
    });

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateY.value, [0, SCREEN_H], [1, 0], Extrapolation.CLAMP),
  }));
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  if (!provider) return null;

  const connected = view.state === 'connected';
  const busy = view.state === 'connecting';
  const copy = deriveSheetCopy(view, provider);

  const confirmDisconnect = () => {
    Alert.alert(
      provider.disconnectLabel,
      `Hula will disconnect your ${provider.displayName} account and remove its stored access. You can reconnect anytime.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disconnect', style: 'destructive', onPress: onDisconnect },
      ],
    );
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={dismiss}>
      <View style={styles.overlay}>
        <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
          <BlurView intensity={28} tint="dark" style={StyleSheet.absoluteFill} />
          <Pressable
            style={styles.backdropTint}
            onPress={dismiss}
            accessibilityLabel="Close"
          />
        </Animated.View>

        <Animated.View style={[styles.sheetWrap, sheetStyle]}>
          <GestureDetector gesture={pan}>
            <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, hula.spacing.lg) }]}>
              <View style={styles.handleHitbox}>
                <View style={styles.handle} />
              </View>

              <View style={styles.headerRow}>
                <Pressable
                  onPress={dismiss}
                  hitSlop={10}
                  style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
                  accessibilityLabel="Close"
                >
                  <Ionicons name="close" size={22} color={hula.colors.text.primary} />
                </Pressable>
              </View>

              <View style={styles.identity}>
                <View style={[styles.bigIcon, !connected && styles.bigIconMuted]}>
                  <IntegrationProviderIcon provider={provider} size={52} dimmed={!connected} />
                </View>

                <Text style={styles.heading}>{copy.heading}</Text>

                <View style={styles.statusRow}>
                  {connected ? (
                    <Ionicons
                      name="checkmark-circle"
                      size={16}
                      color={hula.status.success}
                    />
                  ) : (
                    <View style={styles.statusDot} />
                  )}
                  <Text
                    style={[styles.statusText, connected && styles.statusTextConnected]}
                  >
                    {connected
                      ? view.partial
                        ? 'Connected with limited access'
                        : 'Connected'
                      : 'Not connected'}
                  </Text>
                </View>

                <Text style={styles.paragraph}>{copy.body}</Text>
              </View>

              {connected && view.accountLabel ? (
                <View style={styles.accountCard}>
                  <Text style={styles.accountLabel}>Connected account</Text>
                  <Text style={styles.accountEmail} numberOfLines={1}>
                    {view.accountLabel}
                  </Text>
                </View>
              ) : null}

              {errorText ? <Text style={styles.error}>{errorText}</Text> : null}

              <View style={styles.footer}>
                {connected ? (
                  <Pressable
                    onPress={confirmDisconnect}
                    disabled={busy}
                    style={({ pressed }) => [styles.disconnectBtn, pressed && styles.pressed]}
                  >
                    {busy ? (
                      <ActivityIndicator color={hula.colors.text.primary} />
                    ) : (
                      <Text style={styles.disconnectText}>Disconnect</Text>
                    )}
                  </Pressable>
                ) : (
                  <>
                    <Pressable
                      onPress={onConnect}
                      disabled={busy}
                      style={({ pressed }) => [styles.connectBtn, pressed && styles.pressed]}
                    >
                      {busy ? (
                        <ActivityIndicator color={hula.button.solidText} />
                      ) : (
                        <>
                          <IntegrationProviderIcon provider={provider} size={18} />
                          <Text style={styles.connectText}>{provider.connectLabel}</Text>
                        </>
                      )}
                    </Pressable>
                    <View style={styles.redirectNote}>
                      <Ionicons
                        name="lock-closed"
                        size={13}
                        color={hula.colors.text.tertiary}
                      />
                      <Text style={styles.redirectText}>
                        {authorizationRedirectCopy(provider)}
                      </Text>
                    </View>
                  </>
                )}
              </View>
            </View>
          </GestureDetector>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdropTint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(2,3,10,0.55)',
  },
  sheetWrap: {
    // Content is short by design; this cap only guards very small screens.
    maxHeight: '88%',
  },
  sheet: {
    backgroundColor: '#0C1022',
    borderTopLeftRadius: hula.radius.card,
    borderTopRightRadius: hula.radius.card,
    borderWidth: 1,
    borderColor: hula.glass.cardBorder,
    paddingHorizontal: hula.spacing.xl,
    paddingTop: hula.spacing.sm,
  },
  handleHitbox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: hula.spacing.xs,
    paddingBottom: hula.spacing.sm,
  },
  handle: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(150,160,210,0.45)',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identity: {
    alignItems: 'center',
    paddingTop: hula.spacing.sm,
  },
  bigIcon: {
    width: 84,
    height: 84,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(150,160,210,0.16)',
    marginBottom: hula.spacing.md,
  },
  bigIconMuted: {
    backgroundColor: 'rgba(150, 160, 210, 0.05)',
    borderColor: 'rgba(150, 160, 210, 0.12)',
  },
  heading: {
    fontFamily: font.bold,
    fontSize: 23,
    color: hula.colors.text.primary,
    textAlign: 'center',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: hula.colors.text.faint,
  },
  statusText: {
    fontFamily: font.medium,
    fontSize: 14,
    color: hula.colors.text.tertiary,
  },
  statusTextConnected: {
    color: hula.status.success,
  },
  paragraph: {
    marginTop: hula.spacing.md,
    fontFamily: font.regular,
    fontSize: 14.5,
    lineHeight: 21,
    color: hula.colors.text.secondary,
    textAlign: 'center',
  },
  accountCard: {
    marginTop: hula.spacing.xl,
    paddingVertical: hula.spacing.md,
    paddingHorizontal: hula.spacing.lg,
    borderRadius: hula.radius.tile,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
  },
  accountLabel: {
    fontFamily: font.regular,
    fontSize: 12,
    color: hula.colors.text.tertiary,
  },
  accountEmail: {
    marginTop: 2,
    fontFamily: font.medium,
    fontSize: 15,
    color: hula.colors.text.primary,
  },
  error: {
    alignSelf: 'stretch',
    marginTop: hula.spacing.lg,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    color: hula.status.attention,
    textAlign: 'center',
  },
  footer: {
    marginTop: hula.spacing.xl,
    gap: hula.spacing.md,
  },
  connectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: hula.spacing.sm,
    height: hula.button.height,
    borderRadius: hula.button.radius,
    backgroundColor: hula.button.solidBg,
  },
  connectText: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.button.fontSize,
    color: hula.button.solidText,
  },
  redirectNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  redirectText: {
    fontFamily: font.regular,
    fontSize: 12.5,
    color: hula.colors.text.tertiary,
  },
  // Neutral, never red — the design system forbids red in connected states.
  disconnectBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    height: hula.button.height,
    borderRadius: hula.button.radius,
    backgroundColor: 'rgba(150,160,210,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(150,160,210,0.22)',
  },
  disconnectText: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.button.fontSize,
    color: hula.colors.text.secondary,
  },
  pressed: {
    opacity: 0.7,
  },
});
