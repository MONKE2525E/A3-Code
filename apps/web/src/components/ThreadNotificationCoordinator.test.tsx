import type { ClientSettings } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    status: state.live ? "live" : "disconnected",
    snapshot: Option.some({ threads: [mockThreadShell()] }),
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => state.active,
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    select: (
      settings: Pick<ClientSettings, "notificationMode" | "inAppNotificationsEnabled">,
    ) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: state.inApp }),
  getClientSettings: () => ({ notificationMode: state.mode }),
}));
vi.mock("../state/environments", () => ({
  useEnvironmentIds: () => ["env-1"],
}));
vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: vi.fn() },
}));
vi.mock("./grokBot/useGrokBotEnvironment", () => ({
  useSelectedGrokBotEnvironmentId: () => state.selectedBotEnvironmentId,
}));
vi.mock("../state/grokBots", () => ({ grokBotsListQuery: vi.fn() }));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: [{ id: "bot-1", notificationEnabled: state.botNotifications }],
  }),
}));
vi.mock("../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.add, close: state.close },
}));

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

let renderer: ReactTestRenderer | undefined;

async function render() {
  await act(() => {
    if (renderer) renderer.update(<ThreadNotificationCoordinator />);
    else renderer = create(<ThreadNotificationCoordinator />);
  });
}

async function complete() {
  state.completedAt = "2026-09-13T10:00:00.000Z";
  await render();
}

beforeEach(() => {
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", {
    get visibilityState() {
      return state.visible;
    },
    hasFocus: () => state.focused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" }));
});

describe("native Grok Bot message notifications", () => {
  beforeEach(() => {
    state.nativeBot = true;
    vi.spyOn(Date, "now").mockReturnValue(DateTime.toEpochMillis(SHELL_NOW));
  });

  async function receive(id = "message-1", createdAt = "2026-09-13T10:00:00.000Z") {
    state.message = { id, role: "assistant", createdAt };
    await render();
  }

  it("notifies once for a runless native message and opens its bot in the right environment", async () => {
    state.mode = "notifications-and-sound";
    await render();
    await receive();
    state.message = { ...state.message!, text: "Edited message" };
    await render();
    await complete();
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
    await receive();
    await receive("old-history", "2026-09-13T08:00:00.000Z");
    state.message = { id: "user", role: "user", createdAt: "2026-09-13T10:01:00.000Z" };
    await render();
    state.live = false;
    await render();
    state.message = {
      id: "reconnect-history",
      role: "assistant",
      createdAt: "2026-09-13T10:02:00.000Z",
    };
    state.live = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
    await receive("live-message", "2026-09-13T10:03:00.000Z");
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("deduplicates edits and history replacements while retaining distinct messages at the same timestamp", async () => {
    await render();
    await receive("first");
    await receive("second");
    await receive("first");
    await receive("older", "2026-09-13T09:30:00.000Z");
    expect(state.add).toHaveBeenCalledTimes(2);
  });

  it("ignores history newer than stale thread metadata but older than connection time", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      DateTime.toEpochMillis(DateTime.makeUnsafe("2026-09-13T10:00:00.000Z")),
    );
    await render();
    await receive("late-history", "2026-09-13T09:30:00.000Z");
    expect(state.add).not.toHaveBeenCalled();
    await receive("incoming", "2026-09-13T10:01:00.000Z");
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it.each(["bot", "thread"])(
    "silences foreground native messages when the active %s is open",
    async (route) => {
      state.mode = "notifications-and-sound";
      state.active =
        route === "thread"
          ? { environmentId: "env-1", threadId: "grok-bot:thread-1" }
          : { botId: "bot-1" };
      await render();
      await receive();
      expect(state.add).not.toHaveBeenCalled();
      expect(state.sound).not.toHaveBeenCalled();
      expect(state.notification).not.toHaveBeenCalled();
    },
  );

  it("alerts for the same bot in another environment", async () => {
    state.active = { botId: "bot-1" };
    state.selectedBotEnvironmentId = "env-2";
    await render();
    await receive();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("honors the bot's notification preference without replaying when enabled", async () => {
    state.mode = "notifications-and-sound";
    state.botNotifications = false;
    await render();
    await receive();
    state.botNotifications = true;
    await render();
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
    await receive("enabled-message", "2026-09-13T10:01:00.000Z");
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("uses desktop alerts while the native bot chat is in the background", async () => {
    state.mode = "notifications";
    state.focused = false;
    state.active = { botId: "bot-1" };
    await render();
    await receive();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledWith("New message", {
      body: "Fix the login form",
      tag: "env-1:grok-bot:thread-1",
      silent: true,
    });
  });
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("thread notifications", () => {
  it.each([true, false])("keeps subagents silent with focus=%s", async (focused) => {
    state.subagent = true;
    state.focused = focused;
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    state.input = true;
    await render();
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("alerts once with system alerts off and opens the completed thread", async () => {
    await render();
    await complete();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    const toast = state.add.mock.calls[0]?.[0];
    expect(toast?.title).toBe("Thread completed");
    expect(toast?.description).toBe("Fix the login form");
    toast?.actionProps.onClick();
    expect(state.close).toHaveBeenCalledWith("toast-1");
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
    expect(state.notification).not.toHaveBeenCalled();
  });

  it.each(["active", "blurred", "hidden", "archived", "disabled"])(
    "does not show a completion toast for %s threads",
    async (condition) => {
      await render();
      if (condition === "active") state.active.threadId = "thread-1";
      if (condition === "blurred") state.focused = false;
      if (condition === "hidden") state.visible = "hidden";
      if (condition === "archived") state.archivedAt = "2026-09-13T09:00:00.000Z";
      if (condition === "disabled") state.inApp = false;
      await complete();
      expect(state.add).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["input", "Input needed"],
    ["approval", "Approval needed"],
    ["sessionError", "Thread failed"],
    ["turnError", "Thread failed"],
    ["limited", "Usage limit reached"],
  ] as const)("uses the same %s event for in-app and desktop alerts", async (event, title) => {
    state.mode = "notifications-and-sound";
    await render();
    state[event] = true;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(expect.objectContaining({ title }));
    expect(state.sound).toHaveBeenCalledWith("input", expect.any(Function));
    expect(state.notification).not.toHaveBeenCalled();

    state[event] = false;
    await render();
    state.focused = false;
    state[event] = true;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledWith(title, {
      body: "Fix the login form",
      tag: "env-1:thread-1",
      silent: true,
    });
  });

  it("alerts when only a dev server is left running, not while a monitor can wake the agent", async () => {
    await render();
    state.background = [{ taskId: "watch", kind: "monitor" }];
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    state.background = [{ taskId: "dev", kind: "command" }];
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Thread completed" }),
    );
  });

  it("keeps background desktop alerts when in-app notifications are disabled", async () => {
    state.focused = false;
    state.inApp = false;
    state.mode = "notifications";
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledTimes(1);
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("does not replay a completion when opting in from all alerts off", async () => {
    state.inApp = false;
    await render();
    await complete();
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("compares the environment as well as the thread", async () => {
    state.active = { environmentId: "env-2", threadId: "thread-1" };
    await render();
    await complete();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("does not replay completed threads on first load or reconnect", async () => {
    await complete();
    state.live = false;
    await render();
    state.live = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("keeps sound but replaces the system popup when showing a toast", async () => {
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("keeps system alerts when the app is in the background", async () => {
    state.mode = "notifications";
    state.focused = false;
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledWith("Thread completed", {
      body: "Fix the login form",
      tag: "env-1:thread-1",
      silent: true,
    });
  });
});
