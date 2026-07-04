import * as SecureStore from 'expo-secure-store';

import type { TokenCache } from '@clerk/clerk-expo';

/**
 * Clerk token cache backed by expo-secure-store.
 *
 * Clerk hands us session/JWT tokens to persist between launches. We keep them
 * in the device secure enclave (Keychain on iOS, Keystore on Android) instead
 * of AsyncStorage so they never sit in plain text. Works in Expo Go.
 */
export const tokenCache: TokenCache = {
  async getToken(key: string) {
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      // A corrupted/undecryptable entry should not crash auth — treat as signed out.
      return null;
    }
  },
  async saveToken(key: string, value: string) {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      // Ignore write failures; Clerk will simply re-authenticate next time.
    }
  },
};
