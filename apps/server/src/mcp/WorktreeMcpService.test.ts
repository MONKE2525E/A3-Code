import * as FileSystem from "effect/FileSystem";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ServerConfig from "../config.ts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorktreeMcpHandoffInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import {
  OrchestratorDispatchError,
  OrchestratorProjectionError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";

const environmentId = EnvironmentId.make("environment-worktree-test");
const threadId = ThreadId.make("thread-worktree-test");
const projectId = ProjectId.make("project-worktree-test");
const workspaceRoot = "/repo/project";

const makeScope = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session-worktree-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-worktree-test",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  capabilities,
  issuedAt: 1,
});

interface ThreadFixture {
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
}

const makeProjection = (overrides: ThreadFixture = {}): OrchestrationV2ThreadProjection =>
  ({
    thread: {
      id: threadId,
      projectId,
      title: "Worktree test thread",
      branch: null,
      worktreePath: null,
      archivedAt: null,
      deletedAt: null,
      ...overrides,
    },
  }) as OrchestrationV2ThreadProjection;

const project: Project = {
  id: projectId,
  title: "Worktree test project",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
} as Project;

interface HarnessOptions {
  readonly git?: Partial<GitWorkflowService.GitWorkflowService["Service"]>;
  readonly existingBranchWorktreePath?: string | null;
  readonly fetchWorktreeBaseFails?: boolean;
  readonly worktreeBaseMissing?: boolean;
  readonly thread?: ThreadFixture | null;
  readonly threadReadError?: "projection" | "dispatch";
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  readonly currentBranch?: string | null;
  readonly notARepo?: boolean;
  readonly newWorktreesStartFromOrigin?: boolean;
  readonly setupScript?: "started" | "no-script" | "fails" | "dies";
  readonly dispatchFails?: boolean;
  readonly dispatchDies?: boolean;
  readonly dispatchInterrupts?: boolean;
  readonly dispatchGate?: Effect.Effect<void>;
  readonly threadAttachedOnRecheck?: boolean;
  readonly threadArchivedOnRecheck?: boolean;
  readonly threadReadFailsOnRecheck?: boolean;
  readonly continuation?: "queued" | "fails" | "dies";
  readonly projectMissing?: boolean;
  readonly projectReadFails?: boolean;
  readonly allocatedBranch?: string;
  readonly createdBranch?: boolean | null;
  readonly deleteLocalBranchFails?: boolean;
  readonly pathSemantics?: "win32" | "posix";
  readonly createWorktreeFails?: boolean;
  readonly fetchRemoteFails?: boolean;
  readonly resolveRemoteFails?: boolean;
  readonly removeWorktreeFails?: boolean;
  readonly createWorktreeGate?: Effect.Effect<void>;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const thread = options.thread === undefined ? {} : options.thread;
  const scope = makeScope(options.capabilities ?? new Set(["preview", "worktree"]));
  const dispatch = vi.fn((_: unknown) =>
    (options.dispatchGate ?? Effect.void).pipe(
      Effect.andThen(
        options.dispatchInterrupts
          ? (Effect.failCause(Cause.interrupt()) as never)
          : options.dispatchDies
            ? Effect.die(new Error("dispatch defect"))
            : options.dispatchFails
              ? (Effect.fail("simulated dispatch failure") as never)
              : Effect.succeed({ sequence: 1, storedEvents: [] }),
      ),
    ),
  );
  const getThreadRecords = vi.fn((id: ThreadId) => {
    if (options.threadReadError === "dispatch") {
      return Effect.fail(
        new OrchestratorDispatchError({
          commandId: CommandId.make("command:test:read"),
          commandType: "thread.metadata.update",
        }),
      ) as never;
    }
    if (options.threadReadFailsOnRecheck === true && getThreadRecords.mock.calls.length > 1) {
      return Effect.fail(
        new OrchestratorDispatchError({
          commandId: CommandId.make("command:test:recheck"),
          commandType: "thread.metadata.update",
        }),
      ) as never;
    }
    if (
      options.threadAttachedOnRecheck === true &&
      getThreadRecords.mock.calls.length > 1 &&
      thread !== null
    ) {
      return Effect.succeed(
        makeProjection({ ...thread, worktreePath: "/worktrees/project/raced" }),
      );
    }
    if (
      options.threadArchivedOnRecheck === true &&
      getThreadRecords.mock.calls.length > 1 &&
      thread !== null
    ) {
      return Effect.succeed(makeProjection({ ...thread, archivedAt: "2026-01-02T00:00:00.000Z" }));
    }
    return id === threadId && thread !== null
      ? Effect.succeed(makeProjection(thread))
      : Effect.fail(new OrchestratorProjectionError({ threadId: id }));
  });
  const sendToThread = vi.fn((_: unknown) => {
    switch (options.continuation ?? "queued") {
      case "fails":
        return Effect.fail(
          new ThreadManagementService.ThreadManagementThreadArchivedError({
            threadId,
          }),
        );
      case "dies":
        return Effect.die(new Error("send defect"));
      default:
        return Effect.succeed({
          delivery: "queued",
        } as ThreadManagementService.ThreadManagementSendResult);
    }
  });
  const getById = vi.fn((id: ProjectId) =>
    options.projectReadFails
      ? (Effect.fail("simulated project read failure") as never)
      : Effect.succeed(
          id === projectId && options.projectMissing !== true
            ? Option.some(project)
            : Option.none(),
        ),
  );
  const removeWorktree = vi.fn((_: unknown) =>
    options.removeWorktreeFails
      ? (Effect.fail("simulated worktree removal failure") as never)
      : Effect.void,
  );
  const deleteLocalBranch = vi.fn((_: unknown) =>
    options.deleteLocalBranchFails
      ? (Effect.fail("branch has unmerged commits") as never)
      : Effect.void,
  );
  const fetchRemote = vi.fn((_: unknown) =>
    options.fetchRemoteFails ? (Effect.fail("simulated fetch failure") as never) : Effect.void,
  );
  const resolveRemoteTrackingCommit = vi.fn((_: unknown) =>
    options.resolveRemoteFails
      ? (Effect.fail("simulated remote resolve failure") as never)
      : Effect.succeed({ commitSha: "abc123", remoteRefName: "origin/dev" }),
  );
  const fetchWorktreeBaseCommit = vi.fn((_: unknown) =>
    options.fetchWorktreeBaseFails
      ? (Effect.fail("simulated fetch failure") as never)
      : options.worktreeBaseMissing
        ? Effect.succeed(null)
        : Effect.succeed({ commitSha: "abc123", remoteRefName: "origin/dev" }),
  );
  const createWorktree = vi.fn(
    (input: { readonly newRefName?: string | undefined; readonly path: string | null }) =>
      options.createWorktreeFails
        ? (Effect.fail("simulated worktree creation failure") as never)
        : (options.createWorktreeGate ?? Effect.void).pipe(
            Effect.andThen(
              Effect.succeed({
                ...(options.createdBranch === null || options.createdBranch === false
                  ? {}
                  : { createdBranch: { commitSha: "created-tip" } }),
                worktree: {
                  path:
                    input.path ??
                    `/worktrees/project/${options.allocatedBranch ?? input.newRefName}`,
                  refName: options.allocatedBranch ?? input.newRefName ?? "detached",
                },
              }),
            ),
          ),
  );
  const listRefs = vi.fn((input: { readonly query?: string | undefined }) =>
    Effect.succeed({
      refs:
        options.existingBranchWorktreePath === undefined
          ? []
          : [
              {
                name: input.query ?? "",
                current: false,
                isDefault: false,
                worktreePath: options.existingBranchWorktreePath,
              },
            ],
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: options.existingBranchWorktreePath === undefined ? 0 : 1,
    }),
  );
  const localStatus = vi.fn((_: unknown) =>
    Effect.succeed({
      isRepo: options.notARepo !== true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: options.currentBranch === undefined ? "dev" : options.currentBranch,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    }),
  );
  const refreshStatus = vi.fn((_: string) => Effect.die("refreshStatus stub"));
  const runForThread = vi.fn((input: { readonly worktreePath: string }) => {
    switch (options.setupScript ?? "started") {
      case "no-script":
        return Effect.succeed({ status: "no-script" } as const);
      case "dies":
        return Effect.die(new Error("setup runner defect"));
      case "fails":
        return Effect.fail(
          new ProjectSetupScriptRunner.ProjectSetupScriptProjectNotFoundError({
            threadId,
            worktreePath: input.worktreePath,
          }),
        );
      default:
        return Effect.succeed({
          status: "started",
          async: false,
          scriptId: "setup",
          scriptName: "Setup",
          scriptCommand: "vp install",
          terminalId: "setup-terminal",
          cwd: input.worktreePath,
        } as const);
    }
  });

