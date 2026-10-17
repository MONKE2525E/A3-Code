import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { QueuedThreadMessage } from "./thread-outbox-model";

const state = vi.hoisted(() => {
  const thread = {
    environmentId: "secondary",
    id: "thread",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
  };
  return {
    connection: { phase: "connected", generation: 1 } as {
      phase: "connected" | "backoff";
      generation: number;
    },
    grantedEnvironments: new Set<string>(),
    draftText: "Keep this draft separate",
    cleanups: [] as Array<() => void>,
    start: vi.fn(),
    metadata: vi.fn(),
    runtime: vi.fn(),
    interaction: vi.fn(),
    prepare: vi.fn(),
    checkout: vi.fn(),
    openMuse: vi.fn(),
    museOpenedThreadId: "thread",
    manager: null as unknown as ReturnType<
      typeof import("./thread-outbox-manager").createThreadOutboxManager
    >,
    thread,
    threads: [thread] as Array<typeof thread>,
    connectedEnvironments: [{ environmentId: "secondary", connectionState: "connected" }] as Array<{
      environmentId: string;
      connectionState: string;
    }>,
    config: {
      providers: [{ instanceId: "codex", driver: "codex" }],
      environment: { capabilities: {} },
    },
  };
});
vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useEffect: (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (cleanup) state.cleanups.push(cleanup);
  },
  useRef: <A>(value: A) => ({ current: value }),
  useState: <A>(initial: A) => [initial, vi.fn()],
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@effect/atom-react", async () => {
  const { appAtomRegistry } = await import("./atom-registry");
  return { useAtomValue: <A>(atom: Atom.Atom<A>) => appAtomRegistry.get(atom) };
});
vi.mock("./session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.grantedEnvironments.has(environmentId),
  useEnvironmentsWithScope: () => state.grantedEnvironments,
}));
vi.mock("./entities", () => ({
  useProjects: () => [],
  useThreadShells: () => state.threads,
  useServerConfigs: () => new Map([["secondary", state.config]]),
}));
vi.mock("./server", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: { configValueAtom: Atom.family((_id: string) => Atom.make(state.config)) },
  };
});
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    threadEnvironment: {
      startTurn: state.start,
      updateMetadata: state.metadata,
      setRuntimeMode: state.runtime,
      setInteractionMode: state.interaction,
    },
    environmentThreadShells: { threadShellsAtom: Atom.make(state.threads) },
  };
});
vi.mock("../connection/catalog", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentCatalog: {
      stateAtom: Atom.family((_id: string) =>
        Atom.make(() => AsyncResult.success(state.connection)).pipe(Atom.keepAlive),
      ),
    },
  };
});

vi.mock("./museAgent", () => ({ museAgentOpenThread: state.openMuse }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: <A>(command: A) => command }));
vi.mock("./git", () => ({ gitEnvironment: { preparePullRequestThread: state.checkout } }));
vi.mock("../lib/modelOptions", () => ({ isModelSelectionUnavailable: () => false }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid", randomHex: () => "abcd" }));
vi.mock("../lib/attachmentUpload", () => ({ prepareTurnAttachments: state.prepare }));
vi.mock("./use-remote-environment-registry", () => ({
  setPendingConnectionError: vi.fn(),
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: state.connectedEnvironments,
  }),
}));
vi.mock("./thread-outbox", async () => {
  const { createThreadOutboxManager } = await import("./thread-outbox-manager");
  const { appAtomRegistry } = await import("./atom-registry");
  state.manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => ({ messages: [], errors: [] }),
      write: async () => {},
      remove: async () => {},
    },
  });
  return {
    threadOutboxManager: state.manager,
    threadOutboxRevision: (id: MessageId) => state.manager.revisionOf(id),
    confirmThreadOutboxMessageQueued: (message: QueuedThreadMessage) =>
      state.manager.confirmQueued(message),
    updateThreadOutboxMessage: (message: QueuedThreadMessage, revision?: number) =>
      state.manager.update(message, revision),
  };
});
vi.mock("./thread-outbox-removal", () => ({
  removeThreadOutboxMessage: (message: QueuedThreadMessage, revision?: number) =>
    state.manager.remove(message, revision),
}));
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  const { appAtomRegistry } = await import("./atom-registry");
  await import("./thread-outbox");
  return {
    editingQueuedMessageIdsAtom: Atom.make({}).pipe(Atom.keepAlive),
    dispatchingQueuedMessageIdAtom: Atom.make<MessageId | null>(null).pipe(Atom.keepAlive),
    useThreadOutboxMessages: () => appAtomRegistry.get(state.manager.queuedMessagesByThreadKeyAtom),
    useThreadOutboxShellStatuses: () => new Map([["secondary", "live"]]),
  };
});
vi.mock("./use-composer-drafts", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    composerDraftsAtom: Atom.make({}),
    removeDeliveredCloudQueuedMessage: async () => {},
    appendComposerDraftAttachments: vi.fn(),
    flushComposerDrafts: vi.fn(),
    getComposerDraftSnapshot: vi.fn(() => ({ text: state.draftText, attachments: [] })),
    mergeComposerDraftContent: vi.fn(async (_key: string, input: { text: string }) => {
      state.draftText += `\n${input.text}`;
    }),
    replaceComposerDraftAttachments: vi.fn(),
    undoComposerDraftMerge: vi.fn(),
    updateComposerDraftSettings: vi.fn(),
    waitForComposerDraftsLoaded: vi.fn(),
  };
});

