import { isClerkAPIResponseError, useSignIn, useSignUp } from '@clerk/clerk-expo';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { hula } from '@/constants/theme';

const font = hula.typography.fontFamily;

type Phase = 'email' | 'code';
type Mode = 'signIn' | 'signUp';

/**
 * Custom Hula-styled email auth (NOT Clerk's prebuilt UI).
 *
 * Uses Clerk's email-code strategy as the engine. We try to sign an existing
 * user in first; if the email isn't recognised we transparently create the
 * account. Either way the user just enters an email, then the 6-digit code.
 */
export default function EmailAuthScreen() {
  const router = useRouter();
  const { isLoaded: signInLoaded, signIn, setActive: setSignInActive } = useSignIn();
  const { isLoaded: signUpLoaded, signUp, setActive: setSignUpActive } = useSignUp();

  const [phase, setPhase] = useState<Phase>('email');
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = signInLoaded && signUpLoaded;

  const startSignUp = async () => {
    if (!signUp) return;
    await signUp.create({ emailAddress: email.trim() });
    await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
    setMode('signUp');
    setPhase('code');
  };

  const onContinue = async () => {
    if (!ready || busy || !signIn) return;
    const value = email.trim();
    if (!value.includes('@')) {
      setError('Please enter a valid email address.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // Try existing account first.
      const attempt = await signIn.create({ identifier: value });
      const factor = attempt.supportedFirstFactors?.find(
        (f) => f.strategy === 'email_code',
      );
      if (!factor || !('emailAddressId' in factor)) {
        throw new Error('Email code sign-in is not available for this account.');
      }
      await signIn.prepareFirstFactor({
        strategy: 'email_code',
        emailAddressId: factor.emailAddressId,
      });
      setMode('signIn');
      setPhase('code');
    } catch (err) {
      // No such user → create the account instead.
      if (isClerkAPIResponseError(err) && err.errors[0]?.code === 'form_identifier_not_found') {
        try {
          await startSignUp();
        } catch {
          setError('Could not start sign-up. Please try again.');
        }
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const onVerify = async () => {
    if (!ready || busy) return;
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signIn' && signIn) {
        const res = await signIn.attemptFirstFactor({ strategy: 'email_code', code: code.trim() });
        if (res.status === 'complete') {
          await setSignInActive?.({ session: res.createdSessionId });
          router.replace('/');
          return;
        }
      } else if (mode === 'signUp' && signUp) {
        const res = await signUp.attemptEmailAddressVerification({ code: code.trim() });
        if (res.status === 'complete') {
          await setSignUpActive?.({ session: res.createdSessionId });
          router.replace('/');
          return;
        }
      }
      setError('That code was incorrect. Please try again.');
    } catch {
      setError('That code was incorrect. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const goBack = () => {
    if (phase === 'code') {
      setPhase('email');
      setCode('');
      setError(null);
    } else {
      router.back();
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.container}>
          <Pressable onPress={goBack} hitSlop={12} style={styles.back}>
            <Ionicons name="chevron-back" size={26} color={hula.colors.text.primary} />
          </Pressable>

          {phase === 'email' ? (
            <>
              <Text style={styles.title}>What&apos;s your email?</Text>
              <Text style={styles.subtitle}>
                We&apos;ll send a code to your inbox to sign you in.
              </Text>

              <TextInput
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor={hula.colors.text.faint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                autoComplete="email"
                inputMode="email"
                returnKeyType="go"
                onSubmitEditing={onContinue}
                style={styles.input}
              />

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <GradientButton
                label="Continue"
                loading={busy}
                disabled={!ready}
                onPress={onContinue}
              />
            </>
          ) : (
            <>
              <Text style={styles.title}>Enter your code</Text>
              <Text style={styles.subtitle}>
                We sent a 6-digit code to {email.trim()}.
              </Text>

              <TextInput
                value={code}
                onChangeText={setCode}
                placeholder="123456"
                placeholderTextColor={hula.colors.text.faint}
                keyboardType="number-pad"
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                maxLength={6}
                returnKeyType="go"
                onSubmitEditing={onVerify}
                style={[styles.input, styles.codeInput]}
              />

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <GradientButton
                label="Verify"
                loading={busy}
                disabled={code.trim().length < 6}
                onPress={onVerify}
              />
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function GradientButton({
  label,
  onPress,
  loading = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        { marginTop: hula.spacing.xl },
        pressed && { opacity: 0.85 },
        (disabled || loading) && { opacity: 0.55 },
      ]}
    >
      <LinearGradient
        colors={[...hula.button.gradientBorder]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.button}
      >
        {loading ? (
          <ActivityIndicator size="small" color={hula.button.solidText} />
        ) : (
          <Text style={styles.buttonLabel}>{label}</Text>
        )}
      </LinearGradient>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: hula.colors.voidBlack,
  },
  container: {
    flex: 1,
    paddingHorizontal: hula.spacing.xl,
    paddingTop: hula.spacing.xl,
  },
  back: {
    width: 40,
    height: 40,
    alignItems: 'flex-start',
    justifyContent: 'center',
    marginBottom: hula.spacing['2xl'],
  },
  title: {
    fontFamily: font.bold,
    fontSize: hula.typography.hero.fontSize,
    lineHeight: hula.typography.hero.lineHeight,
    color: hula.colors.text.primary,
  },
  subtitle: {
    fontFamily: font.regular,
    fontSize: hula.typography.hint.fontSize,
    lineHeight: hula.typography.hint.lineHeight,
    color: hula.colors.text.tertiary,
    marginTop: hula.spacing.md,
  },
  input: {
    height: hula.button.height,
    borderRadius: hula.button.radius,
    borderWidth: 1,
    borderColor: hula.glass.cardBorder,
    backgroundColor: hula.glass.tile,
    paddingHorizontal: hula.spacing.xl,
    marginTop: hula.spacing['2xl'],
    color: hula.colors.text.primary,
    fontFamily: font.medium,
    fontSize: hula.typography.button.fontSize,
  },
  codeInput: {
    letterSpacing: 8,
    textAlign: 'center',
  },
  error: {
    fontFamily: font.medium,
    fontSize: hula.typography.legal.fontSize,
    lineHeight: hula.typography.legal.lineHeight,
    color: '#FF9FB2',
    marginTop: hula.spacing.md,
  },
  button: {
    height: hula.button.height,
    borderRadius: hula.button.radius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonLabel: {
    fontFamily: font.semiBold,
    fontSize: hula.typography.button.fontSize,
    color: hula.button.solidText,
  },
});
