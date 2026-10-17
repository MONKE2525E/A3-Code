import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { AppText as Text } from "../../components/AppText";
import {
  describeMuseNativeOpenFailure,
  museNativeAttachSendGate,
  openCachedMuseThread,
  resolveMuseAgentNativeOpenPlan,
  type MuseAgentNativeOpenProvider,
  type MuseNativeAttachSendGate,
} from "../../lib/museAgentThread";
import { museAgentOpenThread } from "../../state/museAgent";
import { useAtomCommand } from "../../state/use-atom-command";

function useMuseAgentNativeAttach(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly connected: boolean;
  readonly providers: ReadonlyArray<MuseAgentNativeOpenProvider> | null;
  readonly observerRetirement?: string | null;
}): {
  readonly gate: MuseNativeAttachSendGate;
  readonly error: string | null;
  readonly canOpen: boolean;
  readonly planKind: Parameters<typeof museNativeAttachSendGate>[0]["planKind"];
  readonly retry: () => void;
} {
  const {
    environmentId,
    threadId,
    providerInstanceId,
    connected,
    providers,
    observerRetirement = null,
  } = input;
  const openThread = useAtomCommand(museAgentOpenThread, { reportFailure: false });
  const canOpen = useAtomValue(museAgentOpenThread.permissionAtom(environmentId));
  const plan = useMemo(
    () => resolveMuseAgentNativeOpenPlan({ threadId, providerInstanceId, providers }),
    [threadId, providerInstanceId, providers],
  );
  const [retry, setRetry] = useState(0);
  const [openError, setError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<{ retirement: string | null } | null>(null);
  const retired =
    attachment !== null &&
    observerRetirement !== null &&
    attachment.retirement !== observerRetirement;
  const attached = attachment !== null && !retired;
  const error = retired ? "Muse history disconnected. Retry to reconnect." : openError;
  const scopeKey = `${environmentId}:${threadId}:${providerInstanceId}:${plan.kind}:${connected}:${canOpen}:${retry}`;
  const [scope, setScope] = useState(scopeKey);
  if (retired && scope === scopeKey) {
    setAttachment(null);
    setError("Muse history disconnected. Retry to reconnect.");
  }
  if (scope !== scopeKey) {
    setScope(scopeKey);
    setAttachment(null);
    setError(null);
  }
  const retirementAtAttempt = useRef(observerRetirement);
  retirementAtAttempt.current = observerRetirement;
  useEffect(() => {
    if (plan.kind !== "open" || !connected || !canOpen) return;
    let current = true;
    const retirementAtOpen = retirementAtAttempt.current;
    setError((previous) => (previous === null ? previous : null));
    void openCachedMuseThread({
      hit: { environmentId, threadId },
      shells: [{ environmentId, id: threadId, providerInstanceId }],
      openThread: async (target) => {
        const result = await openThread(target);
        if (result._tag === "Success") return result.value;
        if (isAtomCommandInterrupted(result)) {
          throw new Error("Muse connection was interrupted. Retry to reconnect.");
        }
        throw squashAtomCommandFailure(result);
      },
      navigate: async () => {},
    })
      .then(() => {
        if (current) setAttachment({ retirement: retirementAtOpen });
      })
      .catch((cause: unknown) => {
        if (!current) return;
        setError(describeMuseNativeOpenFailure(cause));
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
  return {
    gate: museNativeAttachSendGate({
      planKind: plan.kind,
      connected,
      canOpen,
      attached,
      error,
    }),
    error,
    canOpen,
    planKind: plan.kind,
    retry: () => setRetry((value) => value + 1),
  };
}

/** A restored Muse route must reattach native history even when no list action ran. */
export function MuseAgentRouteConnection({
  environmentId,
  threadId,
  providerInstanceId,
  connected,
  hasMessages,
  providers,
  observerRetirement,
  children,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly connected: boolean;
  readonly hasMessages: boolean;
  readonly providers: ReadonlyArray<MuseAgentNativeOpenProvider> | null;
  readonly observerRetirement?: string | null;
  readonly children?: (gate: MuseNativeAttachSendGate) => ReactNode;
}) {
  const { gate, error, canOpen, planKind, retry } = useMuseAgentNativeAttach({
    environmentId,
    threadId,
    providerInstanceId,
    connected,
    providers,
    observerRetirement,
  });
  let status: ReactNode = null;
  if (planKind !== "skip" && connected) {
    if (planKind === "unavailable") {
      status = (
        <View accessibilityRole="text" className="px-4 py-2">
          <Text className="text-center text-xs text-foreground-muted">
            {gate.sendBlockedReason}
          </Text>
        </View>
      );
    } else if (planKind === "open" && !canOpen) {
      status = (
        <View accessibilityRole="text" className="px-4 py-2">
          <Text className="text-center text-xs text-foreground-muted">
            Live Muse history needs permission to operate on this environment.
          </Text>
        </View>
      );
    } else if (error !== null) {
      status = (
        <View className="flex-row flex-wrap items-center justify-center gap-2 px-4 py-2">
          <Text accessibilityRole="alert" className="text-center text-xs text-destructive">
            {error}
          </Text>
          <Pressable
            accessibilityRole="button"
            className="rounded-full border border-border px-3 py-1 active:opacity-70"
            onPress={retry}
          >
            <Text className="text-xs font-t3-bold text-foreground">Retry Muse connection</Text>
          </Pressable>
        </View>
      );
    } else if (!gate.sendAllowed) {
      status = (
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
  }
  return (
    <>
      {status}
      {children?.(gate)}
    </>
  );
}