import { threadComposerErrorsAtom } from "./thread-composer-error";
import { appAtomRegistry } from "./atom-registry";
import { environmentCatalog } from "../connection/catalog";
import { dispatchingQueuedMessageIdAtom, editingQueuedMessageIdsAtom } from "./use-thread-outbox";
import { useThreadOutboxDrain } from "./use-thread-outbox-drain";

const message = (overrides: Partial<QueuedThreadMessage> = {}): QueuedThreadMessage => ({
  environmentId: EnvironmentId.make("secondary"),
  threadId: ThreadId.make("thread"),
  commandId: CommandId.make("command"),
  messageId: MessageId.make("message"),
  text: "Keep this queued",
  attachments: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  ...overrides,
});
const remaining = () =>
  Object.values(appAtomRegistry.get(state.manager.queuedMessagesByThreadKeyAtom)).flat();

function runDrain() {
  const settled = Promise.withResolvers<void>();
  const release = appAtomRegistry.subscribe(dispatchingQueuedMessageIdAtom, (id) => {
    if (id === null) settled.resolve();
  });
  useThreadOutboxDrain();
  return settled.promise.finally(release);
}

beforeEach(() => {
  state.connection = { phase: "connected", generation: 1 };
  appAtomRegistry.refresh(environmentCatalog.stateAtom(EnvironmentId.make("secondary")));
  appAtomRegistry.set(editingQueuedMessageIdsAtom, {});
  appAtomRegistry.set(threadComposerErrorsAtom, {});
  state.grantedEnvironments = new Set(["primary"]);
  state.draftText = "Keep this draft separate";
  state.thread.environmentId = "secondary";
  state.thread.id = "thread";
  state.thread.providerInstanceId = "codex";
  state.thread.modelSelection = { instanceId: "codex", model: "gpt-5.4" };
  state.threads.splice(0, state.threads.length, state.thread);
  state.connectedEnvironments.splice(0, state.connectedEnvironments.length, {
    environmentId: "secondary",
    connectionState: "connected",
  });
  state.config.providers = [{ instanceId: "codex", driver: "codex" }];
  state.museOpenedThreadId = "thread";
  appAtomRegistry.set(state.manager.queuedMessagesByThreadKeyAtom, {});
  appAtomRegistry.set(dispatchingQueuedMessageIdAtom, null);
  for (const command of [
    state.start,
    state.metadata,
    state.runtime,
    state.interaction,
    state.checkout,
  ]) {
    command.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  }
  state.openMuse
    .mockReset()
    .mockImplementation(async () => AsyncResult.success({ threadId: state.museOpenedThreadId }));
  state.prepare.mockReset().mockImplementation(async ({ attachments }) => ({
    status: "ready",
    attachments: [],
    draftAttachments: attachments,
    pendingAttachmentIds: [],
  }));
});

