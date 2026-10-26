import * as Computer from "@t3tools/contracts/museAgentComputer";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Transport from "./MuseAgentTransport.ts";

export class MuseAgentComputerError extends Schema.TaggedError<MuseAgentComputerError>()(
  "MuseAgentComputerError",
  {
    code: Schema.Literals([
      "invalid_request",
      "account_changed",
      "connection_changed",
      "connection_unavailable",
      "task_unavailable",
      "read_only",
      "invalid_response",
      "preview_unavailable",
      "control_conflict",
      "lease_mutation_unsupported",
      "write_uncertain",
    ]),
  },
) {
  override get message() {
    switch (this.code) {
      case "account_changed":
        return "The Muse account or workspace changed.";
      case "connection_changed":
        return "The Muse computer connection changed. Refresh the task.";
      case "connection_unavailable":
        return "The authenticated Muse computer connection is unavailable.";
      case "task_unavailable":
        return "This Muse computer task is unavailable in the selected session.";
      case "read_only":
        return "This Muse computer activity cannot be controlled.";
      case "preview_unavailable":
        return "This Muse computer task has no supported preview.";
      case "control_conflict":
        return "Muse did not grant control of the selected computer task.";
      case "lease_mutation_unsupported":
        return "Muse does not support takeover-bound control updates. Control returns when the current lease expires.";
      case "write_uncertain":
        return "Muse may have accepted this computer action. Refresh before retrying.";
      case "invalid_response":
        return "Muse returned an unsupported computer response.";
      default:
        return "The Muse computer request is invalid.";
    }
  }
}

const Id = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[^/\\\u0000-\u001f\u007f]+$/),
);
const Text = Schema.String.check(Schema.isMaxLength(8192));
const optionalText = Schema.optionalKey(Schema.NullOr(Text));
const MuseAgentComputerScope = Schema.Struct({
  binding: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  sessionId: Id,
  taskId: Id,
});
const MuseAgentComputerState = Computer.MuseAgentComputerState;
const Preview = Computer.MuseAgentComputerPreview;
const MuseAgentComputerTask = Computer.MuseAgentComputerTaskDetail;
const MuseAgentComputerAction = Computer.MuseAgentComputerAction;
const Refresh = Schema.Struct({
  previous_vm_uuid: Id,
  vm_uuid: Id,
  presented: Schema.Boolean,
  browser_incarnation: Id,
  route_generation: Schema.Number.check(Schema.isFinite()),
  egress_profile: Schema.Literal("residential"),
});
const MuseAgentComputerActionResult = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(["present", "takeover", "release", "heartbeat"]),
    state: MuseAgentComputerState,
  }),
  Schema.Struct({ action: Schema.Literals(["viewer", "close", "stop"]) }),
  Schema.Struct({ action: Schema.Literal("refresh_environment"), environment: Refresh }),
]);
const NativeScreenshot = Schema.Struct({
  url: Text,
  width: Schema.Number,
  height: Schema.Number,
  updated_at_ms: Schema.optionalKey(Schema.Number),
  action_id: Schema.optionalKey(Id),
});
const NativeTask = Schema.Struct({
  browser_task_id: Schema.optionalKey(Id),
  activity_thread_id: Schema.optionalKey(Id),
  session_id: Schema.optionalKey(Id),
  title: optionalText,
  name: optionalText,
  status: optionalText,
  display_status: optionalText,
  preview_available: Schema.optionalKey(Schema.Boolean),
  queue_position: Schema.optionalKey(Schema.Int),
  control_owner: optionalText,
  owner_kind: optionalText,
  latest_screenshot: Schema.optionalKey(Schema.NullOr(NativeScreenshot)),
  steps: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ screenshot: Schema.optionalKey(Schema.NullOr(NativeScreenshot)) }),
    ).check(Schema.isMaxLength(10000)),
  ),
});
const NativeState = Schema.Struct({
  session_id: Id,
  presented_task_id: Schema.optionalKey(Schema.NullOr(Id)),
  lease: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        control_owner: Schema.Literals(["agent", "user"]),
        task_id: Schema.optionalKey(Schema.NullOr(Id)),
        takeover_id: Schema.optionalKey(Schema.NullOr(Id)),
        control_expires_at_ms: Schema.optionalKey(
          Schema.NullOr(Schema.Number.check(Schema.isFinite())),
        ),
      }),
    ),
  ),
  active_tab: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ title: Schema.optionalKey(Text), url: Schema.optionalKey(Text) }),
    ),
  ),
  device_clipboard_supported: Schema.optionalKey(Schema.Boolean),
});

