import { useAuth, useUser } from '@clerk/clerk-expo';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { SettingsEditFrame } from '@/components/settings/SettingsEditFrame';
import { hula } from '@/constants/theme';
import { getHulaProfile, setHulaProfile } from '@/lib/hulaProfile';
import { resolveDisplayName } from '@/lib/hulaUser';

const font = hula.typography.fontFamily;

/**
 * Settings → Name. Edits a local `displayName` override (see lib/hulaProfile).
 * Prefills with the current effective name so the user edits from what they see.
 * Saving an empty value clears the override and falls back to Clerk.
 */
export default function EditName() {
  const router = useRouter();
  const { userId } = useAuth();
  const { user } = useUser();

  const [value, setValue] = useState('');

  useEffect(() => {
    getHulaProfile(userId).then((p) => {
      setValue(p.displayName?.trim() || resolveDisplayName(user));
    });
  }, [userId, user]);

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  };

  const onSave = async () => {
    await setHulaProfile(userId, { displayName: value.trim() });
    goBack();
  };

  return (
    <SettingsEditFrame title="Name" onBack={goBack} onSave={onSave}>
      <View style={styles.inputCard}>
        <Ionicons name="person-outline" size={22} color={hula.glow.purpleBright} />
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={setValue}
          placeholder="Your name"
          placeholderTextColor={hula.colors.text.faint}
          autoCapitalize="words"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={onSave}
        />
      </View>
    </SettingsEditFrame>
  );
}

const styles = StyleSheet.create({
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
  },
  input: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 18,
    color: hula.colors.text.primary,
    paddingVertical: hula.spacing.lg,
  },
});