  // Provide deterministic Path semantics before NodeServices so either platform can be tested.
  const win32IsAbsolute = (value: string) => /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value);
  const posixIsAbsolute = (value: string) => value.startsWith("/");
  const layerService =
    options.pathSemantics === undefined
      ? WorktreeMcpService.layer
      : WorktreeMcpService.layer.pipe(
          Layer.provide(
            Layer.succeed(Path.Path, {
              isAbsolute: options.pathSemantics === "win32" ? win32IsAbsolute : posixIsAbsolute,
            } as unknown as Path.Path),
          ),
        );
  const layer = layerService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch,
          getThreadRecords,
          sendToThread,
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProjectService.ProjectService)({
          getById,
        } satisfies Partial<ProjectService.ProjectService["Service"]>),
        ServerSettings.layerTest({
          newWorktreesStartFromOrigin: options.newWorktreesStartFromOrigin ?? false,
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus,
          listRefs,
          listLocalBranchNames: () =>
            Effect.succeed(
              options.existingBranchWorktreePath === undefined ? [] : ["feature/taken"],
            ),
          fetchWorktreeBaseCommit,
          fetchRemote,
          resolveRemoteTrackingCommit,
          createWorktree,
          removeWorktree,
          deleteLocalBranch,
          ...options.git,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread,
        } satisfies Partial<ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]>),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshStatus,
        } satisfies Partial<VcsStatusBroadcaster.VcsStatusBroadcaster["Service"]>),
        NodeServices.layer,
      ),
    ),
  );

  return {
    layer,
    scope,
    dispatch,
    sendToThread,
    fetchWorktreeBaseCommit,
    fetchRemote,
    resolveRemoteTrackingCommit,
    createWorktree,
    removeWorktree,
    deleteLocalBranch,
    localStatus,
    runForThread,
  };
};

