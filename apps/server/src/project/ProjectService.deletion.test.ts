import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { OrchestrationEffectRequestV2 } from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { planThreadDeletion } from "../orchestration-v2/ThreadDeletion.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./ProjectFaviconResolver.ts";
import * as ProjectService from "./ProjectService.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const layerEventPersistence = EventSink.layer.pipe(
  Layer.provideMerge(Layer.merge(EventStore.layer, ProjectionStore.layer)),
);
const layerServices = Layer.mergeAll(
  LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(layerEventPersistence)),
  ProjectionMaintenance.layer.pipe(Layer.provide(layerEventPersistence)),
  ProjectStore.layer,
  IdAllocator.layer,
  ThreadCommandExecutor.layer,
  Layer.succeed(WorkspacePaths.WorkspacePaths, {
    normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
      Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
  }),
).pipe(
  Layer.provideMerge(
    ProjectEnrichmentService.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
            resolve: () => Effect.succeed(null),
          }),
          Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
            resolvePath: () => Effect.succeed(null),
          }),
        ),
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
);
const layerDatabase = SqlitePersistence.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "project-deletion-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const decodeEffectRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationEffectRequestV2),
);

it.effect.each([false, true])(
  "refuses generic deletion of managed native storage, force=%s",
  (force) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const projectId = ProjectId.make("project:managed-native");
      yield* seedProject(projectId);
      yield* sql`UPDATE projection_projects SET workspace_root = ${path.resolve(config.baseDir, "native-agents")} WHERE project_id = ${projectId}`;
      yield* Effect.gen(function* () {
        const service = yield* ProjectService.make;
        const error = yield* Effect.flip(
          service.delete({
            commandId: CommandId.make(`command:delete-managed:${force}`),
            projectId,
            force,
          }),
        );
        assert.equal(error._tag, "ProjectProtectedError");
        assert.isTrue(Option.isSome(yield* service.getById(projectId)));
        const deleted =
          yield* sql`SELECT 1 FROM orchestration_events WHERE event_type = 'project.deleted'`;
        assert.lengthOf(deleted, 0);
      }).pipe(Effect.provide(layerServices));
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("keeps the managed workspace fixed while allowing its other metadata to change", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const projectId = ProjectId.make("project:managed-update");
    const root = path.resolve(config.baseDir, "native-agents");
    yield* seedProject(projectId);
    yield* sql`UPDATE projection_projects SET workspace_root = ${root} WHERE project_id = ${projectId}`;
    yield* Effect.gen(function* () {
      const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
      const service = yield* ProjectService.make.pipe(
        Effect.provideService(WorkspacePaths.WorkspacePaths, {
          ...workspacePaths,
          normalizeWorkspaceRoot: (requested) =>
            requested === "/work/unrelated-checkout"
              ? Effect.die("Managed moves must be rejected before inspecting the destination.")
              : workspacePaths.normalizeWorkspaceRoot(requested),
        }),
      );
      const error = yield* Effect.flip(
        service.update({
          commandId: CommandId.make("command:move-managed"),
          projectId,
          workspaceRoot: "/work/unrelated-checkout",
          title: "Moved",
        }),
      );
      assert.equal(error._tag, "ProjectProtectedError");
      assert.equal(error.message, "The managed AI Agents project cannot be moved.");
      const events =
        yield* sql`SELECT 1 FROM orchestration_events WHERE event_type = 'project.meta-updated'`;
      assert.lengthOf(events, 0);
      const unchanged = yield* service.getById(projectId);
      assert.equal(Option.getOrThrow(unchanged).workspaceRoot, root);
      assert.equal(Option.getOrThrow(unchanged).title, "Deletion test");
      const updated = yield* service.update({
        commandId: CommandId.make("command:rename-managed"),
        projectId,
        workspaceRoot: root,
        title: "Agents",
      });
      assert.equal(updated.workspaceRoot, root);
      assert.equal(updated.title, "Agents");
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each(["whitespace", "home", "relative-segments"] as const)(
  "accepts an equivalent managed workspace root using %s syntax",
  (syntax) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = path.resolve(config.baseDir, "native-agents");
      yield* fs.makeDirectory(root, { recursive: true });
      const projectId = ProjectId.make(`project:equivalent-root:${syntax}`);
      yield* seedProject(projectId);
      yield* sql`UPDATE projection_projects SET workspace_root = ${root} WHERE project_id = ${projectId}`;
      const requested =
        syntax === "home"
          ? "~/native-agents"
          : syntax === "whitespace"
            ? `  ${root}  `
            : `${root}/../native-agents/.`;
      yield* Effect.gen(function* () {
        const service = yield* ProjectService.make.pipe(Effect.provide(WorkspacePaths.layer));
        const updated = yield* service.update({
          commandId: CommandId.make(`command:equivalent-root:${syntax}`),
          projectId,
          workspaceRoot: requested,
          title: "Updated agents",
        });
        assert.equal(updated.workspaceRoot, root);
        assert.equal(updated.title, "Updated agents");
      }).pipe(
        Effect.provide(layerServices),
        Effect.provideService(HostProcess.HomeDirectory, config.baseDir),
      );
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each(["create", "bootstrap", "update"] as const)(
  "rejects generic %s claims on an unregistered managed directory before filesystem access",
  (operation) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = path.resolve(config.baseDir, "native-agents");
      const projectId = ProjectId.make(`project:reserved-claim:${operation}`);
      if (operation === "update") yield* seedProject(projectId);
      assert.isFalse(yield* fs.exists(root));
      yield* Effect.gen(function* () {
        const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
        const service = yield* ProjectService.make.pipe(
          Effect.provideService(WorkspacePaths.WorkspacePaths, {
            ...workspacePaths,
            normalizeWorkspaceRoot: () =>
              Effect.die("Reserved claims must not touch the destination."),
          }),
        );
        const input = {
          commandId: CommandId.make(`command:reserved-claim:${operation}`),
          projectId,
          title: "Ordinary project",
          workspaceRoot: "  ~/native-agents  ",
          createWorkspaceRootIfMissing: true,
        };
        const claim =
          operation === "create"
            ? service.create(input).pipe(Effect.asVoid)
            : operation === "bootstrap"
              ? service.bootstrap(input).pipe(Effect.asVoid)
              : service.update(input).pipe(Effect.asVoid);
        const error = yield* claim.pipe(Effect.flip);
        assert.equal(error._tag, "ProjectProtectedError");
        assert.equal(error.message, "The AI Agents workspace is reserved for native agents.");
        const row = yield* service.getById(projectId);
        if (operation === "update")
          assert.equal(Option.getOrThrow(row).workspaceRoot, `/work/${projectId}`);
        else assert.isTrue(Option.isNone(row));
        const sql = yield* SqlClient.SqlClient;
        assert.lengthOf(yield* sql`SELECT 1 FROM orchestration_events`, 0);
        assert.isFalse(yield* fs.exists(root));
      }).pipe(
        Effect.provide(layerServices),
        Effect.provideService(HostProcess.HomeDirectory, config.baseDir),
      );
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each(["create", "bootstrap", "update"] as const)(
  "rejects a filesystem alias of managed storage through generic %s",
  (operation) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = path.resolve(config.baseDir, "native-agents");
      const alias = path.resolve(config.baseDir, "ordinary-looking-alias");
      yield* fs.makeDirectory(root, { recursive: true });
      yield* fs.symlink(root, alias);
      assert.equal(yield* fs.realPath(alias), yield* fs.realPath(root));
      const projectId = ProjectId.make(`project:alias-claim:${operation}`);
      if (operation === "update") yield* seedProject(projectId);
      yield* Effect.gen(function* () {
        const service = yield* ProjectService.make.pipe(Effect.provide(WorkspacePaths.layer));
        const input = {
          commandId: CommandId.make(`command:alias-claim:${operation}`),
          projectId,
          title: "Ordinary alias project",
          workspaceRoot: alias,
        };
        const claim =
          operation === "create"
            ? service.create(input).pipe(Effect.asVoid)
            : operation === "bootstrap"
              ? service.bootstrap(input).pipe(Effect.asVoid)
              : service.update(input).pipe(Effect.asVoid);
        const error = yield* claim.pipe(Effect.flip);
        assert.equal(error._tag, "ProjectProtectedError");
        const sql = yield* SqlClient.SqlClient;
        assert.lengthOf(yield* sql`SELECT 1 FROM orchestration_events`, 0);
      }).pipe(Effect.provide(layerServices));
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("rejects a parent alias before creating missing managed storage", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = path.resolve(config.baseDir, "native-agents");
    const aliasParent = path.resolve(config.baseDir, "parent-alias");
    yield* fs.symlink(config.baseDir, aliasParent);
    assert.isFalse(yield* fs.exists(root));
    yield* Effect.gen(function* () {
      const service = yield* ProjectService.make.pipe(Effect.provide(WorkspacePaths.layer));
      const error = yield* service
        .create({
          commandId: CommandId.make("command:missing-alias-claim"),
          projectId: ProjectId.make("project:missing-alias-claim"),
          title: "Parent alias",
          workspaceRoot: path.join(aliasParent, "native-agents"),
          createWorkspaceRootIfMissing: true,
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProjectProtectedError");
      assert.isFalse(yield* fs.exists(root));
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "accepts an alias of the owned managed directory without replacing its canonical root",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const root = path.resolve(config.baseDir, "native-agents");
      const alias = path.resolve(config.baseDir, "owned-alias");
      yield* fs.makeDirectory(root, { recursive: true });
      yield* fs.symlink(root, alias);
      const projectId = ProjectId.make("project:owned-alias");
      yield* seedProject(projectId);
      yield* sql`UPDATE projection_projects SET workspace_root = ${root} WHERE project_id = ${projectId}`;
      yield* Effect.gen(function* () {
        const service = yield* ProjectService.make.pipe(Effect.provide(WorkspacePaths.layer));
        const updated = yield* service.update({
          commandId: CommandId.make("command:owned-alias-update"),
          projectId,
          workspaceRoot: alias,
          title: "Updated through alias",
        });
        assert.equal(updated.workspaceRoot, root);
        assert.equal(updated.title, "Updated through alias");
      }).pipe(Effect.provide(layerServices));
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("continues to accept a symlink to an ordinary directory", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = path.resolve(config.baseDir, "ordinary");
    const alias = path.resolve(config.baseDir, "ordinary-alias");
    yield* fs.makeDirectory(root, { recursive: true });
    yield* fs.symlink(root, alias);
    yield* Effect.gen(function* () {
      const service = yield* ProjectService.make.pipe(Effect.provide(WorkspacePaths.layer));
      const created = yield* service.create({
        commandId: CommandId.make("command:ordinary-alias"),
        projectId: ProjectId.make("project:ordinary-alias"),
        title: "Ordinary alias",
        workspaceRoot: alias,
      });
      assert.equal(created.workspaceRoot, alias);
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each(["delete", "move"] as const)(
  "protects a legacy managed alias record against %s",
  (operation) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const sql = yield* SqlClient.SqlClient;
      const root = path.resolve(config.baseDir, "native-agents");
      const alias = path.resolve(config.baseDir, "legacy-alias");
      yield* fs.makeDirectory(root, { recursive: true });
      yield* fs.symlink(root, alias);
      const projectId = ProjectId.make(`project:legacy-alias:${operation}`);
      yield* seedProject(projectId);
      yield* sql`UPDATE projection_projects SET workspace_root = ${alias} WHERE project_id = ${projectId}`;
      yield* Effect.gen(function* () {
        const service = yield* ProjectService.make;
        const commandId = CommandId.make(`command:legacy-alias:${operation}`);
        const mutation =
          operation === "delete"
            ? service.delete({ commandId, projectId, force: true })
            : service.update({ commandId, projectId, workspaceRoot: "/work/unrelated-checkout" });
        const error = yield* mutation.pipe(Effect.flip);
        assert.equal(error._tag, "ProjectProtectedError");
        assert.equal(Option.getOrThrow(yield* service.getById(projectId)).workspaceRoot, alias);
        assert.lengthOf(yield* sql`SELECT 1 FROM orchestration_events`, 0);
      }).pipe(Effect.provide(layerServices));
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("fails a reserved-identity check when realPath is denied", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const projectId = ProjectId.make("project:denied-realpath");
    yield* Effect.gen(function* () {
      const service = yield* ProjectService.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          realPath: (root) =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "realPath",
                pathOrDescriptor: root,
                description: "Test realPath denied.",
              }),
            ),
        }),
      );
      const error = yield* service
        .create({
          commandId: CommandId.make("command:denied-realpath"),
          projectId,
          workspaceRoot: "/work/unchecked-alias",
          title: "Unchecked",
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProjectOperationError");
      assert.isTrue(Option.isNone(yield* service.getById(projectId)));
      yield* seedProject(projectId);
      const renamed = yield* service.update({
        commandId: CommandId.make("command:metadata-without-realpath"),
        projectId,
        title: "Metadata only",
      });
      assert.equal(renamed.title, "Metadata only");
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("creates and reuses the reserved project through native bootstrap", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const root = path.resolve(config.baseDir, "native-agents");
    yield* fs.makeDirectory(root, { recursive: true });
    yield* Effect.gen(function* () {
      const service = yield* ProjectService.make.pipe(Effect.provide(WorkspacePaths.layer));
      const first = yield* service.bootstrapNativeAgentProject({
        commandId: CommandId.make("command:native-bootstrap"),
        projectId: ProjectId.make("project:native-bootstrap"),
      });
      const second = yield* service.bootstrapNativeAgentProject({
        commandId: CommandId.make("command:native-bootstrap-again"),
        projectId: ProjectId.make("project:unused-bootstrap"),
      });
      assert.isTrue(first.created);
      assert.isFalse(second.created);
      assert.equal(first.project.workspaceRoot, root);
      assert.equal(second.project.id, first.project.id);
      const sql = yield* SqlClient.SqlClient;
      assert.lengthOf(yield* sql`SELECT 1 FROM projection_projects WHERE deleted_at IS NULL`, 1);
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("allows moving an ordinary project with the same display name", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:ordinary-move");
    yield* seedProject(projectId);
    yield* Effect.gen(function* () {
      const service = yield* ProjectService.make;
      const updated = yield* service.update({
        commandId: CommandId.make("command:move-ordinary"),
        projectId,
        title: "AI Agents",
        workspaceRoot: "/work/another/native-agents",
      });
      assert.equal(updated.workspaceRoot, "/work/another/native-agents");
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "refuses a force-delete cascade containing canonical Muse or Grok shells even after a root edit",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:relocated-native");
      yield* seedProject(projectId);
      yield* Effect.gen(function* () {
        const service = yield* ProjectService.make;
        const sink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const ids = [ThreadId.make("muse-agent:canonical"), ThreadId.make("grok-bot:canonical")];
        yield* sink.write({ events: ids.map((id) => nativeThreadCreated(projectId, id)) });
        const error = yield* Effect.flip(
          service.delete({
            commandId: CommandId.make("command:delete-native-cascade"),
            projectId,
            force: true,
          }),
        );
        assert.equal(error._tag, "ProjectProtectedError");
        assert.isTrue(Option.isSome(yield* service.getById(projectId)));
        for (const id of ids)
          assert.isNull((yield* projections.getThreadProjection(id)).thread.deletedAt);
      }).pipe(Effect.provide(layerServices));
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "allows deleting an ordinary project named AI Agents in a different native-agents folder",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:user-agents");
      const sql = yield* SqlClient.SqlClient;
      yield* seedProject(projectId);
      yield* sql`UPDATE projection_projects SET title = 'AI Agents', workspace_root = '/work/native-agents' WHERE project_id = ${projectId}`;
      yield* Effect.gen(function* () {
        const service = yield* ProjectService.make;
        const deleted = yield* service.delete({
          commandId: CommandId.make("command:delete-user-agents"),
          projectId,
          force: true,
        });
        assert.isNotNull(deleted.deletedAt);
        assert.isTrue(Option.isNone(yield* service.getById(projectId)));
      }).pipe(Effect.provide(layerServices));
    }).pipe(Effect.provide(layerDatabase)),
);

const seedProject = Effect.fn("ProjectDeletionTest.seedProject")(function* (projectId: ProjectId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, default_model_selection_json,
      scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, 'Deletion test', ${`/work/${projectId}`}, NULL,
      '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
    )
  `;
});

function nativeThreadCreated(projectId: ProjectId, threadId: ThreadId) {
  const createdAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const payload: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    id: EventId.make(`created:${threadId}`),
    type: "thread.created" as const,
    threadId,
    providerInstanceId,
    occurredAt: createdAt,
    payload,
  };
}

it.effect("retries a partial project deletion without repeating child events or cleanup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:partial-deletion");
    const threadIds = [ThreadId.make("thread:delete-a"), ThreadId.make("thread:delete-b")] as const;
    const commandId = CommandId.make("command:partial-project-delete");
    yield* seedProject(projectId);
    yield* TestClock.setTime(Date.parse("2026-09-04T12:00:00.000Z"));

    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* eventSink.write({
        events: threadIds.map((threadId) => nativeThreadCreated(projectId, threadId)),
      });
      const attempts: ThreadId[] = [];
      const failingEventSink = EventSink.EventSinkV2.of({
        ...eventSink,
        commitCommand: Effect.fn("ProjectDeletionTest.failSecondChild")(function* (
          input: Parameters<EventSink.EventSinkV2Shape["commitCommand"]>[0],
        ) {
          attempts.push(input.threadId);
          if (attempts.length === 2) {
            return yield* new EventSink.EventSinkWriteError({
              commandId: input.commandId,
              eventCount: input.events.length,
              cause: new Error("Injected failure for the second child"),
            });
          }
          return yield* eventSink.commitCommand(input);
        }),
      });
      const service = yield* ProjectService.make.pipe(
        Effect.provideService(EventSink.EventSinkV2, failingEventSink),
      );
      const input = { commandId, projectId, force: true };
      const failure = yield* service.delete(input).pipe(Effect.flip);
      assert.instanceOf(failure, ProjectService.ProjectOperationError);
      if (failure._tag !== "ProjectOperationError") return assert.fail("Expected a child failure");
      assert.equal(failure.operation, "delete-thread");
      assert.lengthOf(attempts, 2);
      const firstThreadId = attempts[0] ?? assert.fail("The first child was not attempted");
      const failedThreadId = attempts[1] ?? assert.fail("The second child was not attempted");
      assert.notEqual(firstThreadId, failedThreadId);
      assert.isTrue(Option.isSome(yield* service.getById(projectId)));
      assert.isNotNull((yield* projections.getThreadProjection(firstThreadId)).thread.deletedAt);
      assert.isNull((yield* projections.getThreadProjection(failedThreadId)).thread.deletedAt);

      const readDeletions = sql<{
        readonly sequence: number;
        readonly stream_id: string;
        readonly command_id: string;
        readonly event_type: string;
      }>`
        SELECT sequence, stream_id, command_id, event_type
        FROM orchestration_events
        WHERE event_type IN ('thread.deleted', 'project.deleted')
          AND stream_id IN (${threadIds[0]}, ${threadIds[1]}, ${projectId})
        ORDER BY sequence ASC
      `;
      const readCleanup = sql<{
        readonly effect_id: string;
        readonly thread_id: string;
        readonly command_id: string;
        readonly effect_type: string;
      }>`
        SELECT effect_id, thread_id, command_id, effect_type
        FROM orchestration_v2_effect_outbox
        WHERE thread_id IN (${threadIds[0]}, ${threadIds[1]})
        ORDER BY effect_id ASC
      `;
      const partialEvents = yield* readDeletions;
      const partialCleanup = yield* readCleanup;
      assert.lengthOf(partialEvents, 1);
      assert.equal(partialEvents[0]?.stream_id, firstThreadId);
      assert.equal(partialEvents[0]?.event_type, "thread.deleted");
      assert.deepEqual(
        partialCleanup.map((effect) => [effect.thread_id, effect.effect_type]),
        [
          [firstThreadId, "preview.cleanup"],
          [firstThreadId, "terminal.cleanup"],
        ],
      );

      const deletedProject = yield* service.delete(input);
      assert.isNotNull(deletedProject.deletedAt);
      assert.isTrue(Option.isNone(yield* service.getById(projectId)));
      assert.deepEqual(attempts, [firstThreadId, failedThreadId, failedThreadId]);
      for (const threadId of threadIds) {
        assert.isNotNull((yield* projections.getThreadProjection(threadId)).thread.deletedAt);
      }
      const finalEvents = yield* readDeletions;
      assert.deepEqual(
        finalEvents.map((event) => [event.stream_id, event.event_type]),
        [
          [firstThreadId, "thread.deleted"],
          [failedThreadId, "thread.deleted"],
          [projectId, "project.deleted"],
        ],
      );
      assert.deepEqual(finalEvents[0], partialEvents[0]);
      assert.equal(finalEvents[2]?.command_id, commandId);
      const finalCleanup = yield* readCleanup;
      assert.lengthOf(finalCleanup, 4);
      assert.deepEqual(
        finalCleanup.filter((effect) => effect.thread_id === firstThreadId),
        partialCleanup,
      );
      for (const threadId of threadIds) {
        const expectedCommandId = `${commandId}:delete-thread:${threadId}`;
        assert.deepEqual(
          finalCleanup.filter((effect) => effect.thread_id === threadId),
          [
            {
              effect_id: `effect:${expectedCommandId}:preview.cleanup`,
              thread_id: threadId,
              command_id: expectedCommandId,
              effect_type: "preview.cleanup",
            },
            {
              effect_id: `effect:${expectedCommandId}:terminal.cleanup`,
              thread_id: threadId,
              command_id: expectedCommandId,
              effect_type: "terminal.cleanup",
            },
          ],
        );
      }
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "hydrates a migrated transcript before deleting its project and cleaning attachments",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project:legacy-deletion");
      const threadId = ThreadId.make("thread:legacy-deletion");
      const commandId = CommandId.make("command:legacy-project-delete");
      yield* seedProject(projectId);
      yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json,
        runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
        created_at, updated_at, archived_at, deleted_at
      ) VALUES (
        ${threadId}, ${projectId}, 'Legacy thread', '{"instanceId":"codex","model":"gpt-5.4"}',
        'full-access', 'default', NULL, NULL, NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z', NULL, NULL
      )
    `;
      yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, attachments_json,
        is_streaming, created_at, updated_at
      ) VALUES
        (
          'message:legacy-delete:1', ${threadId}, NULL, 'user', 'First question with screenshot',
          '[{"type":"image","id":"legacy_screenshot","name":"screenshot.png","mimeType":"image/png","sizeBytes":128}]',
          0, '2026-01-01T01:00:00.000Z', '2026-01-01T01:00:00.000Z'
        ),
        (
          'message:legacy-delete:2', ${threadId}, NULL, 'assistant', 'First answer', '[]',
          0, '2026-01-02T01:00:00.000Z', '2026-01-02T01:00:00.000Z'
        ),
        (
          'message:legacy-delete:3', ${threadId}, NULL, 'user', 'Follow-up question', '[]',
          0, '2026-01-03T01:00:00.000Z', '2026-01-03T01:00:00.000Z'
        ),
        (
          'message:legacy-delete:4', ${threadId}, NULL, 'assistant', 'Follow-up answer', '[]',
          0, '2026-01-04T01:00:00.000Z', '2026-01-04T01:00:00.000Z'
        )
    `;
      yield* TestClock.setTime(Date.parse("2026-09-04T12:00:00.000Z"));

      // Build the engine after seeding the legacy database, as on a real restart.
      yield* Effect.gen(function* () {
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const service = yield* ProjectService.make;
        assert.deepEqual(yield* importer.reconcileShells, {
          importedThreadCount: 1,
          importedMessageCount: 2,
        });
        assert.equal(yield* importer.pendingThreadCount, 1);
        assert.isTrue((yield* maintenance.rebuild).valid);
        const shellProjection = yield* projections.getThreadProjection(threadId);
        assert.deepEqual(
          shellProjection.messages.map((message) => message.id),
          ["message:legacy-delete:3", "message:legacy-delete:4"],
        );
        assert.deepEqual(
          shellProjection.messages.flatMap((message) => message.attachments),
          [],
        );

        const deletedProject = yield* service.delete({ commandId, projectId, force: true });
        assert.isNotNull(deletedProject.deletedAt);
        assert.isTrue(Option.isNone(yield* service.getById(projectId)));
        const projection = yield* projections.getThreadProjection(threadId);
        assert.isNotNull(projection.thread.deletedAt);
        assert.lengthOf(projection.messages, 4);
        assert.equal(yield* importer.pendingThreadCount, 0);
        const rows = yield* sql<{
          readonly v2_deleted_at: string | null;
          readonly project_deleted_at: string | null;
        }>`
        SELECT v2.deleted_at AS v2_deleted_at,
          project.deleted_at AS project_deleted_at
        FROM orchestration_v2_projection_threads AS v2
        JOIN projection_projects AS project ON project.project_id = v2.project_id
        WHERE v2.thread_id = ${threadId}
      `;
        assert.lengthOf(rows, 1);
        assert.isNotNull(rows[0]?.v2_deleted_at);
        assert.isNotNull(rows[0]?.project_deleted_at);
        // The legacy V1 row is only an import source; deletion writes V2 events only.
        const legacyEvents = yield* sql`
          SELECT sequence FROM orchestration_events
          WHERE application_event_version = 1 AND stream_id = ${threadId}
        `;
        assert.deepEqual(legacyEvents, []);

        const cleanup = yield* sql<{
          readonly command_id: string;
          readonly payload_json: string;
          readonly status: string;
        }>`
        SELECT command_id, payload_json, status
        FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${threadId} AND effect_type = 'attachment.cleanup'
      `;
        assert.lengthOf(cleanup, 1);
        assert.equal(cleanup[0]?.command_id, `${commandId}:delete-thread:${threadId}`);
        assert.equal(cleanup[0]?.status, "pending");
        const request = yield* decodeEffectRequest(cleanup[0]?.payload_json);
        assert.deepEqual(request, {
          type: "attachment.cleanup",
          attachmentIds: ["legacy_screenshot"],
        });
      }).pipe(Effect.provide(layerServices));
    }).pipe(Effect.provide(layerDatabase)),
);

it.effect("rejects a child deletion command ID already accepted for an unrelated thread", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:receipt-collision");
    const otherProjectId = ProjectId.make("project:unrelated-receipt");
    const threadId = ThreadId.make("thread:receipt-collision");
    const otherThreadId = ThreadId.make("thread:unrelated-receipt");
    const commandId = CommandId.make("command:collision-project-delete");
    yield* seedProject(projectId);
    yield* seedProject(otherProjectId);

    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const service = yield* ProjectService.make;
      yield* eventSink.write({ events: [nativeThreadCreated(projectId, threadId)] });
      const accepted = yield* eventSink.commitCommand({
        commandId: CommandId.make(`${commandId}:delete-thread:${threadId}`),
        commandType: "thread.create",
        threadId: otherThreadId,
        acceptedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
        events: [nativeThreadCreated(otherProjectId, otherThreadId)],
        effects: [],
      });
      assert.equal(accepted.receipt.status, "accepted");

      const failure = yield* service
        .delete({ commandId, projectId, force: true })
        .pipe(Effect.flip);
      assert.instanceOf(failure, ProjectService.ProjectOperationError);
      if (failure._tag !== "ProjectOperationError") return assert.fail("Expected a child failure");
      assert.equal(failure.operation, "delete-thread");
      assert.isTrue(Option.isSome(yield* service.getById(projectId)));
      assert.isNull((yield* projections.getThreadProjection(threadId)).thread.deletedAt);
      assert.isNull((yield* projections.getThreadProjection(otherThreadId)).thread.deletedAt);
      const deletions = yield* sql`
        SELECT sequence FROM orchestration_events
        WHERE event_type IN ('thread.deleted', 'project.deleted')
          AND stream_id IN (${threadId}, ${otherThreadId}, ${projectId})
      `;
      assert.deepEqual(deletions, []);
      const cleanup = yield* sql`
        SELECT effect_id FROM orchestration_v2_effect_outbox
        WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(cleanup, []);
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect("deletes a project without force once its imported threads were deleted in V2", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:imported-emptied");
    const threadId = ThreadId.make("thread:imported-emptied");
    yield* seedProject(projectId);
    // V2 never writes the V1 thread table, so this row stays live there.
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json,
        runtime_mode, interaction_mode, branch, worktree_path, latest_turn_id,
        created_at, updated_at, archived_at, deleted_at
      ) VALUES (
        ${threadId}, ${projectId}, 'Imported thread', '{"instanceId":"codex","model":"gpt-5.4"}',
        'full-access', 'default', NULL, NULL, NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL
      )
    `;
    yield* TestClock.setTime(Date.parse("2026-09-04T12:00:00.000Z"));

    yield* Effect.gen(function* () {
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const service = yield* ProjectService.make;
      yield* importer.reconcileShells;
      const early = yield* service
        .delete({ commandId: CommandId.make("command:emptied:early"), projectId })
        .pipe(Effect.flip);
      assert.equal(early._tag, "ProjectNotEmptyError");

      // Delete the imported thread the way thread.delete does.
      yield* importer.ensureTranscript(threadId);
      const command = {
        type: "thread.delete" as const,
        commandId: CommandId.make("command:emptied:thread-delete"),
        threadId,
      };
      const now = yield* DateTime.now;
      const plan = yield* planThreadDeletion({
        command,
        projection: yield* projections.getThreadRecords(threadId, [
          "runs",
          "attempts",
          "nodes",
          "runtimeRequests",
          "subagents",
          "providerSessions",
        ]),
        attachmentIds: [],
        now,
        idAllocator,
      });
      yield* eventSink.commitCommand({
        commandId: command.commandId,
        commandType: command.type,
        threadId,
        acceptedAt: now,
        events: plan.events,
        effects: plan.effects,
      });
      const legacy = yield* sql<{ readonly deleted_at: string | null }>`
        SELECT deleted_at FROM projection_threads WHERE thread_id = ${threadId}
      `;
      assert.deepEqual(legacy, [{ deleted_at: null }]);

      const deleted = yield* service.delete({
        commandId: CommandId.make("command:emptied:project-delete"),
        projectId,
      });
      assert.isNotNull(deleted.deletedAt);
      assert.isTrue(Option.isNone(yield* service.getById(projectId)));
    }).pipe(Effect.provide(layerServices));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect(
  "clears a deleted project's settings overrides so a machine-disabled instance cannot stay alive",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project:overrides-cleanup");
      const instanceId = ProviderInstanceId.make("codex_work");
      yield* seedProject(projectId);

      yield* Effect.gen(function* () {
        const service = yield* ProjectService.make;
        const serverSettings = yield* ServerSettings.ServerSettingsService;
        yield* serverSettings.updateSettings({
          projectSettingsOverrides: {
            [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
          },
        });

        yield* service.delete({
          commandId: CommandId.make("command:overrides-cleanup:project-delete"),
          projectId,
        });

        const settingsAfterDelete = yield* serverSettings.getSettings;
        assert.isUndefined(settingsAfterDelete.projectSettingsOverrides[projectId]);
      }).pipe(Effect.provide(layerServices));
    }).pipe(Effect.provide(layerDatabase)),
);