export class MuseAgentComputerService extends Context.Service<
  MuseAgentComputerService,
  {
    readonly readTask: (
      scope: typeof MuseAgentComputerScope.Type,
    ) => Effect.Effect<typeof MuseAgentComputerTask.Type, MuseAgentComputerError>;
    readonly preview: (scope: typeof MuseAgentComputerScope.Type) => Effect.Effect<
      {
        readonly bytes: Uint8Array;
        readonly contentType: "image/png" | "image/jpeg" | "image/webp";
      },
      MuseAgentComputerError
    >;
    readonly operate: (
      scope: typeof MuseAgentComputerScope.Type,
      action: typeof MuseAgentComputerAction.Type,
    ) => Effect.Effect<typeof MuseAgentComputerActionResult.Type, MuseAgentComputerError>;
    readonly openStream: (
      scope: typeof MuseAgentComputerScope.Type,
      expectedTakeoverId: string,
    ) => Effect.Effect<
      {
        readonly events: Stream.Stream<Uint8Array, MuseAgentComputerError>;
        readonly send: (data: Uint8Array) => Effect.Effect<void, MuseAgentComputerError>;
        readonly close: Effect.Effect<void>;
      },
      MuseAgentComputerError,
      Scope.Scope
    >;
  }
>()("t3/museAgent/MuseAgentComputerService") {}

const decode = <S extends Schema.Top>(
  schema: S,
  value: unknown,
  code: MuseAgentComputerError["code"] = "invalid_response",
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new MuseAgentComputerError({ code })),
  );
const failure = (error: Transport.MuseAgentTransportError) =>
  new MuseAgentComputerError({
    code:
      error.kind === "account_changed"
        ? "account_changed"
        : error.kind === "uncertain"
          ? "write_uncertain"
          : "connection_unavailable",
  });
