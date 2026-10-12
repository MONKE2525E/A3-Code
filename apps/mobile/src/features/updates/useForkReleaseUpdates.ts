import Constants from "expo-constants";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Linking, Platform } from "react-native";

import { checkForkReleaseUpdate, type ForkReleaseUpdate } from "./fork-releases";

export const usesForkReleaseUpdates =
  Platform.OS === "android" && Constants.expoConfig?.extra?.customAndroidBuild === true;
let lastAutomaticCheck = 0;
let lastOfferedBuild = 0;

export function useForkReleaseUpdates(automatic = false) {
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(false);

  const check = useCallback(async (manual = true) => {
    if (!usesForkReleaseUpdates || inFlight.current) return;
    if (!manual && Date.now() - lastAutomaticCheck < 15 * 60_000) return;
    inFlight.current = true;
    lastAutomaticCheck = Date.now();
    try {
      const build = Number(
        Constants.platform?.android?.versionCode ??
          Constants.expoConfig?.extra?.forkBuildNumber ??
          0,
      );
      const update = await checkForkReleaseUpdate(Number.isSafeInteger(build) ? build : 0);
      if (!mounted.current) return;
      if (!update) {
        if (manual)
          Alert.alert(
            "No newer APK",
            "No newer mobile build is published on your fork's GitHub releases.",
          );
        return;
      }
      if (!manual && (AppState.currentState !== "active" || lastOfferedBuild === update.build))
        return;
      lastOfferedBuild = update.build;
      offerUpdate(update);
    } catch (error) {
      if (manual && mounted.current)
        Alert.alert(
          "Update check failed",
          error instanceof Error ? error.message : "Could not check GitHub releases.",
        );
    } finally {
      inFlight.current = false;
      if (manual && mounted.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (automatic && usesForkReleaseUpdates) void check(false);
    const subscription =
      automatic && usesForkReleaseUpdates
        ? AppState.addEventListener("change", (state) => {
            if (state === "active") void check(false);
          })
        : null;
    return () => {
      mounted.current = false;
      subscription?.remove();
    };
  }, [automatic, check]);

  const checkManually = useCallback(async () => {
    if (!usesForkReleaseUpdates || inFlight.current) return;
    setChecking(true);
    await check(true);
  }, [check]);

  return { checking, check: checkManually };
}

function offerUpdate(update: ForkReleaseUpdate) {
  Alert.alert(
    "Mobile update available",
    `Build ${update.build} is ready. Download the APK, then open it to update T3 Code Custom. Your PC keeps using upstream T3 Code.`,
    [
      { text: "Later", style: "cancel" },
      {
        text: "Download APK",
        onPress: () => {
          void Linking.openURL(update.downloadUrl).catch(() =>
            Alert.alert(
              "Download failed",
              "Could not open the APK download. Try again from Settings.",
            ),
          );
        },
      },
    ],
  );
}
