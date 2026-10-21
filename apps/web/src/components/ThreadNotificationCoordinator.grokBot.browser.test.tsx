import type { ClientSettings } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { render, stubGlobal, type Screen } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  inApp: true,
  active: { environmentId: "env-1", threadId: "other-thread" } as {
    environmentId?: string;
    threadId?: string;
    botId?: string;
  },
  focused: true,
  visible: "visible",
  live: true,
  completedAt: null as string | null,
  archivedAt: null as string | null,
  input: false,
  approval: false,
  sessionError: false,
  turnError: false,
  limited: false,
  subagent: false,
  nativeBot: false,
  botNotifications: true,
  selectedBotEnvironmentId: "env-1",
  message: null as {
    id: string;
    role: "assistant" | "user";
    createdAt: string;
    text?: string;
  } | null,
  background: [] as Array<{ taskId: string; kind: "command" | "monitor" }>,
  add: vi.fn(
    (_toast: { title: string; description: string; actionProps: { onClick: () => void } }) =>
      "toast-1",
  ),
  close: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T09:00:00.000Z");

function mockThreadShell() {
  return {
    id: state.nativeBot ? "grok-bot:thread-1" : "thread-1",
    projectId: "project-1",
    title: "Fix the login form",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: state.nativeBot ? "bot-1" : "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: state.subagent ? "parent" : null,
      relationshipToParent: state.subagent ? "subagent" : null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: state.nativeBot && !state.completedAt ? null : "run-1",
    activeRunId: null,
    status: state.completedAt
      ? "completed"
      : state.sessionError || state.turnError || state.limited
        ? "failed"
        : state.nativeBot
          ? "idle"
          : "running",
    lastErrorClass: state.limited ? "usage_limit" : null,
    pendingRuntimeRequest: state.input
      ? { id: "request-1", kind: "user_input", createdAt: SHELL_NOW }
      : state.approval
        ? { id: "request-1", kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage:
      state.message === null
        ? null
        : {
            ...state.message,
            text: state.message.text ?? "Incoming message",
            createdAt: DateTime.makeUnsafe(state.message.createdAt),
            updatedAt: DateTime.makeUnsafe("2026-09-13T11:00:00.000Z"),
          },
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: state.background,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: state.completedAt ? DateTime.makeUnsafe(state.completedAt) : undefined,
    archivedAt: state.archivedAt ? DateTime.makeUnsafe(state.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => ({
    status: state.live ? "live" : "disconnected",
    snapshot: Option.some({ threads: [mockThreadShell()] }),
  }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => state.navigate,
  useParams: () => state.active,
}));
vi.mock("/src/hooks/useSettings.ts", () => ({
  useClientSettings: (
    select: (
      settings: Pick<ClientSettings, "notificationMode" | "inAppNotificationsEnabled">,
    ) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: state.inApp }),
  getClientSettings: () => ({ notificationMode: state.mode }),
}));
vi.mock("/src/state/environments.ts", () => ({
  useEnvironmentIds: () => ["env-1"],
}));
vi.mock("/src/state/shell.ts", () => ({
  environmentShell: { stateValueAtom: vi.fn() },
}));
vi.mock("/src/components/grokBot/useGrokBotEnvironment.ts", () => ({
  useSelectedGrokBotEnvironmentId: () => state.selectedBotEnvironmentId,
}));
vi.mock("/src/state/grokBots.ts", () => ({ grokBotsListQuery: vi.fn() }));
vi.mock("/src/state/query.ts", () => ({
  useEnvironmentQuery: () => ({
    data: [{ id: "bot-1", notificationEnabled: state.botNotifications }],
  }),
}));
vi.mock("/src/threadNotifications.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
}));
vi.mock("/src/components/ui/toast.tsx", () => ({
  toastManager: { add: state.add, close: state.close },
}));

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

function setup() {
  const disposables = new DisposableStack();
  vi.clearAllMocks();
  Object.assign(state, {
    mode: "off",
    inApp: true,
    active: { environmentId: "env-1", threadId: "other-thread" },
    focused: true,
    visible: "visible",
    live: true,
    completedAt: null,
    archivedAt: null,
    input: false,
    approval: false,
    sessionError: false,
    turnError: false,
    limited: false,
    subagent: false,
    nativeBot: false,
    botNotifications: true,
    selectedBotEnvironmentId: "env-1",
    message: null,
    background: [],
  });
  state.nativeBot = true;
  disposables.use(vi.spyOn(Date, "now").mockReturnValue(DateTime.toEpochMillis(SHELL_NOW)));
  disposables.use(vi.spyOn(document, "hasFocus").mockImplementation(() => state.focused));
  disposables.use(
    vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => state.visible as DocumentVisibilityState),
  );
  disposables.use(
    stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" })),
  );
  return disposables;
}