const state = (native: typeof NativeState.Type): typeof MuseAgentComputerState.Type => ({
  sessionId: native.session_id,
  presentedTaskId: native.presented_task_id ?? null,
  lease: native.lease
    ? {
        controlOwner: native.lease.control_owner,
        taskId: native.lease.task_id ?? null,
        takeoverId: native.lease.takeover_id ?? null,
        controlExpiresAtMs: native.lease.control_expires_at_ms ?? null,
      }
    : null,
  activeTab: native.active_tab
    ? { title: native.active_tab.title ?? "", url: native.active_tab.url ?? "" }
    : null,
  deviceClipboardSupported: native.device_clipboard_supported === true,
});
// Muse 6 bundle offsets 908697 and 32653400: task screenshot metadata carries
// the immutable preview path. Neither caller URLs nor preview_available prove a preview exists.
const preview = (native: typeof NativeTask.Type, taskId: string): typeof Preview.Type | null => {
  const steps = (native.steps ?? [])
    .flatMap((step) => (step.screenshot ? [step.screenshot] : []))
    .sort((a, b) => (b.updated_at_ms ?? 0) - (a.updated_at_ms ?? 0));
  const candidates = [
    ...(native.latest_screenshot ? [native.latest_screenshot] : []),
    ...steps,
  ].filter(
    (item) =>
      Number.isFinite(item.width) &&
      Number.isFinite(item.height) &&
      item.width > 0 &&
      item.height > 0,
  );
  for (const item of candidates) {
    const match = /^\/api\/computer\/previews\/([^/?#]+)\/([a-f0-9]{64})$/.exec(item.url);
    if (!match) continue;
    try {
      if (decodeURIComponent(match[1]!) === taskId)
        return {
          taskId,
          sha256: match[2]!,
          width: item.width,
          height: item.height,
          updatedAtMs: item.updated_at_ms ?? 0,
        };
    } catch {
      /* A malformed native route cannot select another task. */
    }
  }
  return null;
};
const make = Effect.gen(function* () {
  const transport = yield* Transport.MuseAgentTransport;
  const permit = yield* Semaphore.make(1);
  const request = (
    binding: string,
    method: string,
    params: Record<string, unknown>,
    write = false,
  ) => transport.request(binding, method, params, write).pipe(Effect.mapError(failure));
  const connection = (binding: string) =>
    transport.connectionId(binding).pipe(Effect.mapError(failure));
  const authorize = Effect.fnUntraced(function* (input: typeof MuseAgentComputerScope.Type) {
    const scope = yield* decode(MuseAgentComputerScope, input, "invalid_request");
    if ((yield* transport.connect.pipe(Effect.mapError(failure))) !== scope.binding)
      return yield* new MuseAgentComputerError({ code: "account_changed" });
    const connectionId = yield* connection(scope.binding);
    // Computer tasks can belong to read-only worker sessions absent from chat lists.
    // Muse 6 opens their panel from computer.context and authorizes browser_task.get by task ID.
    const context = yield* decode(
      Schema.Struct({ tasks: Schema.Array(NativeTask).check(Schema.isMaxLength(10000)) }),
      yield* request(scope.binding, "computer.context", {}),
    );
    const selected = context.tasks.find(
      (item) => (item.browser_task_id ?? item.activity_thread_id) === scope.taskId,
    );
    if (!selected) return yield* new MuseAgentComputerError({ code: "task_unavailable" });
    if (!selected.browser_task_id) return yield* new MuseAgentComputerError({ code: "read_only" });
    if (selected.session_id !== scope.sessionId || !selected.title)
      return yield* new MuseAgentComputerError({ code: "task_unavailable" });
    const native = yield* decode(
      NativeState,
      yield* request(scope.binding, "browser_task.get", { task_id: scope.taskId }),
    );
    if (native.session_id !== scope.sessionId)
      return yield* new MuseAgentComputerError({ code: "task_unavailable" });
    if ((yield* connection(scope.binding)) !== connectionId)
      return yield* new MuseAgentComputerError({ code: "connection_changed" });
    return { scope, selected, connectionId, state: state(native) };
  });
  const task = (selected: typeof NativeTask.Type, scope: typeof MuseAgentComputerScope.Type) => ({
    taskId: scope.taskId,
    sessionId: scope.sessionId,
    title: selected.title ?? "",
    readOnly: false,
    previewAvailable: selected.preview_available === true,
    ...(selected.status ? { status: selected.status } : {}),
    ...(selected.display_status ? { displayStatus: selected.display_status } : {}),
    ...(selected.queue_position !== undefined ? { queuePosition: selected.queue_position } : {}),
    ...(selected.control_owner ? { controlOwner: selected.control_owner } : {}),
    ...(selected.owner_kind ? { ownerKind: selected.owner_kind } : {}),
  });
  const readTask: MuseAgentComputerService["Service"]["readTask"] = Effect.fn(
    "MuseAgentComputerService.readTask",
  )(function* (input) {
    const current = yield* authorize(input);
    return yield* decode(MuseAgentComputerTask, {
      task: task(current.selected, current.scope),
      state: current.state,
      preview: preview(current.selected, current.scope.taskId),
    });
  });
  const readPreview: MuseAgentComputerService["Service"]["preview"] = Effect.fn(
    "MuseAgentComputerService.readPreview",
  )(function* (input) {
    const current = yield* authorize(input);
    const image = preview(current.selected, current.scope.taskId);
    if (!image) return yield* new MuseAgentComputerError({ code: "preview_unavailable" });
    const result = yield* transport
      .readComputerPreview(current.scope.binding, image)
      .pipe(Effect.mapError(failure));
    if ((yield* connection(current.scope.binding)) !== current.connectionId)
      return yield* new MuseAgentComputerError({ code: "connection_changed" });
    return result;
  });
  const operate: MuseAgentComputerService["Service"]["operate"] = Effect.fn(
    "MuseAgentComputerService.operate",
  )(function* (input, action) {
    const command = yield* decode(MuseAgentComputerAction, action, "invalid_request");
    if (
      command.action === "release" ||
      command.action === "heartbeat" ||
      command.action === "viewer"
    )
      return yield* new MuseAgentComputerError({ code: "lease_mutation_unsupported" });
    let viewer: { width: number; height: number; device_pixel_ratio: number } | undefined;
    if ("viewer" in command && command.viewer) {
      const { width, height, devicePixelRatio } = command.viewer;
      const scale = Math.max(1 / devicePixelRatio, 500 / width);
      const scaledWidth = Math.round(width * scale),
        scaledHeight = Math.max(32, Math.round(height * scale));
      if (scaledWidth > 16384 || scaledHeight > 16384 || scaledWidth * scaledHeight > 8388608)
        return yield* new MuseAgentComputerError({ code: "invalid_request" });
      viewer = { width, height, device_pixel_ratio: devicePixelRatio };
    }
    const current = yield* authorize(input),
      { scope } = current;
    const result = yield* request(
      scope.binding,
      `browser_task.${command.action}`,
      {
        task_id: scope.taskId,
        ...(viewer ? { viewer } : {}),
        ...(command.action === "refresh_environment"
          ? { requested_egress_profile: "residential" }
          : {}),
      },
      true,
    );
    if ((yield* connection(scope.binding)) !== current.connectionId)
      return yield* new MuseAgentComputerError({ code: "write_uncertain" });
    if (command.action === "close" || command.action === "stop") return { action: command.action };
    if (command.action === "refresh_environment")
      return { action: command.action, environment: yield* decode(Refresh, result) };
    const next = state(yield* decode(NativeState, result));
    if (next.sessionId !== scope.sessionId)
      return yield* new MuseAgentComputerError({ code: "invalid_response" });
    if (
      (command.action === "present" || command.action === "takeover") &&
      next.presentedTaskId !== scope.taskId
    )
      return yield* new MuseAgentComputerError({ code: "control_conflict" });
    if (
      command.action === "takeover" &&
      (next.lease?.controlOwner !== "user" || next.lease.taskId !== scope.taskId)
    )
      return yield* new MuseAgentComputerError({ code: "control_conflict" });
    return { action: command.action, state: next };
  }, permit.withPermits(1));
  const openStream: MuseAgentComputerService["Service"]["openStream"] = Effect.fn(
    "MuseAgentComputerService.openStream",
  )(function* (input, expectedTakeoverId) {
    const current = yield* authorize(input),
      { scope } = current,
      lease = current.state.lease;
    const now = yield* Clock.currentTimeMillis;
    const expected = yield* decode(Id, expectedTakeoverId, "invalid_request");
    if (
      current.state.presentedTaskId !== scope.taskId ||
      lease?.controlOwner !== "user" ||
      lease.taskId !== scope.taskId ||
      !lease.takeoverId ||
      lease.takeoverId !== expected ||
      lease.controlExpiresAtMs === null ||
      lease.controlExpiresAtMs <= now
    )
      return yield* new MuseAgentComputerError({ code: "control_conflict" });
    const takeoverId = lease.takeoverId;
    const expiresAt = lease.controlExpiresAtMs;
    let closed = false;
    let closeNative = Effect.void;
    const close = Effect.suspend(() => {
      if (closed) return Effect.void;
      closed = true;
      // The shipped protocol provides no takeover-bound release. Closing this stream
      // must leave any replacement takeover untouched; the captured lease expires.
      return closeNative;
    });
    yield* Effect.addFinalizer(() => close);
    const native = yield* transport
      .openComputerStream(scope.binding, {
        taskId: scope.taskId,
        sessionId: scope.sessionId,
        takeoverId,
      })
      .pipe(
        Effect.mapError(failure),
        Effect.onError(() => close),
      );
    closeNative = native.close;
    yield* Effect.sleep(Math.max(0, expiresAt - (yield* Clock.currentTimeMillis))).pipe(
      Effect.andThen(close),
      Effect.forkScoped,
    );
    return {
      events: native.events.pipe(Stream.mapError(failure), Stream.ensuring(close)),
      send: (data: Uint8Array) =>
        Effect.suspend(() =>
          closed
            ? Effect.fail(new MuseAgentComputerError({ code: "control_conflict" }))
            : native.send(data).pipe(
                Effect.mapError(failure),
                Effect.onError(() => close),
              ),
        ),
      close,
    };
  });
  return MuseAgentComputerService.of({ readTask, preview: readPreview, operate, openStream });
});
export const layer = Layer.effect(MuseAgentComputerService, make);
