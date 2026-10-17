import { registerThreadDismissal } from "./thread-dismissal";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { makeThreadShellFixture } from "../../test-fixtures";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  pendingOrder: null as object | null,
  providers: [] as { instanceId: string; driver: string }[],
  nativeFailure: false,
  dropBusy: false,
  scopes: new Map<string, Set<string>>(),
  shells: [] as EnvironmentThreadShell[],
  requests: [] as {
    action: string;
    environmentId: string;
    input: object;
  }[],
  dialogs: [] as { onConfirm: () => void }[],
  textInputs: [] as { title: string; onConfirm: (title: string) => void }[],
  alerts: [] as {
    title: string;
    message: string;
    buttons?: { text: string; onPress?: () => void }[];
  }[],
  prompts: [] as { title: string; callback: (title: string) => void }[],
  afterRequest: undefined as (() => void) | undefined,
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
}));
vi.mock("react-native", () => ({
  Alert: {
    alert: (title: string, _message: string, buttons?: { text: string; onPress?: () => void }[]) =>
      state.alerts.push({ title, message: _message, buttons }),
    prompt: (title: string, _message: string | undefined, callback: (title: string) => void) =>
      state.prompts.push({ title, callback }),
  },
  Platform: { OS: "ios" },
}));
vi.mock("expo-haptics", () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("../../components/ConfirmDialogHost", () => ({
  showConfirmDialog: (dialog: { onConfirm: () => void }) => state.dialogs.push(dialog),
  showTextInputDialog: (dialog: { title: string; onConfirm: (title: string) => void }) =>
    state.textInputs.push(dialog),
}));
vi.mock("../archive/useArchivedThreadSnapshots", () => ({
  refreshArchivedThreadsForEnvironment: () => {},
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.scopes.get(environmentId)?.has(scope) === true,
}));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: "server-configs",
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    set: (_atom: string, value: boolean) => {
      state.dropBusy = value;
    },
    get: (atom: string) =>
      atom === "thread-drop-busy"
        ? state.dropBusy
        : atom === "thread-shells"
          ? state.shells
          : atom === "queued-thread-keys"
            ? new Set<string>()
            : new Map(
                [...state.scopes.keys()].map((environmentId) => [
                  environmentId,
                  {
                    providers: state.providers,
                    environment: {
                      capabilities: {
                        threadSettlement: true,
                        threadSnooze: true,
                        threadPinning: true,
                        threadPinReorder: true,
                        threadTitleRegeneration: true,
                      },
                    },
                  },
                ]),
              ),
  },
}));
vi.mock("../../state/museAgent", () => ({
  museAgentFeatureUpdate: async (request: {
    environmentId: string;
    input: { operation: string; providerInstanceId: string; sessionId: string; archived: boolean };
  }) => {
    state.requests.push({ action: "muse-restore", ...request });
    return state.nativeFailure
      ? AsyncResult.failure(Cause.fail(new Error("private upstream failure")))
      : AsyncResult.success({ updated: true });
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
// Stubbed at the direct dependency: the real outbox pulls the Expo file-system
// storage into a test that only reads which threads are queued.
vi.mock("../../state/use-thread-outbox", () => ({ queuedThreadKeysAtom: "queued-thread-keys" }));
// The real hold lives in a module-level atom that would leak between cases.
vi.mock("../../state/thread-order", () => ({
  threadDropBusyAtom: "thread-drop-busy",
  getPendingThreadOrder: () => state.pendingOrder,
  beginPendingThreadOrder: () => {
    state.pendingOrder = {};
    return {
      isPending: () => state.pendingOrder !== null,
      complete: () => {
        state.pendingOrder = null;
      },
      cancel: () => {
        state.pendingOrder = null;
      },
    };
  },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellsAtom: "thread-shells" },
  threadEnvironment: Object.fromEntries(
    [
      "archive",
      "unarchive",
      "delete",
      "settle",
      "unsettle",
      "snooze",
      "unsnooze",
      "pin",
      "unpin",
      "reorderPin",
      "updateMetadata",
    ].map((action) => [
      action,
      async (request: {
        environmentId: string;
        input: { threadId: string; orderKey?: string };
      }) => {
        state.requests.push({ action, ...request });
        if (!state.scopes.get(request.environmentId)?.has(AuthOrchestrationOperateScope)) {
          return AsyncResult.failure(Cause.fail(new Error("Thread operation denied")));
        }
        state.afterRequest?.();
        return AsyncResult.success(undefined);
      },
    ]),
  ),
}));

import { useArchivedThreadListActions, useThreadListActions } from "./useThreadListActions";

const primaryEnvironmentId = EnvironmentId.make("primary");
const otherEnvironmentId = EnvironmentId.make("other");

function makeThread(input: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return makeThreadShellFixture({
    id: ThreadId.make("thread"),
    title: "Thread",
    environmentId: primaryEnvironmentId,
    projectId: ProjectId.make("project"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    ...input,
  });
}

const mutationCases = [
  ["archiveThread", "archive"],
  ["settleThread", "settle"],
  ["unsettleThread", "unsettle"],
  ["snoozeThread", "snooze"],
  ["unsnoozeThread", "unsnooze"],
  ["pinThread", "pin"],
  ["unpinThread", "unpin"],
  ["regenerateThreadTitle", "updateMetadata"],
] as const;

beforeEach(() => {
  state.providers = [];
  state.nativeFailure = false;
  state.pendingOrder = null;
  state.dropBusy = false;
  state.scopes = new Map([
    [primaryEnvironmentId, new Set([AuthOrchestrationOperateScope])],
    [otherEnvironmentId, new Set<string>()],
  ]);
  state.requests = [];
  state.shells = [];
  state.dialogs = [];
  state.textInputs = [];
  state.alerts = [];
  state.prompts = [];
  state.afterRequest = undefined;
});

afterEach(() => vi.unstubAllEnvs());

describe("thread list operation permissions", () => {
  it.each(mutationCases)(
    "%s rejects a retained callback after its environment loses permission",
    async (handler) => {
      const actions = useThreadListActions();
      state.scopes.get(primaryEnvironmentId)!.clear();

      await actions[handler](makeThread(), "2099-01-01T00:00:00.000Z");

      expect(state.requests).toEqual([]);
    },
  );

  it.each(mutationCases)("%s requires the target environment's permission", async (handler) => {
    await useThreadListActions()[handler](
      makeThread({ environmentId: otherEnvironmentId }),
      "2099-01-01T00:00:00.000Z",
    );

    expect(state.requests).toEqual([]);
  });

  it.each(mutationCases)(
    "%s works when the target environment gains only task permission",
    async (handler, action) => {
      state.scopes.get(primaryEnvironmentId)!.clear();
      const actions = useThreadListActions();
      state.scopes.get(otherEnvironmentId)!.add(AuthOrchestrationOperateScope);

      await actions[handler](
        makeThread({ environmentId: otherEnvironmentId }),
        "2099-01-01T00:00:00.000Z",
      );

      expect(state.requests).toEqual([
        expect.objectContaining({ action, environmentId: otherEnvironmentId }),
      ]);
    },
  );

  it.each(["ios", "android"])("does not show a forbidden %s delete confirmation", (os) => {
    vi.stubEnv("EXPO_OS", os);
    useThreadListActions().confirmDeleteThread(makeThread({ environmentId: otherEnvironmentId }));

    expect(state.dialogs).toEqual([]);
    expect(state.alerts.some((alert) => alert.title === "Delete thread?")).toBe(false);
    expect(state.requests).toEqual([]);
  });

  it.each(["ios", "android"])(
    "rechecks permission after a retained %s delete confirmation",
    async (os) => {
      vi.stubEnv("EXPO_OS", os);
      useThreadListActions().confirmDeleteThread(makeThread());
      const confirm =
        os === "ios"
          ? state.alerts[0]?.buttons?.find((button) => button.text === "Delete")?.onPress
          : state.dialogs[0]?.onConfirm;
      expect(confirm).toBeTypeOf("function");
      state.scopes.get(primaryEnvironmentId)!.clear();

      await confirm!();

      expect(state.requests).toEqual([]);
    },
  );

  it("unarchives with only task permission and blocks a later revoked callback", async () => {
    const actions = useArchivedThreadListActions(() => {});
    const thread = makeThread({ archivedAt: "2026-09-02T00:00:00.000Z" });
    await actions.unarchiveThread(thread);
    expect(state.requests).toEqual([expect.objectContaining({ action: "unarchive" })]);
    state.requests = [];
    state.scopes.get(primaryEnvironmentId)!.clear();

    await actions.unarchiveThread(thread);

    expect(state.requests).toEqual([]);
  });

  it("keeps delete independent of terminal and source-control permissions", async () => {
    vi.stubEnv("EXPO_OS", "android");
    useArchivedThreadListActions(() => {}).confirmDeleteThread(makeThread());
    await state.dialogs[0]!.onConfirm();

    expect(state.requests).toEqual([expect.objectContaining({ action: "delete" })]);
  });

  it("hides generic archive and delete for Muse without sending RPCs", async () => {
    vi.stubEnv("EXPO_OS", "android");
    const muse = makeThread({ id: ThreadId.make("muse-agent:main") });
    const actions = useThreadListActions();
    actions.archiveThread(muse);
    actions.confirmDeleteThread(muse);
    await actions.settleThread(muse);

    expect(state.dialogs).toEqual([]);
    expect(state.alerts.some((alert) => alert.title === "Delete thread?")).toBe(false);
    expect(state.requests).toEqual([expect.objectContaining({ action: "settle" })]);
  });

  it("does not treat generic unarchive as Muse restore", async () => {
    const muse = makeThread({
      id: ThreadId.make("muse-agent:main"),
      archivedAt: "2026-09-02T00:00:00.000Z",
    });
    await useArchivedThreadListActions(() => {}).unarchiveThread(muse);
    expect(state.requests).toEqual([]);
    await vi.waitFor(() =>
      expect(state.alerts).toEqual([
        expect.objectContaining({ title: "Could not unarchive thread" }),
      ]),
    );
  });

  it("restores canonical Muse side chats through the paired native service", async () => {
    const providerInstanceId = ProviderInstanceId.make("historical-muse");
    state.providers = [{ instanceId: providerInstanceId, driver: "muse-agent" }];
    const completed = vi.fn();
    const thread = makeThread({
      id: ThreadId.make(`muse-agent:${"a".repeat(64)}:side%3Achat`),
      modelSelection: { instanceId: providerInstanceId, model: "muse-agent" },
      archivedAt: "2026-09-02T00:00:00.000Z",
    });
    useArchivedThreadListActions(completed).unarchiveThread(thread);
    await vi.waitFor(() => expect(completed).toHaveBeenCalledWith(thread));
    expect(state.requests).toEqual([
      {
        action: "muse-restore",
        environmentId: primaryEnvironmentId,
        input: {
          operation: "session_archive",
          providerInstanceId,
          sessionId: "side:chat",
          archived: false,
        },
      },
    ]);
  });

  it.each([`muse-agent:${"a".repeat(64)}`, "muse-agent:main", `muse-agent:${"a".repeat(64)}:%ZZ`])(
    "rejects restoring a non-side conversation %s",
    async (id) => {
      state.providers = [{ instanceId: "codex", driver: "muse-agent" }];
      useArchivedThreadListActions(() => {}).unarchiveThread(makeThread({ id: ThreadId.make(id) }));
      await Promise.resolve();
      expect(state.requests).toEqual([]);
    },
  );

  it("rechecks Muse restore permission on a retained callback and never offers delete", async () => {
    state.providers = [{ instanceId: "codex", driver: "muse-agent" }];
    const thread = makeThread({ id: ThreadId.make(`muse-agent:${"a".repeat(64)}:side`) });
    const actions = useArchivedThreadListActions(() => {});
    state.scopes.get(primaryEnvironmentId)!.clear();
    actions.unarchiveThread(thread);
    actions.confirmDeleteThread(thread);
    await Promise.resolve();
    expect(state.requests).toEqual([]);
    expect(state.alerts.some((alert) => alert.title === "Delete thread?")).toBe(false);
  });

  it("does not send native restore to a capability-absent server", async () => {
    const thread = makeThread({ id: ThreadId.make(`muse-agent:${"a".repeat(64)}:side`) });
    useArchivedThreadListActions(() => {}).unarchiveThread(thread);
    await Promise.resolve();
    expect(state.requests).toEqual([]);
    await vi.waitFor(() =>
      expect(state.alerts).toEqual([
        expect.objectContaining({ title: "Could not unarchive thread" }),
      ]),
    );
  });

  it("rechecks Muse availability after the archive row finishes dismissing", async () => {
    state.providers = [{ instanceId: "codex", driver: "muse-agent" }];
    const thread = makeThread({ id: ThreadId.make(`muse-agent:${"a".repeat(64)}:side`) });
    const restore = vi.fn();
    const unregister = registerThreadDismissal(
      scopedThreadKey(thread.environmentId, thread.id),
      () => {
        state.providers = [];
        return { finished: Promise.resolve(), restore };
      },
    );
    try {
      useArchivedThreadListActions(() => {}).unarchiveThread(thread);
      await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce());
      expect(state.requests).toEqual([]);
    } finally {
      unregister();
    }
  });

  it("keeps failed native restores archived and hides upstream errors", async () => {
    state.providers = [{ instanceId: "codex", driver: "muse-agent" }];
    state.nativeFailure = true;
    const completed = vi.fn();
    useArchivedThreadListActions(completed).unarchiveThread(
      makeThread({ id: ThreadId.make(`muse-agent:${"a".repeat(64)}:side`) }),
    );
    await vi.waitFor(() => expect(state.alerts).toHaveLength(1));
    expect(completed).not.toHaveBeenCalled();
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0]?.action).toBe("muse-restore");
    expect(state.alerts[0]?.message).toBe(
      "The Muse conversation could not be restored. Reconnect to its Muse server and try again.",
    );
  });

  it("does not open rename or regenerate-title for Muse and sends no metadata RPC", async () => {
    const muse = makeThread({ id: ThreadId.make("muse-agent:main") });
    const actions = useThreadListActions();
    actions.renameThread(muse);
    await actions.regenerateThreadTitle(muse);

    expect(state.prompts).toEqual([]);
    expect(state.textInputs).toEqual([]);
    expect(state.dialogs).toEqual([]);
    expect(state.alerts).toEqual([]);
    expect(state.requests).toEqual([]);
  });

  it("keeps ordinary rename and regenerate-title metadata updates", async () => {
    const actions = useThreadListActions();
    actions.renameThread(makeThread());
    expect(state.prompts).toEqual([expect.objectContaining({ title: "Rename thread" })]);
    state.prompts[0]!.callback("New title");
    await Promise.resolve();

    expect(state.requests).toEqual([expect.objectContaining({ action: "updateMetadata" })]);

    state.requests = [];
    await actions.regenerateThreadTitle(makeThread({ id: ThreadId.make("other-thread") }));
    expect(state.requests).toEqual([expect.objectContaining({ action: "updateMetadata" })]);
  });
});

describe("pinned thread operation permissions", () => {
  it("checks every materialization target before writing any keys", async () => {
    const moved = makeThread({ pinnedAt: "2026-09-02T00:00:00.000Z" });
    state.shells = [
      moved,
      makeThread({
        id: ThreadId.make("other-thread"),
        environmentId: otherEnvironmentId,
        pinnedAt: "2026-09-02T00:00:00.000Z",
        createdAt: "2026-09-02T00:00:00.000Z",
      }),
    ];

    expect(await useThreadListActions().moveThread(moved, "up")).toBe(false);
    expect(state.requests).toEqual([]);
  });

  it("moves a keyed thread past a read-only neighbor without writing that neighbor", async () => {
    const moved = makeThread({ pinnedAt: "2026-09-02T00:00:00.000Z", pinOrderKey: "m" });
    state.shells = [
      moved,
      makeThread({
        id: ThreadId.make("other-thread"),
        environmentId: otherEnvironmentId,
        pinnedAt: "2026-09-02T00:00:00.000Z",
        pinOrderKey: "g",
      }),
    ];

    expect(await useThreadListActions().moveThread(moved, "up")).toBe(true);
    expect(state.requests).toEqual([
      expect.objectContaining({ action: "reorderPin", environmentId: primaryEnvironmentId }),
    ]);
  });

  it("rechecks permission between materialization writes", async () => {
    const moved = makeThread({ pinnedAt: "2026-09-02T00:00:00.000Z" });
    state.shells = [
      moved,
      makeThread({
        id: ThreadId.make("other-thread"),
        pinnedAt: "2026-09-02T00:00:00.000Z",
        createdAt: "2026-09-02T00:00:00.000Z",
      }),
    ];
    state.afterRequest = () => state.scopes.get(primaryEnvironmentId)!.clear();

    expect(await useThreadListActions().moveThread(moved, "up")).toBe(false);
    expect(state.requests).toHaveLength(1);
  });
});
