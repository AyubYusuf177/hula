import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { useEffect, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { hula } from '@/constants/theme';
import type { IntegrationProviderConfig } from '@/data/integrations';
import { deriveSheetCopy, type IntegrationView } from '@/lib/integrationStatus';

const font = hula.typography.fontFamily;
const SCREEN_H = Dimensions.get('window').height;

/** Drag distance / velocity past which a downward swipe dismisses the sheet. */
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 0.55;

/**
 * Polished, dismissible bottom-sheet for one integration (Section 13).
 *
 * Everything scrolls (small iPhones reach every field + button), the footer
 * actions stay reachable above the home indicator, and the sheet can be dismissed
 * three ways: the X button, a backdrop tap, or a swipe-down on the drag handle.
 * Copy is honest and READ-ONLY, and CONNECTED copy comes only from backend truth.
 * Styling is Hula's dark/glassy system (not Miora's).
 */
export function IntegrationDetailsSheet({
  visible,
  provider,
  view,
  errorText,
  onClose,
  onConnect,
  onDisconnect,
  onRefresh,
}: {
  visible: boolean;
  provider: IntegrationProviderConfig | null;
  view: IntegrationView;
  errorText: string | null;
  onClose: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
}) {
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(SCREEN_H)).current;

  const animateOpen = () =>
    Animated.timing(translateY, {
      toValue: 0,
      duration: 320,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();

  const animateClose = (then?: () => void) =>
    Animated.timing(translateY, {
      toValue: SCREEN_H,
      duration: 240,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => then?.());

  useEffect(() => {
    if (visible) animateOpen();
    else translateY.setValue(SCREEN_H);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Swipe-down on the drag handle / header. The inner ScrollView owns body
  // scrolling, so the two never fight: the sheet only follows drags that start on
  // the handle region.
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_e, g) => {
        if (g.dy > 0) translateY.setValue(g.dy);
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > DISMISS_DISTANCE || g.vy > DISMISS_VELOCITY) {
          animateClose(onClose);
        } else {
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 4,
          }).start();
        }
      },
    }),
  ).current;

  if (!provider) return null;

  const connected = view.state === 'connected';
  const busy = view.state === 'connecting';
  const copy = deriveSheetCopy(view, provider);

  const requestClose = () => animateClose(onClose);

  // Backdrop fades with the sheet position.
  const backdropOpacity = translateY.interpolate({
    inputRange: [0, SCREEN_H],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={requestClose}>
      <View style={styles.overlay}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: backdropOpacity }]}>
          <BlurView intensity={28} tint="dark" style={StyleSheet.absoluteFill} />
          <Pressable style={styles.backdropTint} onPress={requestClose} accessibilityLabel="Close" />
        </Animated.View>

        <Animated.View
          style={[styles.sheetWrap, { transform: [{ translateY }] }]}
        >
          <View style={styles.sheet}>
            {/* Drag zone: handle + header (swipe down here to dismiss) */}
            <View {...pan.panHandlers}>
              <View style={styles.handle} />
              <View style={styles.header}>
                <Pressable
                  onPress={requestClose}
                  hitSlop={10}
                  style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
                  accessibilityLabel="Close"
                >
                  <Ionicons name="close" size={22} color={hula.colors.text.primary} />
                </Pressable>
                <Text style={styles.headerTitle} numberOfLines={1}>
                  {provider.displayName}
                </Text>
                <View style={styles.headerSpacer} />
              </View>
            </View>

            <ScrollView
              contentContainerStyle={styles.body}
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.bigIcon}>
                <Image
                  source={provider.iconImage}
                  style={styles.bigIconImg}
                  contentFit="contain"
                  accessibilityLabel={provider.displayName}
                />
              </View>

              <Text style={styles.heading}>{copy.heading}</Text>

              {/* Live status chip (backend truth) */}
              <View style={styles.statusChip}>
                <View
                  style={[
                    styles.statusDot,
                    { backgroundColor: connected ? provider.accent : hula.colors.text.faint },
                  ]}
                />
                <Text style={styles.statusChipText}>{view.statusLabel}</Text>
              </View>
              {connected && view.accountLabel ? (
                <Text style={styles.account}>{view.accountLabel}</Text>
              ) : null}

              <Text style={styles.paragraph}>{copy.body}</Text>

              {/* Capabilities available today (read-only) */}
              <View style={styles.list}>
                {provider.capabilities.map((cap) => (
                  <View key={cap} style={styles.listRow}>
                    <Ionicons name="checkmark-circle" size={18} color={provider.accent} />
                    <Text style={styles.listText}>{cap}</Text>
                  </View>
                ))}
              </View>

              {/* Coming later (clearly not enabled yet) */}
              {provider.comingLater.length > 0 ? (
                <View style={styles.laterBlock}>
                  <Text style={styles.laterLabel}>COMING LATER</Text>
                  {provider.comingLater.map((cap) => (
                    <View key={cap} style={styles.listRow}>
                      <Ionicons name="ellipse-outline" size={16} color={hula.colors.text.faint} />
                      <Text style={styles.laterText}>{cap}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {/* Honest limitation */}
              <View style={styles.noteRow}>
                <Ionicons name="information-circle-outline" size={16} color={hula.colors.text.tertiary} />
                <Text style={styles.note}>{provider.limitation}</Text>
              </View>

              {/* Privacy note */}
              <View style={styles.noteRow}>
                <Ionicons name="lock-closed" size={14} color={hula.colors.text.tertiary} />
                <Text style={styles.note}>{provider.privacyNote}</Text>
              </View>

              {errorText ? <Text style={styles.error}>{errorText}</Text> : null}
            </ScrollView>

            {/* Sticky action footer — always reachable above the home indicator */}
            <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, hula.spacing.md) }]}>
              {connected ? (
                <Pressable
                  onPress={onDisconnect}
                  disabled={busy}
                  style={({ pressed }) => [styles.disconnectBtn, pressed && styles.pressed]}
                >
                  {busy ? (
                    <ActivityIndicator color="#F0A868" />
                  ) : (
                    <>
                      <Ionicons name="unlink-outline" size={18} color="#F0A868" />
                      <Text style={styles.disconnectText}>{provider.disconnectLabel}</Text>
                    </>
                  )}
                </Pressable>
              ) : (
                <Pressable
                  onPress={onConnect}
                  disabled={busy}
                  style={({ pressed }) => [styles.connectBtn, pressed && styles.pressed]}
                >
                  {busy ? (
                    <ActivityIndicator color={hula.button.solidText} />
                  ) : (
                    <>
                      <Ionicons name="link-outline" size={18} color={hula.button.solidText} />
                      <Text style={styles.connectText}>{provider.connectLabel}</Text>
                    </>
                  )}
                </Pressable>
              )}

              <Pressable
                onPress={onRefresh}
                disabled={busy}
                hitSlop={8}
                style={({ pressed }) => [styles.refreshBtn, pressed && styles.pressed]}
              >
                <Ionicons name="refresh" size={15} color={hula.colors.text.secondary} />
                <Text style={styles.refreshText}>Refresh connection status</Text>
              </Pressable>
            </View>
          </View>
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
    maxHeight: '90%',
  },
  sheet: {
    maxHeight: '100%',
    backgroundColor: '#0C1022',
    borderTopLeftRadius: hula.radius.card,
    borderTopRightRadius: hula.radius.card,
    borderWidth: 1,
    borderColor: hula.glass.cardBorder,
    paddingHorizontal: hula.spacing.xl,
    paddingTop: hula.spacing.sm,
  },
  handle: {
    alignSelf: 'center',
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(150,160,210,0.45)',
    marginBottom: hula.spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: hula.spacing.sm,
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
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontFamily: font.bold,
    fontSize: 20,
    color: hula.colors.text.primary,
  },
  headerSpacer: {
    width: 40,
    height: 40,
  },
  body: {
    alignItems: 'center',
    paddingTop: hula.spacing.md,
    paddingBottom: hula.spacing.lg,
  },
  bigIcon: {
    width: 76,
    height: 76,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: hula.spacing.md,
  },
  bigIconImg: {
    width: 76,
    height: 76,
  },
  heading: {
    fontFamily: font.bold,
    fontSize: 23,
    color: hula.colors.text.primary,
    textAlign: 'center',
  },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: hula.spacing.md,
    paddingHorizontal: hula.spacing.md,
    paddingVertical: 5,
    borderRadius: hula.radius.pill,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  statusChipText: {
    fontFamily: font.medium,
    fontSize: 13,
    color: hula.colors.text.secondary,
  },
  account: {
    marginTop: 6,
    fontFamily: font.regular,
    fontSize: 13,
    color: hula.colors.text.tertiary,
  },
  paragraph: {
    marginTop: hula.spacing.md,
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 22,
    color: hula.colors.text.secondary,
    textAlign: 'center',
  },
  list: {
    alignSelf: 'stretch',
    marginTop: hula.spacing.xl,
    gap: hula.spacing.md,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: hula.spacing.md,
  },
  listText: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: 15,
    color: hula.colors.text.primary,
  },
  laterBlock: {
    alignSelf: 'stretch',
    marginTop: hula.spacing.xl,
    gap: hula.spacing.sm,
  },
  laterLabel: {
    fontFamily: font.semiBold,
    fontSize: 11,
    letterSpacing: 1.5,
    color: hula.colors.text.faint,
    marginBottom: 2,
  },
  laterText: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 14,
    color: hula.colors.text.tertiary,
  },
  noteRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: hula.spacing.sm,
    alignSelf: 'stretch',
    marginTop: hula.spacing.md,
  },
  note: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    color: hula.colors.text.tertiary,
  },
  error: {
    alignSelf: 'stretch',
    marginTop: hula.spacing.lg,
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    color: '#F0A868',
    textAlign: 'center',
  },
  footer: {
    paddingTop: hula.spacing.md,
    gap: hula.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: 'rgba(150,160,210,0.10)',
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
  disconnectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: hula.spacing.sm,
    height: hula.button.height,
    borderRadius: hula.button.radius,
    backgroundColor: 'rgba(240,168,104,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(240,168,104,0.45)',
  },
  disconnectText: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.button.fontSize,
    color: '#F0A868',
  },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: hula.spacing.sm,
    paddingVertical: hula.spacing.sm,
  },
  refreshText: {
    fontFamily: font.medium,
    fontSize: 14,
    color: hula.colors.text.secondary,
  },
  pressed: {
    opacity: 0.7,
  },
});