describe("native Grok Bot message notifications", () => {
  async function receive(screen: Screen, id = "message-1", createdAt = "2026-09-13T10:00:00.000Z") {
    state.message = { id, role: "assistant", createdAt };
    await screen.rerender(<ThreadNotificationCoordinator />);
  }

  it("notifies once for a runless native message and opens its bot in the right environment", async () => {
    using _fixture = setup();
    await using screen = await render(<ThreadNotificationCoordinator />);
    state.mode = "notifications-and-sound";
    await screen.rerender(<ThreadNotificationCoordinator />);
    await receive(screen);
    state.message = { ...state.message!, text: "Edited message" };
    await screen.rerender(<ThreadNotificationCoordinator />);
    state.completedAt = "2026-09-13T10:00:00.000Z";
    await screen.rerender(<ThreadNotificationCoordinator />);
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenCalledWith(expect.objectContaining({ title: "New message" }));
    expect(state.sound).toHaveBeenCalledTimes(1);
    expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
    state.add.mock.calls[0]?.[0].actionProps.onClick();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/grok-bots/$botId",
      params: { botId: "bot-1" },
      search: { environmentId: "env-1" },
    });
  });

  it("ignores user messages, history imports, first load, and reconnect snapshots", async () => {
    using _fixture = setup();
    state.message = { id: "message-1", role: "assistant", createdAt: "2026-09-13T10:00:00.000Z" };
    await using screen = await render(<ThreadNotificationCoordinator />);
    await receive(screen);
    await receive(screen, "old-history", "2026-09-13T08:00:00.000Z");
    state.message = { id: "user", role: "user", createdAt: "2026-09-13T10:01:00.000Z" };
    await screen.rerender(<ThreadNotificationCoordinator />);
    state.live = false;
    await screen.rerender(<ThreadNotificationCoordinator />);
    state.message = {
      id: "reconnect-history",
      role: "assistant",
      createdAt: "2026-09-13T10:02:00.000Z",
    };
    state.live = true;
    await screen.rerender(<ThreadNotificationCoordinator />);
    expect(state.add).not.toHaveBeenCalled();
    await receive(screen, "live-message", "2026-09-13T10:03:00.000Z");
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("deduplicates edits and history replacements while retaining distinct messages at the same timestamp", async () => {
    using _fixture = setup();
    await using screen = await render(<ThreadNotificationCoordinator />);
    await screen.rerender(<ThreadNotificationCoordinator />);
    await receive(screen, "first");
    await receive(screen, "second");
    await receive(screen, "first");
    await receive(screen, "older", "2026-09-13T09:30:00.000Z");
    expect(state.add).toHaveBeenCalledTimes(2);
  });

  it("ignores history newer than stale thread metadata but older than connection time", async () => {
    using _fixture = setup();
    using _now = vi
      .spyOn(Date, "now")
      .mockReturnValue(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-09-13T10:00:00.000Z")));
    await using screen = await render(<ThreadNotificationCoordinator />);
    await screen.rerender(<ThreadNotificationCoordinator />);
    await receive(screen, "late-history", "2026-09-13T09:30:00.000Z");
    expect(state.add).not.toHaveBeenCalled();
    await receive(screen, "incoming", "2026-09-13T10:01:00.000Z");
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it.each(["bot", "thread"])(
    "silences foreground native messages when the active %s is open",
    async (route) => {
      using _fixture = setup();
      await using screen = await render(<ThreadNotificationCoordinator />);
      state.mode = "notifications-and-sound";
      state.active =
        route === "thread"
          ? { environmentId: "env-1", threadId: "grok-bot:thread-1" }
          : { botId: "bot-1" };
      await screen.rerender(<ThreadNotificationCoordinator />);
      await receive(screen);
      expect(state.add).not.toHaveBeenCalled();
      expect(state.sound).not.toHaveBeenCalled();
      expect(state.notification).not.toHaveBeenCalled();
    },
  );

  it("alerts for the same bot in another environment", async () => {
    using _fixture = setup();
    await using screen = await render(<ThreadNotificationCoordinator />);
    state.active = { botId: "bot-1" };
    state.selectedBotEnvironmentId = "env-2";
    await screen.rerender(<ThreadNotificationCoordinator />);
    await receive(screen);
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("honors the bot's notification preference without replaying when enabled", async () => {
    using _fixture = setup();
    await using screen = await render(<ThreadNotificationCoordinator />);
    state.mode = "notifications-and-sound";
    state.botNotifications = false;
    await screen.rerender(<ThreadNotificationCoordinator />);
    await receive(screen);
    state.botNotifications = true;
    await screen.rerender(<ThreadNotificationCoordinator />);
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
    await receive(screen, "enabled-message", "2026-09-13T10:01:00.000Z");
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("uses desktop alerts while the native bot chat is in the background", async () => {
    using _fixture = setup();
    await using screen = await render(<ThreadNotificationCoordinator />);
    state.mode = "notifications";
    state.focused = false;
    state.active = { botId: "bot-1" };
    await screen.rerender(<ThreadNotificationCoordinator />);
    await receive(screen);
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledWith("New message", {
      body: "Fix the login form",
      tag: expect.any(String),
      silent: true,
    });
  });
});
