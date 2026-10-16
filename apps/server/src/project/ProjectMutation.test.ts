import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  projectMutationOperation,
  projectMutationRejectionMessage,
  projectMutationRpcError,
} from "./ProjectMutation.ts";
import {
  type ProjectService,
  ProjectProtectedError,
  ProjectOperationError,
} from "./ProjectService.ts";
import { ServerRuntimeStartupError } from "../serverRuntimeStartup.ts";

const projectId = ProjectId.make("project:mutation-mapping");

it.each([
  { operation: "delete" as const, message: "The managed AI Agents project cannot be deleted." },
  { operation: "move" as const, message: "The managed AI Agents project cannot be moved." },
])(
  "preserves protected-project rejections in RPC and shared transport messages",
  ({ operation, message }) => {
    const commandId = CommandId.make("command:protected-managed");
    const cause = new ProjectProtectedError({ projectId, operation });
    assert.equal(projectMutationRejectionMessage(cause), message);
    const error = projectMutationRpcError(commandId, cause);
    assert.equal(error._tag, "ProjectMutationError");
    assert.equal(error.commandId, commandId);
    assert.equal(error.message, message);
  },
);

it.each([
  new ProjectOperationError({
    operation: "dispatch-project-command",
    projectId,
    cause: "private database failure",
  }),
  new ServerRuntimeStartupError({
    mode: "web",
    host: null,
    port: 0,
    cause: "private startup failure",
  }),
])("keeps operational failures generic in the RPC response", (cause) => {
  assert.isNull(projectMutationRejectionMessage(cause));
  assert.equal(
    projectMutationRpcError(CommandId.make("command:failed"), cause).message,
    "Failed to mutate project.",
  );
});
const project = {
  id: projectId,
  title: "Mapping",
  workspaceRoot: "/work/mapping",
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: null,
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  deletedAt: null,
} satisfies Project;

it.effect("preserves every project mutation field", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const projects: Pick<ProjectService["Service"], "create" | "delete" | "update"> = {
      create: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
      update: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
      delete: (input) =>
        Ref.update(calls, (entries) => [...entries, input]).pipe(Effect.as(project)),
    };

    yield* projectMutationOperation(projects, {
      type: "project.create",
      commandId: CommandId.make("command:create"),
      projectId,
      title: "Created",
      workspaceRoot: "/work/created",
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: null,
      scripts: [],
    });
    yield* projectMutationOperation(projects, {
      type: "project.update",
      commandId: CommandId.make("command:update"),
      projectId,
      title: "Updated",
      workspaceRoot: "/work/updated",
      defaultModelSelection: null,
      autoPull: false,
      projectIcon: null,
      faviconPath: null,
      defaultThreadEnvMode: null,
      scripts: [],
    });
    yield* projectMutationOperation(projects, {
      type: "project.delete",
      commandId: CommandId.make("command:delete"),
      projectId,
      force: true,
    });

    assert.deepEqual(yield* Ref.get(calls), [
      {
        commandId: "command:create",
        projectId,
        title: "Created",
        workspaceRoot: "/work/created",
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        commandId: "command:update",
        projectId,
        title: "Updated",
        workspaceRoot: "/work/updated",
        defaultModelSelection: null,
        autoPull: false,
        projectIcon: null,
        faviconPath: null,
        defaultThreadEnvMode: null,
        scripts: [],
      },
      { commandId: "command:delete", projectId, force: true },
    ]);
  }),
);