describe("queued PR checkout", () => {
  const queuedPullRequest = () =>
    message({
      threadId: ThreadId.make("new-pr-thread"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      creation: {
        projectId: ProjectId.make("project"),
        projectCwd: "/repo",
        workspaceMode: "worktree",
        branch: "fork/feature",
        worktreePath: null,
        pullRequestReference: "https://github.com/acme/repo/pull/123",
      },
    });
  const preparedCheckout = {
    branch: "pr-123",
    worktreePath: "/repo/.t3/worktrees/pr-123",
    isOnPullRequestHead: true,
  };

  it("waits for the provider's PR checkout and launches in that worktree", async () => {
    state.grantedEnvironments.add("secondary");
    await state.manager.enqueue(queuedPullRequest());
    const started = Promise.withResolvers<void>();
    const checkout =
      Promise.withResolvers<AsyncResult.AsyncResult<typeof preparedCheckout, Error>>();
    state.checkout.mockImplementationOnce(() => {
      started.resolve();
      return checkout.promise;
    });
    const drained = runDrain();
    await started.promise;
    expect(state.start).not.toHaveBeenCalled();
    expect(state.checkout).toHaveBeenCalledWith({
      environmentId: "secondary",
      input: { cwd: "/repo", reference: "https://github.com/acme/repo/pull/123", mode: "worktree" },
    });
    checkout.resolve(AsyncResult.success(preparedCheckout));
    await drained;
    expect(state.start).toHaveBeenCalledOnce();
    const bootstrap = state.start.mock.calls[0]?.[0].input.bootstrap;
    expect(bootstrap.createThread).toMatchObject({
      branch: "pr-123",
      worktreePath: preparedCheckout.worktreePath,
    });
    expect(bootstrap.prepareWorktree).toBeUndefined();
    expect(remaining()).toEqual([]);
  });

  it("keeps the PR source queued on a transport failure without starting the agent", async () => {
    state.grantedEnvironments.add("secondary");
    const queued = queuedPullRequest();
    await state.manager.enqueue(queued);
    state.checkout.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Socket is not connected"))),
    );
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
  });

  it("restores the PR draft when the reused worktree cannot reach the PR head", async () => {
    state.grantedEnvironments.add("secondary");
    await state.manager.enqueue(queuedPullRequest());
    state.checkout.mockResolvedValueOnce(
      AsyncResult.success({ ...preparedCheckout, isOnPullRequestHead: false }),
    );
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([]);
    const { updateComposerDraftSettings } = await import("./use-composer-drafts");
    expect(updateComposerDraftSettings).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        workspaceSelection: expect.objectContaining({
          pullRequestReference: queuedPullRequest().creation?.pullRequestReference,
        }),
      }),
    );
  });

  it("stops launch if operation access is revoked while checking out the PR", async () => {
    state.grantedEnvironments.add("secondary");
    const queued = queuedPullRequest();
    await state.manager.enqueue(queued);
    state.checkout.mockImplementationOnce(async () => {
      state.grantedEnvironments.delete("secondary");
      return AsyncResult.success(preparedCheckout);
    });
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
  });

  it("does not launch a stale task edited while the PR checkout was running", async () => {
    state.grantedEnvironments.add("secondary");
    const queued = queuedPullRequest();
    await state.manager.enqueue(queued);
    const edited = { ...queued, text: "Updated instructions" };
    state.checkout.mockImplementationOnce(async () => {
      await state.manager.update(edited);
      return AsyncResult.success(preparedCheckout);
    });
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([edited]);
  });
});
afterEach(() => {
  state.cleanups.splice(0).forEach((cleanup) => cleanup());
});

