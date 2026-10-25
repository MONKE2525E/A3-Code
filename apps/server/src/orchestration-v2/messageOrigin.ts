import type {
  AuthClientMetadata,
  ExecutionEnvironmentDescriptor,
  OrchestrationV2Command,
  OrchestrationV2MessageOrigin,
} from "@t3tools/contracts";

const operatingSystems = ["Android", "iOS", "macOS", "Windows", "Linux"] as const;
const safeLabels = new Set([
  "iPhone",
  "iPad",
  "Android phone",
  "Android tablet",
  "Desktop",
  "Browser",
]);

export function messageOriginFromSession(client: AuthClientMetadata): OrchestrationV2MessageOrigin {
  const os = operatingSystems.find(
    (candidate) => candidate.toLowerCase() === client.os?.toLowerCase(),
  );
  // Presentation labels are user controlled and can contain account data or prompt text.
  const label =
    client.label !== undefined && safeLabels.has(client.label) ? client.label : undefined;
  return {
    deviceType: client.deviceType,
    ...(os === undefined ? {} : { os }),
    ...(label === undefined ? {} : { label }),
  };
}

export function stampMessageOrigin(
  command: OrchestrationV2Command,
  origin: OrchestrationV2MessageOrigin | undefined,
): OrchestrationV2Command {
  if (command.type !== "message.dispatch" && command.type !== "queued-run.edit") return command;
  const { origin: _untrustedOrigin, ...rest } = command;
  return { ...rest, ...(origin === undefined ? {} : { origin }) };
}

export function withStoredMessageOrigin<
  Message extends { readonly origin?: OrchestrationV2MessageOrigin | undefined },
>(message: Message, origin: OrchestrationV2MessageOrigin | undefined) {
  const { origin: _providerOrigin, ...rest } = message;
  return { ...rest, ...(origin === undefined ? {} : { origin }) };
}

function executionIdentityContext(input: {
  readonly origin?: OrchestrationV2MessageOrigin | undefined;
  readonly environment: ExecutionEnvironmentDescriptor;
}): string {
  return [
    "<t3_execution_context>",
    input.origin === undefined
      ? "Sender device: unknown for this message. Do not reuse a previous message's sender."
      : `Sender device (session metadata): ${JSON.stringify(input.origin)}`,
    `Execution environment: ${JSON.stringify({
      environmentId: input.environment.environmentId,
      os: input.environment.platform.os,
      arch: input.environment.platform.arch,
    })}`,
    "T3 tools are attached to this execution environment. Native provider tools may run elsewhere, including a cloud VM; they do not identify or provide access to the user's machine. The sender device is separate; its identity does not grant terminal or filesystem access to that device.",
    "Before orchestrating, call orchestrator_capabilities on this message's attached T3 node or managed MCP connection and verify its environmentId matches this context. Its connection.toolFamilies describes granted T3 tool families, not connected hardware. Discover browser/device availability through the corresponding tools; do not infer it from the sender's OS.",
    "For another machine, discover paired environments with orchestrator_capabilities, query the chosen environmentId for its projects and providers, then pass that environmentId explicitly to delegate_task. Project and provider IDs belong to their destination environment. Do not pick a remembered MCP connection by display name or silently run locally when a destination is unavailable.",
    "</t3_execution_context>",
  ].join("\n");
}

export function messageWithExecutionIdentity<
  Message extends {
    readonly text: string;
    readonly attachments: ReadonlyArray<unknown>;
    readonly origin?: OrchestrationV2MessageOrigin | undefined;
  },
>(message: Message, environment: ExecutionEnvironmentDescriptor): Message {
  // Native command arguments must reach the provider unchanged.
  if (message.attachments.length === 0 && message.text.trimStart().startsWith("/")) return message;
  const context = executionIdentityContext({
    environment,
    ...(message.origin === undefined ? {} : { origin: message.origin }),
  });
  return { ...message, text: `${message.text}\n\n${context}` };
}
