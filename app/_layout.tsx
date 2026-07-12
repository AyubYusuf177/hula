import "../global.css";

import {
  Poppins_400Regular,
  Poppins_500Medium,
  Poppins_600SemiBold,
  Poppins_700Bold,
} from "@expo-google-fonts/poppins";
import { ClerkProvider } from "@clerk/clerk-expo";
import { DarkTheme, ThemeProvider } from "@react-navigation/native";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { Stack } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { hula } from "@/constants/theme";
import { tokenCache } from "@/lib/tokenCache";

SplashScreen.preventAutoHideAsync();

// React Navigation defaults to a LIGHT theme whose `colors.background`/`card` are
// white — that white is what flashes around the animating card during stack
// transitions. Anchor the whole navigation theme to Hula's void-black so every
// scene/container behind the animation is already dark.
const hulaNavigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: hula.colors.voidBlack,
    card: hula.colors.voidBlack,
  },
};

// Read from .env at build time. ClerkProvider also auto-detects this var, but we
// pass it explicitly so a missing key fails loudly instead of silently.
const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

export default function RootLayout() {
  const [loaded] = useFonts({
    Poppins_400Regular,
    Poppins_500Medium,
    Poppins_600SemiBold,
    Poppins_700Bold,
  });

  useEffect(() => {
    if (loaded) SplashScreen.hideAsync();
  }, [loaded]);

  if (!loaded) {
    return <View style={{ flex: 1, backgroundColor: hula.colors.voidBlack }} />;
  }

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      {/* Root view backs every scene with void-black so no white window shows
          through during transitions. */}
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: hula.colors.voidBlack }}>
        <ThemeProvider value={hulaNavigationTheme}>
          <SafeAreaProvider>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: hula.colors.voidBlack },
              }}
            />
          </SafeAreaProvider>
        </ThemeProvider>
      </GestureHandlerRootView>
    </ClerkProvider>
  );
}
