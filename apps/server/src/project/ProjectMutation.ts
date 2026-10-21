import { CommandId, type ProjectMutation, ProjectMutationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { type ProjectService, type ProjectServiceError } from "./ProjectService.ts";
import type { ServerRuntimeStartupError } from "../serverRuntimeStartup.ts";

type ProjectMutations = Pick<ProjectService["Service"], "create" | "delete" | "update">;

/** Expected command rejections share one classification across HTTP, RPC, and MCP. */
export function projectMutationRejectionMessage(
  cause: ProjectServiceError | ServerRuntimeStartupError,
): string | null {
  switch (cause._tag) {
    case "ProjectProtectedError":
    case "ProjectNotEmptyError":
      return cause.message;
    case "ProjectNotFoundError":
      return "The project was not found.";
    case "ProjectConflictError":
      return "The workspace is already registered to a project.";
    case "ProjectOperationError":
    case "ServerRuntimeStartupError":
      return null;
  }
  const unhandled: never = cause;
  return unhandled;
}

export function projectMutationRpcError(
  commandId: CommandId,
  cause: ProjectServiceError | ServerRuntimeStartupError,
) {
  return new ProjectMutationError({
    commandId,
    message: projectMutationRejectionMessage(cause) ?? "Failed to mutate project.",
    cause,
  });
}

export const projectMutationOperation = Effect.fn("projectMutationOperation")(function* (
  projects: ProjectMutations,
  mutation: ProjectMutation,
) {
  switch (mutation.type) {
    case "project.create":
      return yield* projects.create({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        title: mutation.title,
        workspaceRoot: mutation.workspaceRoot,
        ...(mutation.createWorkspaceRootIfMissing === undefined
          ? {}
          : { createWorkspaceRootIfMissing: mutation.createWorkspaceRootIfMissing }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
      });

    case "project.update":
      return yield* projects.update({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.title === undefined ? {} : { title: mutation.title }),
        ...(mutation.workspaceRoot === undefined ? {} : { workspaceRoot: mutation.workspaceRoot }),
        ...(mutation.defaultModelSelection === undefined
          ? {}
          : { defaultModelSelection: mutation.defaultModelSelection }),
        ...(mutation.autoPull === undefined ? {} : { autoPull: mutation.autoPull }),
        ...(mutation.projectIcon === undefined ? {} : { projectIcon: mutation.projectIcon }),
        ...(mutation.faviconPath === undefined ? {} : { faviconPath: mutation.faviconPath }),
        ...(mutation.defaultThreadEnvMode === undefined
          ? {}
          : { defaultThreadEnvMode: mutation.defaultThreadEnvMode }),
        ...(mutation.scripts === undefined ? {} : { scripts: mutation.scripts }),
      });

    case "project.delete":
      return yield* projects.delete({
        commandId: mutation.commandId,
        projectId: mutation.projectId,
        ...(mutation.force === undefined ? {} : { force: mutation.force }),
      });
  }
});
