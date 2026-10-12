import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";
import { Alert, Platform } from "react-native";

import { parseThreadLink, resolveThreadLink, type ParsedThreadLink } from "../../lib/threadLinks";
import { appAtomRegistry } from "../../state/atom-registry";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { useConnectionsReady, useWorkspaceEnvironments } from "../../state/workspace";

const pendingThreadLink = Atom.make<Exclude<ParsedThreadLink, { kind: "ignored" }> | null>(
  null,
).pipe(Atom.keepAlive);

/** Return ordinary app links unchanged; thread intents wait for saved state and navigation. */
export function interceptAndroidThreadLink(url: string | null): string | null {
  if (Platform.OS !== "android" || url === null) return url;
  const parsed = parseThreadLink(url);
  if (parsed.kind === "ignored") return url;
  appAtomRegistry.set(pendingThreadLink, parsed);
  return null;
}

export function useAndroidThreadLinkNavigation() {
  const pending = useAtomValue(pendingThreadLink);
  const navigation = useNavigation();
  const isReady = useConnectionsReady();
  const environments = useWorkspaceEnvironments();
  const target = pending?.kind === "thread" ? pending.target : null;
  const environmentId = target ? EnvironmentId.make(target.environmentId) : null;
  const shell = useEnvironmentShellReadiness(environmentId);
  const thread = useThreadShell(
    target
      ? {
          environmentId: EnvironmentId.make(target.environmentId),
          threadId: ThreadId.make(target.threadId),
        }
      : null,
  );
  const result =
    pending?.kind === "invalid"
      ? "This thread link is invalid. Expected an environment ID and a thread ID."
      : target
        ? resolveThreadLink({
            isReady,
            environment: environments.find((entry) => entry.environmentId === target.environmentId),
            shellStatus: shell.status,
            shellHasError: shell.hasError,
            threadExists: thread !== null,
          })
        : null;

  useEffect(() => {
    if (!pending || !result || result === "waiting") return;
    appAtomRegistry.set(pendingThreadLink, null);
    if (result === "open" && pending.kind === "thread") {
      navigation.navigate("Thread", pending.target);
    } else {
      Alert.alert("Cannot open thread", result, [
        { text: "OK", style: "cancel" },
        { text: "Connections", onPress: () => navigation.navigate("Connections") },
      ]);
    }
  }, [pending, result, navigation]);

  useEffect(() => {
    if (!pending) return;
    const timeout = setTimeout(() => {
      if (appAtomRegistry.get(pendingThreadLink) !== pending) return;
      appAtomRegistry.set(pendingThreadLink, null);
      Alert.alert(
        "Cannot open thread",
        "The environment did not connect or load its threads in time. Check Connections and try again.",
      );
    }, 15_000);
    return () => clearTimeout(timeout);
  }, [pending]);
}
