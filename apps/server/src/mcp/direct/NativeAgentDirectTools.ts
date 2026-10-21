import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type { McpThreadInvocationScope } from "../McpInvocationContext.ts";
import type { DirectTool, DirectToolResult } from "./toolkit.ts";

export const DIRECT_TOOL_LIMITS = {
  sessions: 16,
  tools: 512,
  invocations: 256,
  paramsBytes: 256 * 1024,
  resultBytes: 1024 * 1024,
  depth: 32,
  nodes: 16384,
  timeoutMs: 180000,
} as const;

export class NativeAgentDirectToolsError extends Schema.TaggedError<NativeAgentDirectToolsError>()(
  "NativeAgentDirectToolsError",
  {
    cause: Schema.optional(Schema.Defect()),
    code: Schema.Literals([
      "invalid_scope",
      "not_installed",
      "already_installed",
      "session_closed",
      "stale_authority",
      "connection_mismatch",
      "invalid_request",
      "invalid_params",
      "unknown_command",
      "command_rejected",
      "registration_failed",
      "invoke_id_collision",
      "capacity_exceeded",
      "result_too_large",
      "deadline_exceeded",
      "interrupted",
      "tool_failed",
    ]),
  },
) {
  override get message(): string {
    return `Native direct tool request refused: ${this.code}.`;
  }
}

export interface DirectToolDefinition {
  readonly description: string;
  readonly required: { readonly params_json: { readonly type: 1; readonly description: string } };
  readonly optional: Record<string, never>;
  readonly permissions: readonly [];
  readonly datatype: "";
  readonly timeout_ms: number;
}

export interface DirectToolResponse {
  readonly invoke_id: string;
  readonly ok: boolean;
  readonly result?: Schema.Json;
  readonly error?: { readonly code: string; readonly message: string };
}

/** All authority, validation and connection metadata come from the host, never device parameters. */
export interface DirectToolSessionOptions {
  readonly scope: McpThreadInvocationScope;
  /** May be pinned by the first trusted invocation metadata when registration omits it. */
  readonly connectionId?: string;
  /** Re-resolve a registry credential or validate the exact live server-owned run/attempt/session. */
  readonly validate: (
    scope: McpThreadInvocationScope,
  ) => Effect.Effect<boolean, NativeAgentDirectToolsError>;
}

export interface DirectToolSession {
  readonly catalog: Effect.Effect<
    Readonly<Record<string, DirectToolDefinition>>,
    NativeAgentDirectToolsError
  >;
  /** Registration must succeed before invocation. Rejected IDs stay rejected for this lifetime. */
  readonly acceptRegistration: (
    connectionId: string | undefined,
    response: unknown,
  ) => Effect.Effect<
    {
      readonly accepted: readonly string[];
      readonly rejected: readonly string[];
    },
    NativeAgentDirectToolsError
  >;
  readonly invoke: (
    connectionId: string,
    payload: unknown,
  ) => Effect.Effect<DirectToolResponse, NativeAgentDirectToolsError>;
  readonly revoke: Effect.Effect<void>;
}

export class NativeAgentDirectTools extends Context.Service<
  NativeAgentDirectTools,
  {
    readonly open: (
      options: DirectToolSessionOptions,
    ) => Effect.Effect<DirectToolSession, NativeAgentDirectToolsError, Scope.Scope>;
  }
>()("t3/mcp/direct/NativeAgentDirectTools") {}

const boundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Invocation = Schema.Struct({
  invoke_id: boundedId,
  command_id: boundedId,
  params_json: Schema.String.check(Schema.isMaxLength(DIRECT_TOOL_LIMITS.paramsBytes)),
  timeout_ms: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: DIRECT_TOOL_LIMITS.timeoutMs })),
  ),
});
const Registration = Schema.Struct({
  accepted_device_commands: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: DIRECT_TOOL_LIMITS.tools }),
  ),
  rejected_ids: Schema.optional(
    Schema.Array(boundedId).check(Schema.isMaxLength(DIRECT_TOOL_LIMITS.tools)),
  ),
});
const decodeInvocation = Schema.decodeUnknownEffect(Invocation, { onExcessProperty: "error" });
const decodeRegistration = Schema.decodeUnknownEffect(Registration);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeObject = Schema.decodeUnknownEffect(Schema.JsonObject);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

/** Iterative traversal bounds nested JSON before recursive schema validation. */
const withinBounds = (value: unknown): boolean => {
  const queue = [{ value, depth: 0 }];
  let nodes = 0;
  while (queue.length > 0) {
    const item = queue.pop()!;
    if (++nodes > DIRECT_TOOL_LIMITS.nodes || item.depth > DIRECT_TOOL_LIMITS.depth) return false;
    if (Predicate.isObjectOrArray(item.value)) {
      for (const value of Object.values(item.value)) queue.push({ value, depth: item.depth + 1 });
    }
  }
  return true;
};

const failureResponse = (
  invokeId: string,
  code: NativeAgentDirectToolsError["code"],
): DirectToolResponse => ({
  invoke_id: invokeId,
  ok: false,
  error: { code, message: new NativeAgentDirectToolsError({ code }).message },
});

