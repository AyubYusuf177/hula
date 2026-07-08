import { useAuth } from '@clerk/clerk-expo';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { SettingsEditFrame } from '@/components/settings/SettingsEditFrame';
import { hula } from '@/constants/theme';
import { getHulaMessaging, setHulaMessaging } from '@/lib/hulaMessaging';

const font = hula.typography.fontFamily;

type Tab = 'phone' | 'email';

/**
 * Settings → iMessage Address.
 *
 * Phone and email are held in SEPARATE state and persisted to separate keys
 * (`iMessagePhone` / `iMessageEmail`), so switching tabs never overwrites the
 * other. Save writes both plus the last-selected tab, then returns to Settings.
 */
export default function IMessageAddress() {
  const router = useRouter();
  const { userId } = useAuth();

  const [tab, setTab] = useState<Tab>('phone');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');

  useEffect(() => {
    getHulaMessaging(userId).then((m) => {
      if (m.selectedIMessageTab) setTab(m.selectedIMessageTab);
      if (m.iMessagePhone) setPhone(m.iMessagePhone);
      if (m.iMessageEmail) setEmail(m.iMessageEmail);
    });
  }, [userId]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  };

  const onSave = async () => {
    await setHulaMessaging(userId, {
      iMessagePhone: phone.trim(),
      iMessageEmail: email.trim(),
      selectedIMessageTab: tab,
    });
    goBack();
  };

  const isPhone = tab === 'phone';

  return (
    <SettingsEditFrame title="iMessage Address" onBack={goBack} onSave={onSave}>
      {/* Segmented control */}
      <View style={styles.segment}>
        <SegmentTab label="Phone" active={isPhone} onPress={() => setTab('phone')} />
        <SegmentTab label="Email" active={!isPhone} onPress={() => setTab('email')} />
      </View>

      {/* Input — bound to the active tab's own value */}
      <View style={styles.inputCard}>
        {isPhone ? (
          <Text style={styles.flag}>🇬🇧</Text>
        ) : (
          <Ionicons name="mail-outline" size={22} color={hula.glow.purpleBright} />
        )}
        <TextInput
          style={styles.input}
          value={isPhone ? phone : email}
          onChangeText={isPhone ? setPhone : setEmail}
          placeholder={isPhone ? '+44 7400 123456' : 'Email address'}
          placeholderTextColor={hula.colors.text.faint}
          keyboardType={isPhone ? 'phone-pad' : 'email-address'}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <Text style={styles.helper}>
        Enter the phone number or email associated with your iMessage account.
      </Text>
    </SettingsEditFrame>
  );
}

function SegmentTab({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.segmentTab,
        active && styles.segmentTabActive,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  segment: {
    flexDirection: 'row',
    padding: 5,
    borderRadius: hula.radius.pill,
    backgroundColor: hula.glass.tile,
    borderWidth: 1,
    borderColor: hula.glass.tileBorder,
  },
  segmentTab: {
    flex: 1,
    height: 46,
    borderRadius: hula.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentTabActive: {
    backgroundColor: hula.glow.purple,
  },
  segmentText: {
    fontFamily: font.medium,
    fontSize: hula.typography.hint.fontSize,
    color: hula.colors.text.secondary,
  },
  segmentTextActive: {
    fontFamily: font.semiBold,
    color: hula.colors.text.primary,
  },
  inputCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: hula.spacing.md,
    minHeight: 68,
    paddingHorizontal: hula.spacing.lg,
    borderRadius: hula.radius.card,
    backgroundColor: hula.glass.card,
    borderWidth: 1,
    borderColor: hula.glass.cardBorder,
    marginTop: hula.spacing.xl,
  },
  flag: {
    fontSize: 22,
  },
  input: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 18,
    color: hula.colors.text.primary,
    paddingVertical: hula.spacing.lg,
  },
  helper: {
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 21,
    color: hula.colors.text.tertiary,
    marginTop: hula.spacing.lg,
  },
  pressed: {
    opacity: 0.6,
  },
});
