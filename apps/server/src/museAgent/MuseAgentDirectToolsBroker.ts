import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as NativeTools from "../mcp/direct/NativeAgentDirectTools.ts";
import * as MuseTools from "./MuseAgentDirectTools.ts";
import * as Port from "./MuseAgentDirectToolsPort.ts";

const Command = Schema.Struct({ command_id: Schema.String });
const decodeCommand = Schema.decodeUnknownEffect(Command);

const sameAuthority = (left: McpThreadInvocationScope, right: McpThreadInvocationScope) =>
  left.environmentId === right.environmentId &&
  left.issuedAt === right.issuedAt &&
  left.requestNamespace === right.requestNamespace &&
  left.thread.threadId === right.thread.threadId &&
  left.thread.providerInstanceId === right.thread.providerInstanceId &&
  left.thread.providerSessionId === right.thread.providerSessionId &&
  left.thread.remoteRun?.runId === right.thread.remoteRun?.runId &&
  left.thread.remoteRun?.attemptId === right.thread.remoteRun?.attemptId &&
  left.client === undefined &&
  right.client === undefined &&
  left.call === undefined &&
  right.call === undefined &&
  left.capabilities.size === right.capabilities.size &&
  [...left.capabilities].every((capability) => right.capabilities.has(capability));

/** Install once after tool services exist, using the same registry and remote validator as MCP. */
export const installLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const port = yield* Port.MuseAgentDirectToolsPort;
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const tools = yield* MuseTools.MuseAgentDirectTools;
    const owner = yield* Effect.scope;
    const turns = new Set<Scope.Closeable>();
    let active = true;

    const start: Port.MuseAgentDirectToolsPort["Service"]["start"] = Effect.fn(
      "MuseAgentDirectToolsBroker.start",
    )(function* (inputOptions) {
      // Snapshot host authority before the first wait; reused runtime objects cannot
      // change the credential, callbacks or connection of an already-starting turn.
      const options = {
        ...inputOptions,
        remoteRun: { ...inputOptions.remoteRun },
        capabilities: new Set(inputOptions.capabilities),
      };
      if (!active)
        return yield* new NativeTools.NativeAgentDirectToolsError({ code: "not_installed" });
      // Bound before issuing a credential; NativeAgentDirectTools bounds opened sessions too.
      if (turns.size >= NativeTools.DIRECT_TOOL_LIMITS.sessions)
        return yield* new NativeTools.NativeAgentDirectToolsError({ code: "capacity_exceeded" });
      if (
        !options.remoteRun?.runId ||
        !options.remoteRun.attemptId ||
        !options.accountBinding ||
        !options.nativeSessionId ||
        options.accountBinding.length > 1024 ||
        options.nativeSessionId.length > 1024
      )
        return yield* new NativeTools.NativeAgentDirectToolsError({ code: "invalid_scope" });
      const accountBinding = options.accountBinding;
      const nativeSessionId = options.nativeSessionId;
      const isCurrent = options.isCurrent;
      const register = options.register;
      const lifetime = yield* Scope.fork(yield* Effect.scope);
      // Scope acquisition can yield while another startup reserves the final slot.
      if (!active || turns.size >= NativeTools.DIRECT_TOOL_LIMITS.sessions) {
        yield* Scope.close(lifetime, Exit.void);
        return yield* new NativeTools.NativeAgentDirectToolsError({
          code: active ? "capacity_exceeded" : "not_installed",
        });
      }
      turns.add(lifetime);
      const close = Scope.close(lifetime, Exit.void);
      yield* Scope.addFinalizer(
        lifetime,
        Effect.sync(() => {
          turns.delete(lifetime);
        }),
      );

      return yield* Effect.gen(function* () {
        if (!(yield* isCurrent))
          return yield* new NativeTools.NativeAgentDirectToolsError({ code: "stale_authority" });
        const credential = yield* Effect.acquireRelease(
          registry.issue({
            threadId: options.threadId,
            providerInstanceId: options.providerInstanceId,
            remoteRun: { ...options.remoteRun },
            browserToolsAvailable: options.browserToolsAvailable,
            capabilities: new Set(options.capabilities),
          }),
          (credential) => registry.revokeProviderSession(credential.config.providerSessionId),
        );
        // This token exists only inside the server closure. It is never in a catalog or callback.
        const token = credential.config.authorizationHeader.slice("Bearer ".length);
        const scope = yield* registry.resolve(token);
        if (
          scope === undefined ||
          scope.thread.remoteRun === undefined ||
          scope.thread.threadId !== options.threadId ||
          scope.thread.providerInstanceId !== options.providerInstanceId ||
          scope.thread.remoteRun.runId !== options.remoteRun.runId ||
          scope.thread.remoteRun.attemptId !== options.remoteRun.attemptId
        )
          return yield* new NativeTools.NativeAgentDirectToolsError({ code: "stale_authority" });
        const session = yield* tools.open({
          scope,
          ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId }),
          validate: (captured) =>
            Effect.gen(function* () {
              if (!active || !(yield* isCurrent)) return false;
              // resolve invokes the single server-owned McpRemoteRunValidator for every execution.
              const current = yield* registry.resolve(token);
              return current !== undefined && sameAuthority(captured, current);
            }),
        });
        yield* Effect.addFinalizer(() => session.revoke);
        const catalog = yield* session.catalog;
        let ready = false;
        const revoke = Effect.gen(function* () {
          ready = false;
          yield* registry.revokeProviderSession(credential.config.providerSessionId);
          yield* session.revoke.pipe(Effect.forkIn(lifetime));
        });
        const invoke: Parameters<Port.MuseDirectToolTurnOptions["register"]>[1] = (input) =>
          Effect.gen(function* () {
            if (!ready)
              return yield* new NativeTools.NativeAgentDirectToolsError({ code: "session_closed" });
            if (
              input.accountBinding !== accountBinding ||
              input.nativeSessionId !== nativeSessionId
            )
              return yield* new NativeTools.NativeAgentDirectToolsError({
                code: "stale_authority",
              });
            const request = yield* decodeCommand(input.payload).pipe(
              Effect.mapError(
                () => new NativeTools.NativeAgentDirectToolsError({ code: "invalid_request" }),
              ),
            );
            if (request.command_id !== input.commandId)
              return yield* new NativeTools.NativeAgentDirectToolsError({
                code: "invalid_request",
              });
            return yield* session.invoke(input.connectionId, input.payload);
          });
        const registration = yield* Effect.acquireRelease(
          register(catalog, invoke).pipe(
            Effect.mapError(
              () => new NativeTools.NativeAgentDirectToolsError({ code: "registration_failed" }),
            ),
          ),
          (registration) =>
            Effect.gen(function* () {
              ready = false;
              yield* session.revoke;
              // Native removal may wait on a disconnected page. Revoke host authority first;
              // the credential's own finalizer also covers failures before registration exists.
              yield* registry.revokeProviderSession(credential.config.providerSessionId);
              yield* registration.close;
            }),
        );
        if (registration.accepted !== Object.keys(catalog).length)
          return yield* new NativeTools.NativeAgentDirectToolsError({
            code: "registration_failed",
          });
        yield* session.acceptRegistration(registration.connectionId ?? options.connectionId, {
          accepted_device_commands: registration.accepted,
        });
        ready = true;
        return { revoke, close } satisfies Port.MuseDirectToolTurn;
      }).pipe(
        Effect.provideService(Scope.Scope, lifetime),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? close : Effect.void)),
      );
    });

    const { uninstall } = yield* port.install(start);
    yield* Scope.addFinalizer(
      owner,
      Effect.gen(function* () {
        active = false;
        yield* uninstall;
        yield* Effect.forEach([...turns], (scope) => Scope.close(scope, Exit.void), {
          discard: true,
        });
      }),
    );
  }),
);
