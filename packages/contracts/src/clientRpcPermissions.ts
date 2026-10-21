import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import { GrokBotOrchestratorInput } from "./grokBotOrchestrator.ts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";
import { NativeAgentFeatureUpdateInput } from "./nativeAgentApi.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.museAgentsSetup]: AuthSettingsWriteScope,
  [WS_METHODS.museAgentsSignIn]: AuthSettingsWriteScope,
  [WS_METHODS.museAgentsFeatureUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.museAgentsOpenThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.nativeAgentsOpenThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsSetup]: AuthSettingsWriteScope,
  [WS_METHODS.grokBotsCreate]: AuthSettingsWriteScope,
  [WS_METHODS.grokBotsImportMarketplaceTemplate]: AuthSettingsWriteScope,
  [WS_METHODS.grokBotsPluginAuthenticate]: AuthSettingsWriteScope,
  [WS_METHODS.grokBotsPluginCompleteAuth]: AuthSettingsWriteScope,
  [WS_METHODS.grokBotsInstallMarketplacePlugin]: AuthSettingsWriteScope,
  [WS_METHODS.grokBotsUninstallMarketplacePlugin]: AuthSettingsWriteScope,
  [WS_METHODS.grokBotsUpdate]: AuthSettingsWriteScope,
  [WS_METHODS.grokBotsDelete]: AuthSettingsWriteScope,
  [WS_METHODS.grokBotsOrchestratorConfig]: AuthSettingsWriteScope,
  [WS_METHODS.grokBotsSend]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsLink]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsOpenThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsTeachRead]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsTeachStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsTeachStop]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsComputerRead]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsComputerStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsComputerRecreate]: AuthSettingsWriteScope,
  [WS_METHODS.grokBotsComputerReset]: AuthSettingsWriteScope,
  [WS_METHODS.grokBotsHostMachineUpdate]: AuthSettingsWriteScope,
  [WS_METHODS.grokBotsNetworkSet]: AuthSettingsWriteScope,
  [WS_METHODS.grokBotsSecretSubmit]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsSecretDismiss]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsVoiceStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsVoiceRefresh]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsVoiceTool]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsVoiceConnected]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsVoiceEnd]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsSetRoutineEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.grokBotsDeleteRoutine]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

// Availability checks need only the operation; the RPC schema validates the full payload.
const decodeNativeFeatureUpdate = Schema.decodeUnknownSync(
  Schema.Struct({
    operation: Schema.Union(
      NativeAgentFeatureUpdateInput.members.map((member) => member.fields.operation),
    ),
  }),
);

const museFeatureUpdateScopes = {
  connector_auth: AuthSettingsWriteScope,
  connector_link: AuthSettingsWriteScope,
  connector_scope_link: AuthSettingsWriteScope,
  connector_disconnect: AuthSettingsWriteScope,
  connector_unlink: AuthSettingsWriteScope,
  profile_save: AuthSettingsWriteScope,
  profile_set_theme: AuthSettingsWriteScope,
  credential_submit: AuthOrchestrationOperateScope,
  option_select: AuthOrchestrationOperateScope,
  history_page: AuthOrchestrationOperateScope,
  computer_action: AuthOrchestrationOperateScope,
  delivery_release: AuthOrchestrationOperateScope,
  task_delete: AuthOrchestrationOperateScope,
  session_rename: AuthOrchestrationOperateScope,
  session_archive: AuthOrchestrationOperateScope,
} satisfies Record<typeof NativeAgentFeatureUpdateInput.Type.operation, AuthEnvironmentScope>;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeBotOrchestrator = Schema.decodeUnknownSync(GrokBotOrchestratorInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.museAgentsFeatureUpdate && input !== undefined)
    return [museFeatureUpdateScopes[decodeNativeFeatureUpdate(input).operation]];
  if (method === WS_METHODS.museAgentsSignIn)
    return [AuthSettingsWriteScope, AuthOrchestrationReadScope, AuthPreviewOperateScope];
  // Status is a read. Only explicit setup changes the environment's provider.
  // An omitted input still asks for write availability on the setup command.
  if (method === WS_METHODS.grokBotsOrchestratorConfig && input !== undefined) {
    const action = decodeBotOrchestrator(input).action;
    return action === "send_setup_prompt"
      ? [AuthSettingsWriteScope, AuthOrchestrationOperateScope]
      : action === "setup"
        ? [AuthSettingsWriteScope]
        : [];
  }
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
