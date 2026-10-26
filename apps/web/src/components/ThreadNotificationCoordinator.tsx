import type { SidebarThreadStatus } from "./Sidebar.logic";
import {
  createThreadNotificationGate,
  type ThreadNotificationKind,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";
import {
  type EnvironmentThreadShell,
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { pendingSubagentRequestsByThread } from "@t3tools/client-runtime/state/threads";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { isGrokBotBackingThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { environmentShell } from "../state/shell";
import { grokBotsListQuery } from "../state/grokBots";
import { useEnvironmentQuery } from "../state/query";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  threadNotificationTag,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import { useSelectedGrokBotEnvironmentId } from "./grokBot/useGrokBotEnvironment";
import { toastManager } from "./ui/toast";

export function ThreadNotificationCoordinator() {
  const environmentIds = useEnvironmentIds();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const pending = useRef(
    new Map<string, { environmentId: EnvironmentId; notification: Notification }>(),
  );
  const onNotification = (environmentId: EnvironmentId, notification: Notification) => {
    pending.current.get(notification.tag)?.notification.close();
    pending.current.set(notification.tag, { environmentId, notification });
    setNotificationBadge(pending.current.size);
  };

  useEffect(() => {
    const activeIds = new Set(environmentIds);
    const count = pending.current.size;
    for (const [tag, entry] of pending.current) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
      pending.current.delete(tag);
    }
    if (count !== pending.current.size) setNotificationBadge(pending.current.size);
  }, [environmentIds]);

  useEffect(() => {
    const clear = () => {
      for (const { notification } of pending.current.values()) notification.close();
      pending.current.clear();
      setNotificationBadge(0);
    };
    clear();
    if (!hasDesktopNotifications(mode)) return;
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, [mode]);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  if (mode === "off" && !inAppNotificationsEnabled) return null;

  return environmentIds.map((environmentId) => (
    <EnvironmentNotifications
      key={environmentId}
      environmentId={environmentId}
      onNotification={onNotification}
    />
  ));
}

interface NotificationState extends ThreadNotificationObservation {
  readonly thread: EnvironmentThreadShell;
  readonly status: SidebarThreadStatus;
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly attention: string | null;
  readonly completion: number | null;
  readonly messageAt: number;
  readonly messageIds: ReadonlySet<string>;
}

function EnvironmentNotifications({
  environmentId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  onNotification: (environmentId: EnvironmentId, notification: Notification) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const threads =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value.threads : null;
  const botRoster = useEnvironmentQuery(
    threads?.some(isGrokBotBackingThread) ? grokBotsListQuery({ environmentId, input: {} }) : null,
  ).data;
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const navigate = useNavigate();
  const {
    environmentId: activeEnvironmentId,
    threadId: activeThreadId,
    botId: activeBotId,
  } = useParams({
    strict: false,
  });
  const selectedBotEnvironmentId = useSelectedGrokBotEnvironmentId();
  const previous = useRef(new Map<ThreadId, NotificationState>());

  // Completions fire from a timer, so read settings, focus and route when presenting.
  const present = useEffectEvent((threadId: ThreadId, kind: ThreadNotificationKind) => {
    const entry = previous.current.get(threadId);
    if (!entry) return;
    const { thread, status } = entry;
    const title =
      kind === "completion"
        ? "Thread completed"
        : status === "approval"
          ? "Approval needed"
          : status === "limited"
            ? "Usage limit reached"
            : status === "failed"
              ? "Thread failed"
              : status === "request"
                ? "Guest request"
                : "Input needed";
    if (hasNotificationSound(mode)) {
      void playNotificationSound(kind, () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    if (
      inAppNotificationsEnabled &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      (activeEnvironmentId !== environmentId || activeThreadId !== thread.id)
    ) {
      const toastId = toastManager.add({
        type: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
        title,
        description: thread.title,
        data: {
          hideCopyButton: true,
          leadingIcon:
            kind === "completion" ? (
              <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
            ) : status === "approval" ? (
              <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
            ) : status === "failed" ? (
              <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
            ) : (
              <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
            ),
        },
        actionProps: {
          children: "Open thread",
          onClick: () => {
            toastManager.close(toastId);
            void navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: thread.id },
            });
          },
        },
      });
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      (document.visibilityState === "visible" && document.hasFocus()) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    try {
      const notification = new Notification(title, {
        body: thread.title,
        tag: threadNotificationTag(environmentId, thread.id),
        silent: true,
      });
      onNotification(environmentId, notification);
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow?.().catch(() => undefined);
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: thread.id },
        });
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  });
  const gate = useRef<ReturnType<typeof createThreadNotificationGate<ThreadId>>>(null);
  useEffect(() => {
    const created = createThreadNotificationGate<ThreadId>((threadId, kind) =>
      present(threadId, kind),
    );
    gate.current = created;
    return () => {
      created.clear();
      gate.current = null;
      // A new gate has no pending completions, so forget the states they compared against.
      previous.current.clear();
    };
  }, []);

  useEffect(() => {
    const pendingCompletions = gate.current;
    if (!pendingCompletions) return;
    if (threads === null) {
      pendingCompletions.clear();
      previous.current.clear();
      return;
    }
    const next = new Map<ThreadId, NotificationState>();
    const subagentRequests = pendingSubagentRequestsByThread(threads);
    const changed: Array<[NotificationState | undefined, NotificationState]> = [];
    for (const rawThread of threads) {
      if (rawThread.lineage.relationshipToParent === "subagent") continue;
      const prior = previous.current.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      if (prior?.raw === rawThread && prior.subagentRequest === subagentRequest) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const attention =
        status === "input" ||
        status === "request" ||
        status === "approval" ||
        status === "failed" ||
        status === "limited"
          ? `${thread.latestRun?.runId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const completion =
        status === "ready" &&
        thread.latestRun?.status === "completed" &&
        Number.isFinite(completedAt)
          ? completedAt
          : (prior?.completion ?? null);
      const nativeBot = isGrokBotBackingThread(rawThread);
      const message = nativeBot ? rawThread.latestVisibleMessage : null;
      const messageAt =
        message === null ? null : DateTime.toEpochMillis(message.createdAt ?? message.updatedAt);
      // Native history arrives after shell hydration. Its original timestamp
      // keeps old imports and edited messages from becoming new-message alerts.
      const watermark =
        prior?.messageAt ?? Math.max(Date.now(), DateTime.toEpochMillis(rawThread.updatedAt));
      const messageIds = prior?.messageIds ?? new Set<string>();
      const newMessage =
        message?.role === "assistant" &&
        messageAt !== null &&
        messageAt >= watermark &&
        !messageIds.has(message.id);
      const state: NotificationState = {
        thread,
        status,
        settled: status === "ready" && thread.latestRun?.status === "completed",
        completedAt: Number.isFinite(completedAt) ? completedAt : null,
        raw: rawThread,
        subagentRequest,
        attention,
        completion,
        messageAt: newMessage ? messageAt : watermark,
        messageIds: newMessage
          ? new Set(messageAt === watermark ? [...messageIds, message.id] : [message.id])
          : messageIds,
      };
      next.set(thread.id, state);
      if (!nativeBot) {
        changed.push([prior, state]);
        continue;
      }

      if (!prior || thread.archivedAt !== null) continue;
      const kind =
        attention && attention !== prior.attention
          ? "input"
          : newMessage
            ? "message"
            : !nativeBot &&
                !rawThread.latestRunStopRequested &&
                completion !== null &&
                (prior.completion === null || completion > prior.completion)
              ? "completion"
              : null;

      if (!kind) continue;
      if (
        kind === "message" &&
        botRoster?.find((bot) => bot.id === thread.modelSelection.model)?.notificationEnabled !==
          true
      )
        continue;
      const foreground = document.visibilityState === "visible" && document.hasFocus();
      const activeThread =
        (activeEnvironmentId === environmentId && activeThreadId === thread.id) ||
        (nativeBot &&
          selectedBotEnvironmentId === environmentId &&
          activeBotId === thread.modelSelection.model);
      if (kind === "message" && foreground && activeThread) continue;
      const openThread = () => {
        void navigate(
          nativeBot
            ? {
                to: "/grok-bots/$botId",
                params: { botId: thread.modelSelection.model },
                search: { environmentId },
              }
            : {
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: thread.id },
              },
        );
      };
      const title =
        kind === "message"
          ? "New message"
          : kind === "completion"
            ? "Thread completed"
            : status === "approval"
              ? "Approval needed"
              : status === "limited"
                ? "Usage limit reached"
                : status === "failed"
                  ? "Thread failed"
                  : "Input needed";
      if (hasNotificationSound(mode)) {
        void playNotificationSound(kind === "message" ? "completion" : kind, () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      if (inAppNotificationsEnabled && foreground && !activeThread) {
        const toastId = toastManager.add({
          type:
            kind === "message"
              ? "info"
              : kind === "completion"
                ? "success"
                : status === "failed"
                  ? "error"
                  : "warning",
          title,
          description: thread.title,
          data: {
            hideCopyButton: true,
            leadingIcon:
              kind === "message" ? (
                <MessageCircleIcon aria-hidden className="size-4 text-info-foreground" />
              ) : kind === "completion" ? (
                <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
              ) : status === "approval" ? (
                <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
              ) : status === "failed" ? (
                <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
              ) : (
                <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
              ),
          },
          actionProps: {
            children: nativeBot ? "Open chat" : "Open thread",
            onClick: () => {
              toastManager.close(toastId);
              openThread();
            },
          },
        });
        continue;
      }
      if (
        !hasDesktopNotifications(mode) ||
        (document.visibilityState === "visible" && document.hasFocus()) ||
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
      )
        continue;
      try {
        const notification = new Notification(title, {
          body: thread.title,
          tag: threadNotificationTag(environmentId, thread.id),
          silent: true,
        });
        onNotification(environmentId, notification);
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void window.desktopBridge?.revealWindow?.().catch(() => undefined);
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: thread.id },
          });
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    }
    previous.current = next;
    pendingCompletions.retain(new Set(next.keys()));
    for (const [prior, state] of changed)
      pendingCompletions.observe(state.thread.id, prior, state, {
        archived: state.thread.archivedAt !== null,
        quiet: state.raw.latestRunStopRequested === true,
      });
  }, [
    activeEnvironmentId,
    activeThreadId,
    botRoster,
    activeBotId,
    selectedBotEnvironmentId,
    environmentId,
    inAppNotificationsEnabled,
    mode,
    navigate,
    onNotification,
    threads,
  ]);

  return null;
}