describe("queued task operation access", () => {
  it("parks a connected read-only target, then delivers its unchanged queue after a grant", async () => {
    const queued = message();
    await state.manager.enqueue(queued);
    useThreadOutboxDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
    state.grantedEnvironments.add("secondary");
    await runDrain();
    expect(state.start).toHaveBeenCalledOnce();
    expect(remaining()).toEqual([]);
  });

  it("stops the remaining settings and turn commands when an earlier update loses access", async () => {
    state.grantedEnvironments.add("secondary");
    const queued = message({
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "different-model" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    await state.manager.enqueue(queued);
    state.runtime.mockImplementationOnce(async () => {
      state.grantedEnvironments.delete("secondary");
      return AsyncResult.success(undefined);
    });
    await runDrain();
    expect(state.runtime).toHaveBeenCalledOnce();
    expect(state.interaction).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
  });

  it.each([
    { isCreation: false, accepted: false },
    { isCreation: true, accepted: false },
    { isCreation: false, accepted: true },
    { isCreation: true, accepted: true },
  ])(
    "preserves a rejected queue but removes an accepted turn after access loss (new task: $isCreation, accepted: $accepted)",
    async ({ isCreation, accepted }) => {
      state.grantedEnvironments.add("secondary");
      const queued = message(
        isCreation
          ? {
              threadId: ThreadId.make("new-thread"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
              creation: {
                projectId: ProjectId.make("project"),
                projectCwd: "/repo",
                workspaceMode: "local",
                branch: null,
                worktreePath: null,
              },
            }
          : {},
      );
      await state.manager.enqueue(queued);
      const started = Promise.withResolvers<void>();
      const delivery = Promise.withResolvers<AsyncResult.AsyncResult<void, Error>>();
      state.start.mockImplementationOnce(() => {
        started.resolve();
        return delivery.promise;
      });
      const drained = runDrain();
      await started.promise;
      state.grantedEnvironments.delete("secondary");
      delivery.resolve(
        accepted
          ? AsyncResult.success(undefined)
          : AsyncResult.failure(Cause.fail(new Error("This connection cannot control this task."))),
      );
      await drained;

      expect(remaining()).toEqual(accepted ? [] : [queued]);
      expect(state.draftText).toBe("Keep this draft separate");
      if (!accepted) {
        state.grantedEnvironments.add("secondary");
        await runDrain();
        expect(state.start).toHaveBeenCalledTimes(2);
        expect(remaining()).toEqual([]);
        expect(state.draftText).toBe("Keep this draft separate");
      }
    },
  );

  it.each([
    { isCreation: false, uploadFails: false },
    { isCreation: true, uploadFails: false },
    { isCreation: false, uploadFails: true },
    { isCreation: true, uploadFails: true },
  ])(
    "keeps the message queued after upload revocation (new task: $isCreation, upload fails: $uploadFails)",
    async ({ isCreation, uploadFails }) => {
      state.grantedEnvironments.add("secondary");
      const queued = message(
        isCreation
          ? {
              threadId: ThreadId.make("new-thread"),
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
              creation: {
                projectId: ProjectId.make("project"),
                projectCwd: "/repo",
                workspaceMode: "local",
                branch: null,
                worktreePath: null,
              },
            }
          : {},
      );
      await state.manager.enqueue(queued);
      state.prepare.mockImplementationOnce(async ({ attachments }) => {
        state.grantedEnvironments.delete("secondary");
        if (uploadFails) throw new Error("This connection cannot upload attachments.");
        return {
          status: "ready",
          attachments: [],
          draftAttachments: attachments,
          pendingAttachmentIds: [],
        };
      });
      await runDrain();
      expect(state.prepare).toHaveBeenCalledOnce();
      expect(state.start).not.toHaveBeenCalled();
      expect(remaining()).toEqual([queued]);
    },
  );
});

describe("queued Muse native attach", () => {
  const museIdentity = "a".repeat(64);
  const museThreadId = `muse-agent:${museIdentity}`;
  const museProvider = ProviderInstanceId.make("historical-muse");

  function configureMuseThread() {
    state.thread.id = museThreadId;
    state.thread.providerInstanceId = museProvider;
    state.thread.modelSelection = { instanceId: museProvider, model: "muse" };
    state.threads.splice(0, state.threads.length, state.thread);
    state.config.providers = [{ instanceId: museProvider, driver: "muse-agent" }];
    state.museOpenedThreadId = museThreadId;
  }

  function museMessage(overrides: Partial<QueuedThreadMessage> = {}) {
    return message({
      threadId: ThreadId.make(museThreadId),
      modelSelection: { instanceId: museProvider, model: "muse" },
      ...overrides,
    });
  }

  it("does not call Muse RPC on ordinary send", async () => {
    state.grantedEnvironments.add("secondary");
    const queued = message();
    await state.manager.enqueue(queued);
    await runDrain();
    expect(state.openMuse).not.toHaveBeenCalled();
    expect(state.start).toHaveBeenCalledOnce();
    expect(remaining()).toEqual([]);
  });

  it("reattaches a queued Muse message before startTurn without a route", async () => {
    configureMuseThread();
    state.grantedEnvironments.add("secondary");
    const queued = museMessage();
    await state.manager.enqueue(queued);
    await runDrain();
    expect(state.openMuse).toHaveBeenCalledOnce();
    expect(state.openMuse).toHaveBeenCalledWith({
      environmentId: "secondary",
      input: { providerInstanceId: museProvider },
    });
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.start.mock.calls[0]?.[0].input.threadId).toBe(museThreadId);
    expect(remaining()).toEqual([]);
  });

  it("opens Muse after delayed prep, then starts the turn", async () => {
    configureMuseThread();
    state.grantedEnvironments.add("secondary");
    const queued = museMessage();
    await state.manager.enqueue(queued);
    const prepared = Promise.withResolvers<void>();
    const finishPrep = Promise.withResolvers<{
      status: "ready";
      attachments: [];
      draftAttachments: QueuedThreadMessage["attachments"];
      pendingAttachmentIds: [];
    }>();
    state.prepare.mockImplementationOnce(async ({ attachments }) => {
      prepared.resolve();
      await finishPrep.promise;
      return {
        status: "ready",
        attachments: [],
        draftAttachments: attachments,
        pendingAttachmentIds: [],
      };
    });
    const drained = runDrain();
    await prepared.promise;
    expect(state.openMuse).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
    finishPrep.resolve({
      status: "ready",
      attachments: [],
      draftAttachments: queued.attachments,
      pendingAttachmentIds: [],
    });
    await drained;
    expect(state.openMuse).toHaveBeenCalledOnce();
    expect(state.start).toHaveBeenCalledOnce();
    expect(remaining()).toEqual([]);
  });

  it("keeps a Muse entry queued when prep spans a disconnect", async () => {
    configureMuseThread();
    state.grantedEnvironments.add("secondary");
    const queued = museMessage();
    await state.manager.enqueue(queued);
    state.prepare.mockImplementationOnce(async ({ attachments }) => {
      state.connectedEnvironments = [
        {
          environmentId: "secondary",
          connectionState: "disconnected",
        },
      ];
      state.connection = { phase: "backoff", generation: 2 };
      appAtomRegistry.refresh(environmentCatalog.stateAtom(EnvironmentId.make("secondary")));
      return {
        status: "ready",
        attachments: [],
        draftAttachments: attachments,
        pendingAttachmentIds: [],
      };
    });
    await runDrain();
    expect(state.openMuse).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
    state.connectedEnvironments = [{ environmentId: "secondary", connectionState: "connected" }];
    state.connection = { phase: "connected", generation: 3 };
    appAtomRegistry.refresh(environmentCatalog.stateAtom(EnvironmentId.make("secondary")));
    await runDrain();
    expect(state.openMuse).toHaveBeenCalledOnce();
    expect(state.start).toHaveBeenCalledOnce();
    expect(remaining()).toEqual([]);
  });

  it("keeps a Muse entry queued when open returns another account", async () => {
    configureMuseThread();
    state.grantedEnvironments.add("secondary");
    const queued = museMessage();
    await state.manager.enqueue(queued);
    state.museOpenedThreadId = `muse-agent:${"b".repeat(64)}`;
    await runDrain();
    expect(state.openMuse).toHaveBeenCalledOnce();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
    expect(state.draftText).toBe("Keep this draft separate");
  });

  it("keeps a Muse entry queued when operate permission is lost during open", async () => {
    configureMuseThread();
    state.grantedEnvironments.add("secondary");
    const queued = museMessage();
    await state.manager.enqueue(queued);
    state.openMuse.mockImplementationOnce(async () => {
      state.grantedEnvironments.delete("secondary");
      return AsyncResult.success({ threadId: museThreadId });
    });
    await runDrain();
    expect(state.openMuse).toHaveBeenCalledOnce();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
  });

  it.each([true, false])(
    "restores unsupported Muse to its draft (historical identity: %s)",
    async (hasIdentity) => {
      configureMuseThread();
      state.config.providers = [{ instanceId: museProvider, driver: "codex" }];
      state.grantedEnvironments.add("secondary");
      const queued = museMessage(hasIdentity ? {} : { modelSelection: undefined });
      await state.manager.enqueue(queued);
      await runDrain();
      expect(state.openMuse).not.toHaveBeenCalled();
      expect(state.start).not.toHaveBeenCalled();
      expect(remaining()).toEqual([]);
      expect(state.draftText).toContain(queued.text);
    },
  );

  it("delivers an ordinary thread after recovering unsupported Muse", async () => {
    configureMuseThread();
    state.config.providers = [{ instanceId: museProvider, driver: "codex" }];
    const ordinaryThread = {
      ...state.thread,
      id: "thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    };
    state.threads.splice(0, state.threads.length, state.thread, ordinaryThread);
    state.grantedEnvironments.add("secondary");
    const museQueued = museMessage({
      modelSelection: undefined,
      messageId: MessageId.make("muse-message"),
    });
    const ordinaryQueued = message({
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("ordinary-message"),
      commandId: CommandId.make("ordinary-command"),
    });
    await state.manager.enqueue(museQueued);
    await state.manager.enqueue(ordinaryQueued);
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    await runDrain();
    expect(state.openMuse).not.toHaveBeenCalled();
    expect(state.start).toHaveBeenCalledOnce();
    expect(state.start.mock.calls[0]?.[0].input.threadId).toBe("thread");
    expect(remaining()).toEqual([]);
    expect(state.draftText).toContain(museQueued.text);
  });

  it("does not startTurn a Muse payload edited during attach", async () => {
    configureMuseThread();
    state.grantedEnvironments.add("secondary");
    const queued = museMessage();
    await state.manager.enqueue(queued);
    const edited = { ...queued, text: "Edited after enqueue" };
    state.openMuse.mockImplementationOnce(async () => {
      await state.manager.update(edited);
      return AsyncResult.success({ threadId: museThreadId });
    });
    await runDrain();
    expect(state.openMuse).toHaveBeenCalledOnce();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([edited]);
  });

  it("retains failed Muse opens and clears their feedback after a successful retry", async () => {
    configureMuseThread();
    state.grantedEnvironments.add("secondary");
    const queued = museMessage();
    await state.manager.enqueue(queued);
    state.openMuse.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("offline"))));
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
    expect(Object.values(appAtomRegistry.get(threadComposerErrorsAtom))).toEqual([
      expect.objectContaining({
        messageId: queued.messageId,
        message: expect.stringContaining("reconnect"),
      }),
    ]);
    await runDrain();
    expect(state.start).toHaveBeenCalledOnce();
    expect(remaining()).toEqual([]);
    expect(appAtomRegistry.get(threadComposerErrorsAtom)).toEqual({});
  });

  it("does not send a message cancelled during native open", async () => {
    configureMuseThread();
    state.grantedEnvironments.add("secondary");
    const queued = museMessage();
    await state.manager.enqueue(queued);
    state.openMuse.mockImplementationOnce(async () => {
      await state.manager.remove(queued);
      return AsyncResult.success({ threadId: museThreadId });
    });
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([]);
  });

  it("keeps a message queued when the connection changes during native open", async () => {
    configureMuseThread();
    state.grantedEnvironments.add("secondary");
    const queued = museMessage();
    await state.manager.enqueue(queued);
    state.openMuse.mockImplementationOnce(async () => {
      state.connectedEnvironments = [{ environmentId: "secondary", connectionState: "connected" }];
      state.connection = { phase: "connected", generation: 2 };
      appAtomRegistry.refresh(environmentCatalog.stateAtom(EnvironmentId.make("secondary")));
      return AsyncResult.success({ threadId: museThreadId });
    });
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
  });

  it("does not dispatch while the queue editor owns the message", async () => {
    configureMuseThread();
    state.grantedEnvironments.add("secondary");
    const queued = museMessage();
    await state.manager.enqueue(queued);
    state.openMuse.mockImplementationOnce(async () => {
      appAtomRegistry.set(editingQueuedMessageIdsAtom, { [queued.messageId]: true });
      return AsyncResult.success({ threadId: museThreadId });
    });
    await runDrain();
    expect(state.start).not.toHaveBeenCalled();
    expect(remaining()).toEqual([queued]);
  });

  it("infers an old Muse row from the exact advertised live thread", async () => {
    configureMuseThread();
    state.grantedEnvironments.add("secondary");
    const queued = museMessage({ modelSelection: undefined });
    await state.manager.enqueue(queued);
    await runDrain();
    expect(state.openMuse).toHaveBeenCalledOnce();
    expect(state.start).toHaveBeenCalledOnce();
    expect(remaining()).toEqual([]);
  });
});