const expectTypedFailure = (exit: Exit.Exit<unknown, unknown>, expected: object): void => {
  if (!Exit.isFailure(exit)) {
    expect.fail(`Expected a failure exit, got: ${JSON.stringify(exit)}`);
  }
  const reason = exit.cause.reasons[0];
  if (reason?._tag !== "Fail") {
    expect.fail(`Expected a typed Fail cause, got: ${reason?._tag ?? "no reason"}`);
  }
  expect(reason.error).toMatchObject(expected);
};

// Resolve once so calls share the in-flight guard.
const resolveService = (harness: ReturnType<typeof makeHarness>) =>
  WorktreeMcpService.WorktreeMcpService.pipe(Effect.provide(harness.layer));

const runHandoff = (
  harness: ReturnType<typeof makeHarness>,
  input: Parameters<WorktreeMcpService.WorktreeMcpService["Service"]["handoff"]>[1],
) =>
  Effect.gen(function* () {
    const service = yield* WorktreeMcpService.WorktreeMcpService;
    return yield* service.handoff(harness.scope, input);
  }).pipe(Effect.provide(harness.layer));

const runStatus = (harness: ReturnType<typeof makeHarness>) =>
  Effect.gen(function* () {
    const service = yield* WorktreeMcpService.WorktreeMcpService;
    return yield* service.status(harness.scope);
  }).pipe(Effect.provide(harness.layer));

const decodeHandoffInput = Schema.decodeUnknownEffect(WorktreeMcpHandoffInput);

