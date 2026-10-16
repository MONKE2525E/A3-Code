import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { AppText as Text } from "../../components/AppText";
import {
  describeMuseNativeOpenFailure,
  openCachedMuseThread,
  resolveMuseAgentNativeOpenPlan,
  type MuseAgentNativeOpenProvider,
} from "../../lib/museAgentThread";
import { museAgentOpenThread } from "../../state/museAgent";
import { useAtomCommand } from "../../state/use-atom-command";

/** A restored Muse route must reattach native history even when no list action ran. */
export function MuseAgentRouteConnection({
  environmentId,
  threadId,
  providerInstanceId,
  connected,
  hasMessages,
  providers,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly connected: boolean;
  readonly hasMessages: boolean;
  readonly providers: ReadonlyArray<MuseAgentNativeOpenProvider> | null;
}) {
  const openThread = useAtomCommand(museAgentOpenThread, { reportFailure: false });
  const canOpen = useAtomValue(museAgentOpenThread.permissionAtom(environmentId));
  const plan = useMemo(
    () => resolveMuseAgentNativeOpenPlan({ threadId, providerInstanceId, providers }),
    [threadId, providerInstanceId, providers],
  );
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (plan.kind !== "open" || !connected || !canOpen) return;
    let current = true;
    setError((previous) => (previous === null ? previous : null));
    setPending(true);
    void openCachedMuseThread({
      hit: { environmentId, threadId },
      shells: [{ environmentId, id: threadId, providerInstanceId }],
      openThread: async (target) => {
        const result = await openThread(target);
        if (result._tag === "Success") return result.value;
        if (isAtomCommandInterrupted(result)) return null;
        throw squashAtomCommandFailure(result);
      },
      navigate: async () => {},
    })
      .catch((cause: unknown) => {
        if (!current) return;
        setError(describeMuseNativeOpenFailure(cause));
      })
      .finally(() => {
        if (current) setPending(false);
      });
    return () => {
      current = false;
    };
  }, [
    plan.kind,
    connected,
    canOpen,
    environmentId,
    threadId,
    providerInstanceId,
    openThread,
    retry,
  ]);
  if (plan.kind !== "open" || !connected) return null;
  if (!canOpen) {
    return (
      <View accessibilityRole="text" className="px-4 py-2">
        <Text className="text-center text-xs text-foreground-muted">
          Live Muse history needs permission to operate on this environment.
        </Text>
      </View>
    );
  }
  if (pending) {
    return (
      <View
        accessibilityRole="text"
        accessibilityLiveRegion="polite"
        className="flex-row items-center justify-center gap-2 px-4 py-2"
      >
        <AppActivityIndicator size="small" />
        <Text className="text-center text-xs text-foreground-muted">
          {hasMessages ? "Connecting Muse history…" : "Loading conversation history."}
        </Text>
      </View>
    );
  }
  if (error === null) return null;
  return (
    <View className="flex-row flex-wrap items-center justify-center gap-2 px-4 py-2">
      <Text accessibilityRole="alert" className="text-center text-xs text-destructive">
        {error}
      </Text>
      <Pressable
        accessibilityRole="button"
        className="rounded-full border border-border px-3 py-1 active:opacity-70"
        onPress={() => setRetry((value) => value + 1)}
      >
        <Text className="text-xs font-t3-bold text-foreground">Retry Muse connection</Text>
      </Pressable>
    </View>
  );
}