const make = Effect.fn("NativeAgentDirectTools.make")(function* (tools: readonly DirectTool[]) {
  if (
    tools.length > DIRECT_TOOL_LIMITS.tools ||
    new Set(tools.map((tool) => tool.name)).size !== tools.length
  )
    return yield* new NativeAgentDirectToolsError({ code: "capacity_exceeded" });
  const definitions = yield* Effect.forEach(tools, (tool) =>
    encodeJson(tool.parameters).pipe(
      Effect.map(
        (schema) =>
          [
            tool.name,
            {
              description: tool.description,
              required: {
                params_json: {
                  type: 1,
                  description: `JSON-encoded arguments object. Schema: ${schema}`,
                },
              },
              optional: {},
              permissions: [],
              datatype: "",
              timeout_ms: 60000,
            } satisfies DirectToolDefinition,
          ] as const,
      ),
      Effect.mapError(() => new NativeAgentDirectToolsError({ code: "invalid_params" })),
    ),
  );
  const allDefinitions = Object.fromEntries(definitions);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  let sessions = 0;

  const open = Effect.fn("NativeAgentDirectTools.open")(function* (
    options: DirectToolSessionOptions,
  ) {
    if (
      options.scope.thread.remoteRun === undefined ||
      options.scope.client !== undefined ||
      options.scope.call !== undefined ||
      (options.connectionId !== undefined &&
        (options.connectionId.length === 0 || options.connectionId.length > 1024))
    )
      return yield* new NativeAgentDirectToolsError({ code: "invalid_scope" });
    // Copy authority so a mutable runtime object cannot rebind an existing session to a later turn.
    const scope: McpThreadInvocationScope = {
      ...options.scope,
      capabilities: new Set(options.scope.capabilities),
      thread: { ...options.scope.thread, remoteRun: { ...options.scope.thread.remoteRun } },
    };
    const lifetime = yield* Effect.scope;
    let pinnedConnectionId = options.connectionId;
    const validate = options.validate;
    let active = true;
    let registered = false;
    const rejected = new Set<string>();
    const accepted = new Set<string>();
    const invocations = new Map<
      string,
      {
        readonly identity: string;
        readonly done: Deferred.Deferred<DirectToolResponse>;
      }
    >();
    const running = new Set<Fiber.Fiber<void>>();
    const revoke = Effect.gen(function* () {
      active = false;
      yield* Effect.forEach([...running], Fiber.interrupt, { discard: true });
    });
    yield* Effect.acquireRelease(
      Effect.suspend(() => {
        if (sessions >= DIRECT_TOOL_LIMITS.sessions)
          return Effect.fail(new NativeAgentDirectToolsError({ code: "capacity_exceeded" }));
        sessions++;
        return Effect.void;
      }),
      () =>
        Effect.sync(() => {
          active = false;
          sessions--;
        }),
    );

    const check = Effect.fn("NativeAgentDirectTools.check")(function* (connectionId?: string) {
      if (!active) return yield* new NativeAgentDirectToolsError({ code: "session_closed" });
      if (
        connectionId !== undefined &&
        (connectionId.length === 0 ||
          connectionId.length > 1024 ||
          (pinnedConnectionId !== undefined && connectionId !== pinnedConnectionId))
      )
        return yield* new NativeAgentDirectToolsError({ code: "connection_mismatch" });
      if (!(yield* validate(scope)))
        return yield* new NativeAgentDirectToolsError({ code: "stale_authority" });
      if (!active) return yield* new NativeAgentDirectToolsError({ code: "session_closed" });
      // Validation can yield: a concurrent first invocation may already have pinned it.
      if (connectionId !== undefined) {
        if (pinnedConnectionId !== undefined && pinnedConnectionId !== connectionId)
          return yield* new NativeAgentDirectToolsError({ code: "connection_mismatch" });
        pinnedConnectionId = connectionId;
      }
    });
    yield* check(options.connectionId);
    const catalog = check().pipe(
      Effect.map(() =>
        Object.fromEntries(Object.entries(allDefinitions).filter(([name]) => !rejected.has(name))),
      ),
    );

    const acceptRegistration: DirectToolSession["acceptRegistration"] = Effect.fn(
      "NativeAgentDirectTools.acceptRegistration",
    )(function* (connectionId, response) {
      yield* check(connectionId);
      registered = false;
      accepted.clear();
      const result = yield* decodeRegistration(response).pipe(
        Effect.mapError(() => new NativeAgentDirectToolsError({ code: "registration_failed" })),
      );
      const ids = result.rejected_ids ?? [];
      if (new Set(ids).size !== ids.length || ids.some((id) => !byName.has(id)))
        return yield* new NativeAgentDirectToolsError({ code: "registration_failed" });
      for (const id of ids) rejected.add(id);
      const remaining = tools.filter((tool) => !rejected.has(tool.name)).map((tool) => tool.name);
      if (remaining.length === 0 || result.accepted_device_commands !== remaining.length)
        return yield* new NativeAgentDirectToolsError({ code: "registration_failed" });
      for (const id of remaining) accepted.add(id);
      registered = true;
      return { accepted: remaining, rejected: [...rejected] };
    });

    const invoke: DirectToolSession["invoke"] = (connectionId, payload) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* restore(check(connectionId));
          const request = yield* decodeInvocation(payload).pipe(
            Effect.mapError(() => new NativeAgentDirectToolsError({ code: "invalid_request" })),
          );
          if (Buffer.byteLength(request.params_json, "utf8") > DIRECT_TOOL_LIMITS.paramsBytes)
            return yield* new NativeAgentDirectToolsError({ code: "invalid_params" });
          const tool = byName.get(request.command_id);
          if (tool === undefined)
            return yield* new NativeAgentDirectToolsError({ code: "unknown_command" });
          if (rejected.has(tool.name))
            return yield* new NativeAgentDirectToolsError({ code: "command_rejected" });
          if (!registered || !accepted.has(tool.name))
            return yield* new NativeAgentDirectToolsError({ code: "registration_failed" });
          const identity = `${request.command_id}\0${request.params_json}\0${request.timeout_ms ?? 60000}`;
          const previous = invocations.get(request.invoke_id);
          if (previous !== undefined) {
            if (previous.identity !== identity)
              return yield* new NativeAgentDirectToolsError({ code: "invoke_id_collision" });
            return yield* restore(Deferred.await(previous.done));
          }
          if (invocations.size >= DIRECT_TOOL_LIMITS.invocations)
            return yield* new NativeAgentDirectToolsError({ code: "capacity_exceeded" });
          const raw = yield* decodeJson(request.params_json).pipe(
            Effect.mapError(() => new NativeAgentDirectToolsError({ code: "invalid_params" })),
          );
          if (!withinBounds(raw))
            return yield* new NativeAgentDirectToolsError({ code: "invalid_params" });
          const params = yield* decodeObject(raw).pipe(
            Effect.mapError(() => new NativeAgentDirectToolsError({ code: "invalid_params" })),
          );
          // Parsing can yield to another delivery. Reserve atomically after it and recheck
          // capacity so simultaneous new requests cannot exceed the lifetime bound.
          const raced = invocations.get(request.invoke_id);
          if (raced !== undefined) {
            if (raced.identity !== identity)
              return yield* new NativeAgentDirectToolsError({ code: "invoke_id_collision" });
            return yield* restore(Deferred.await(raced.done));
          }
          if (invocations.size >= DIRECT_TOOL_LIMITS.invocations)
            return yield* new NativeAgentDirectToolsError({ code: "capacity_exceeded" });
          // Creating the receipt cannot yield after the cache/capacity checks.
          const done = Deferred.makeUnsafe<DirectToolResponse>();
          // No expiry/eviction: a replay can never rerun a mutation in this session lifetime.
          invocations.set(request.invoke_id, { identity, done });
          const execute = check(connectionId).pipe(
            Effect.andThen(tool.invoke(params, request.invoke_id, scope)),
            Effect.flatMap((result: DirectToolResult) =>
              encodeJson(result.value).pipe(
                Effect.mapError(() => new NativeAgentDirectToolsError({ code: "tool_failed" })),
                Effect.flatMap((encoded) =>
                  Buffer.byteLength(encoded, "utf8") > DIRECT_TOOL_LIMITS.resultBytes
                    ? Effect.fail(new NativeAgentDirectToolsError({ code: "result_too_large" }))
                    : Effect.succeed({
                        invoke_id: request.invoke_id,
                        ok: !result.isError,
                        result: result.value,
                      } satisfies DirectToolResponse),
                ),
              ),
            ),
            Effect.timeoutOrElse({
              duration: request.timeout_ms ?? 60000,
              orElse: () =>
                Effect.fail(new NativeAgentDirectToolsError({ code: "deadline_exceeded" })),
            }),
          );
          const work = Effect.uninterruptibleMask((restore) =>
            restore(execute).pipe(
              Effect.exit,
              Effect.flatMap((exit) =>
                Deferred.succeed(
                  done,
                  Exit.isSuccess(exit)
                    ? exit.value
                    : failureResponse(
                        request.invoke_id,
                        Cause.hasInterrupts(exit.cause)
                          ? "interrupted"
                          : Option.getOrElse(
                              Option.map(Cause.findErrorOption(exit.cause), (error) => error.code),
                              () => "tool_failed" as const,
                            ),
                      ),
                ),
              ),
              Effect.asVoid,
            ),
          );
          const fiber = yield* Effect.forkIn(work, lifetime);
          running.add(fiber);
          fiber.addObserver(() => running.delete(fiber));
          return yield* restore(Deferred.await(done));
        }),
      );
    return { catalog, acceptRegistration, invoke, revoke } satisfies DirectToolSession;
  });
  return NativeAgentDirectTools.of({ open });
});

/** Compose checked toolkit registrations in the server's existing application layer. */
export const layer = <E, R>(tools: Effect.Effect<readonly DirectTool[], E, R>) =>
  Layer.effect(NativeAgentDirectTools, tools.pipe(Effect.flatMap(make)));