describe("t3_worktree_handoff", () => {
  it.effect("reports a continuation failure without failing the handoff", () => {
    const harness = makeHarness({ continuation: "fails" });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, {
        branch: "feature/continue-fails",
        continuationPrompt: "Keep going.",
      });
      expect(result.continuation).toMatchObject({ status: "failed" });
      expect(result.worktreePath).toBe("/worktrees/project/feature/continue-fails");
      expect(harness.dispatch).toHaveBeenCalled();
    });
  });

  it.effect("does not queue a continuation when the thread update fails", () => {
    const harness = makeHarness({ dispatchFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        runHandoff(harness, {
          branch: "feature/dispatch-fails-continue",
          continuationPrompt: "Keep going.",
        }),
      );
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.sendToThread).not.toHaveBeenCalled();
    });
  });

  it.effect("fails when the thread is already attached to a worktree", () => {
    const harness = makeHarness({
      thread: { branch: "feature/existing", worktreePath: "/worktrees/project/existing" },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/second" }));
      expectTypedFailure(exit, {
        _tag: "WorktreeMcpFailure",
        code: "already_in_worktree",
      });
      expect(harness.createWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect.each(["feature/taken", "feature/taken-2"])(
    "binds the branch allocated by the driver (%s)",
    (allocatedBranch) => {
      const harness = makeHarness({ allocatedBranch });
      return Effect.gen(function* () {
        const result = yield* runHandoff(harness, { branch: "feature/taken" });
        expect(result.branch).toBe(allocatedBranch);
        expect(result.worktreePath).toBe(`/worktrees/project/${allocatedBranch}`);
        expect(harness.dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "thread.metadata.update",
            branch: allocatedBranch,
            worktreePath: result.worktreePath,
          }),
        );
        expect(harness.createWorktree).toHaveBeenCalledTimes(1);
      });
    },
  );

  it.effect("propagates an interrupted dispatch without rolling back the worktree", () => {
    const harness = makeHarness({ dispatchInterrupts: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/dispatch-int" }));
      if (!Exit.isFailure(exit)) {
        return expect.fail("expected a failure exit");
      }
      // Whether the binding committed is unknown on interruption, so the
      // worktree must not be force-deleted and no typed failure is invented.
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(harness.removeWorktree).not.toHaveBeenCalled();
    });
  });

  it.effect("removes the created worktree when the thread update dies with a defect", () => {
    const harness = makeHarness({ dispatchDies: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/dispatch-defect" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/dispatch-defect",
        force: true,
      });
    });
  });

  it.effect("re-checks attachment after creating the worktree and backs out on a race", () => {
    const harness = makeHarness({ threadAttachedOnRecheck: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/raced" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "already_in_worktree" });
      expect(harness.createWorktree).toHaveBeenCalledTimes(1);
      // The freshly created worktree must not be left orphaned.
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/raced",
        force: true,
      });
      expect(harness.deleteLocalBranch).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        refName: "feature/raced",
        expectedCommitSha: "created-tip",
      });
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("removes the created worktree when the recheck read fails", () => {
    const harness = makeHarness({ threadReadFailsOnRecheck: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/recheck-fails" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/recheck-fails",
        force: true,
      });
      expect(harness.dispatch).not.toHaveBeenCalled();
    });
  });

  it.effect("backs out when the thread is archived during worktree creation", () => {
    const harness = makeHarness({ threadArchivedOnRecheck: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/archived-race" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "invalid_request" });
      expect(harness.dispatch).not.toHaveBeenCalled();
      // The created worktree must not be left orphaned.
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature/archived-race",
        force: true,
      });
    });
  });

  it.effect("queues the continuation even when interrupted during the binding dispatch", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const harness = makeHarness({ dispatchGate: Deferred.await(gate) });

      // Interrupt arrives while the metadata dispatch is in flight; the
      // binding-plus-continuation section must run to completion anyway so the
      // continuation is never lost between the commit and the queue.
      const fiber = yield* Effect.forkChild(
        runHandoff(harness, {
          branch: "feature/interrupted",
          continuationPrompt: "Keep going in the worktree.",
        }),
      );
      yield* Effect.yieldNow;
      const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.await(fiber);
      yield* Fiber.join(interruption);

      expect(harness.dispatch).toHaveBeenCalledTimes(1);
      expect(harness.sendToThread).toHaveBeenCalledTimes(1);
      // The setup script must also survive the pending interrupt; otherwise
      // the continuation run starts in a worktree that was never set up.
      expect(harness.runForThread).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect.each([false, null])(
    "preserves reused or legacy branches when binding fails (%s)",
    (createdBranch) => {
      const harness = makeHarness({ dispatchFails: true, createdBranch });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/keep-commits" }));
        expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
        expect(harness.removeWorktree).toHaveBeenCalledTimes(1);
        expect(harness.deleteLocalBranch).not.toHaveBeenCalled();
      });
    },
  );

  it.effect("cleans up the allocated suffix branch when binding fails", () => {
    const harness = makeHarness({ dispatchFails: true, allocatedBranch: "feature-2" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.removeWorktree).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        path: "/worktrees/project/feature-2",
        force: true,
      });
      expect(harness.deleteLocalBranch).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        refName: "feature-2",
        expectedCommitSha: "created-tip",
      });
    });
  });

  it.effect("keeps the original failure when a new branch cannot be safely deleted", () => {
    const harness = makeHarness({ dispatchFails: true, deleteLocalBranchFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/keep-new-commits" }));
      expectTypedFailure(exit, { _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(harness.deleteLocalBranch).toHaveBeenCalledWith({
        cwd: workspaceRoot,
        refName: "feature/keep-new-commits",
        expectedCommitSha: "created-tip",
      });
    });
  });

  it.effect("releases the per-thread guard after a failed handoff", () => {
    const harness = makeHarness({
      thread: { worktreePath: "/worktrees/project/existing" },
    });
    return Effect.gen(function* () {
      const service = yield* resolveService(harness);

      const first = yield* Effect.exit(
        service.handoff(harness.scope, { branch: "feature/guard-1" }),
      );
      expectTypedFailure(first, { _tag: "WorktreeMcpFailure", code: "already_in_worktree" });
      // A leaked guard would surface as handoff_in_progress here.
      const second = yield* Effect.exit(
        service.handoff(harness.scope, { branch: "feature/guard-2" }),
      );
      expectTypedFailure(second, { _tag: "WorktreeMcpFailure", code: "already_in_worktree" });
    });
  });

  it.effect("serializes concurrent handoffs for the same thread", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const harness = makeHarness({ createWorktreeGate: Deferred.await(gate) });

      const service = yield* resolveService(harness);

      // First handoff acquires the per-thread guard and blocks on the gate.
      const first = yield* Effect.forkChild(
        Effect.exit(service.handoff(harness.scope, { branch: "feature/race-1" })),
      );
      yield* Effect.yieldNow;

      // Second handoff for the same thread must be refused while the first
      // is still in flight.
      const second = yield* Effect.exit(
        service.handoff(harness.scope, { branch: "feature/race-2" }),
      );
      expectTypedFailure(second, { _tag: "WorktreeMcpFailure", code: "handoff_in_progress" });

      yield* Deferred.succeed(gate, undefined);
      const firstExit = yield* Fiber.join(first);
      expect(Exit.isSuccess(firstExit)).toBe(true);
      expect(harness.createWorktree).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("reports a setup script defect without failing the handoff", () => {
    const harness = makeHarness({ setupScript: "dies" });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/setup-dies" });
      expect(result.setupScript).toEqual({ status: "failed", detail: "setup runner defect" });
      expect(harness.dispatch).toHaveBeenCalled();
    });
  });

  it.effect("creates the worktree in the managed directory even when a call names a path", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const input = yield* decodeHandoffInput({
        branch: "feature/elsewhere",
        path: "/home/user/.ssh/checkout",
      });
      const result = yield* runHandoff(harness, input);
      expect(harness.createWorktree).toHaveBeenCalledWith(expect.objectContaining({ path: null }));
      expect(result.worktreePath).toBe("/worktrees/project/feature/elsewhere");
    });
  });

  it.effect("falls back to the local base when no remote holds it", () => {
    const harness = makeHarness({ worktreeBaseMissing: true });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, {
        branch: "feature/local-fallback",
        baseRef: "dev",
        startFromOrigin: true,
      });
      expect(harness.createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({ refName: "dev", baseRefName: "dev" }),
      );
      expect(result.startedFromOrigin).toBe(false);
    });
  });

  it.effect("does not trip the pre-flight on similarly named branches", () => {
    const harness = makeHarness({ existingBranchWorktreePath: null });
    return Effect.gen(function* () {
      const result = yield* runHandoff(harness, { branch: "feature/take" });
      expect(result.branch).toBe("feature/take");
      expect(harness.createWorktree).toHaveBeenCalledTimes(1);
    });
  });

  it.effect("rejects an existing branch with an actionable error naming its checkout", () => {
    const harness = makeHarness({ existingBranchWorktreePath: "/elsewhere/checkout" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(runHandoff(harness, { branch: "feature/taken" }));
      if (!Exit.isFailure(exit)) {
        return expect.fail("expected a failure exit");
      }
      const reason = exit.cause.reasons[0];
      expect(reason?._tag).toBe("Fail");
      const error = (reason as { readonly error: { code: string; message: string } }).error;
      expect(error.code).toBe("invalid_request");
      expect(error.message).toContain("feature/taken");
      expect(error.message).toContain("already exists");
      expect(error.message).toContain("/elsewhere/checkout");
      expect(harness.createWorktree).not.toHaveBeenCalled();
      expect(harness.fetchWorktreeBaseCommit).not.toHaveBeenCalled();
    });
  });

  it.effect("uses the fetched commit and remote PR base for an explicit local alias", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-remote-base-" });
      const cwd = `${directory}/repo`;
      const remote = `${directory}/remote.git`;
      const worktreePath = `${directory}/worktree`;
      yield* fs.makeDirectory(cwd);
      const command = (at: string, args: string[]) =>
        git.execute({ operation: "handoff-test", cwd: at, args });
      yield* command(cwd, ["init", "-b", "stable"]);
      yield* command(cwd, ["config", "user.name", "Test"]);
      yield* command(cwd, ["config", "user.email", "test@example.test"]);
      yield* command(cwd, ["commit", "--allow-empty", "-m", "remote base"]);
      const remoteHead = (yield* command(cwd, ["rev-parse", "HEAD"])).stdout.trim();
      yield* command(cwd, ["init", "--bare", remote]);
      yield* command(cwd, ["remote", "add", "upstream", remote]);
      yield* command(cwd, ["push", "-u", "upstream", "stable:release"]);
      yield* command(cwd, ["commit", "--allow-empty", "-m", "local only"]);
      const harness = makeHarness({
        git: {
          fetchWorktreeBaseCommit: (input) => git.fetchWorktreeBaseCommit({ ...input, cwd }),
          createWorktree: (input) => git.createWorktree({ ...input, cwd, path: worktreePath }),
        },
      });
      const result = yield* runHandoff(harness, {
        branch: "feature/from-remote",
        baseRef: "stable",
        startFromOrigin: true,
        runSetupScript: false,
      });

      expect(result.worktreePath).toBe(worktreePath);
      expect(result.startedFromOrigin).toBe(true);
      expect(result.setupScript).toEqual({ status: "skipped" });
      expect((yield* command(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(remoteHead);
      const preview = yield* git.getReviewDiffPreview({ cwd: worktreePath });
      const comparisonBase = preview.sources.find(
        (source) => source.kind === "branch-range",
      )!.baseRef;
      expect(
        (yield* command(worktreePath, ["rev-parse", `${comparisonBase}^{commit}`])).stdout.trim(),
      ).toBe(remoteHead);
    }).pipe(
      Effect.provide(
        GitVcsDriver.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "handoff-remote-git-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});

describe("t3_worktree_status", () => {
  it.effect("reports an attached thread's worktree and branch", () => {
    const harness = makeHarness({
      thread: {
        worktreePath: "/worktrees/project/existing",
        branch: "feature/existing",
      },
    });
    return Effect.gen(function* () {
      const result = yield* runStatus(harness);
      expect(result).toMatchObject({
        attached: true,
        worktreePath: "/worktrees/project/existing",
        branch: "feature/existing",
        defaultStartFromOrigin: false,
      });
    });
  });
});
