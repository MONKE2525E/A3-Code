import * as Schema from "effect/Schema";
import { MuseAgentComputerTask } from "./museAgentFeatures.ts";

export const MuseAgentComputerId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
  Schema.isPattern(/^[^/\\\u0000-\u001f\u007f]+$/),
);
const Text = Schema.String.check(Schema.isMaxLength(8192));
export const MuseAgentComputerViewer = Schema.Struct({
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4294967295 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4294967295 })),
  devicePixelRatio: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
});
export type MuseAgentComputerViewer = typeof MuseAgentComputerViewer.Type;
export const MuseAgentComputerState = Schema.Struct({
  sessionId: MuseAgentComputerId,
  presentedTaskId: Schema.NullOr(MuseAgentComputerId),
  lease: Schema.NullOr(
    Schema.Struct({
      controlOwner: Schema.Literals(["agent", "user"]),
      taskId: Schema.NullOr(MuseAgentComputerId),
      takeoverId: Schema.NullOr(MuseAgentComputerId),
      controlExpiresAtMs: Schema.NullOr(Schema.Number.check(Schema.isFinite())),
    }),
  ),
  activeTab: Schema.NullOr(Schema.Struct({ title: Text, url: Text })),
  deviceClipboardSupported: Schema.Boolean,
});
export type MuseAgentComputerState = typeof MuseAgentComputerState.Type;
export const MuseAgentComputerPreview = Schema.Struct({
  taskId: MuseAgentComputerId,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  width: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  height: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  updatedAtMs: Schema.Number.check(Schema.isFinite()),
});
export type MuseAgentComputerPreview = typeof MuseAgentComputerPreview.Type;
export const MuseAgentComputerTaskDetail = Schema.Struct({
  task: MuseAgentComputerTask,
  state: MuseAgentComputerState,
  preview: Schema.NullOr(MuseAgentComputerPreview),
});
export type MuseAgentComputerTaskDetail = typeof MuseAgentComputerTaskDetail.Type;
export const MuseAgentComputerAction = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(["present", "takeover"]),
    viewer: Schema.optionalKey(MuseAgentComputerViewer),
  }),
  Schema.Struct({
    action: Schema.Literal("viewer"),
    viewer: MuseAgentComputerViewer,
    takeoverId: MuseAgentComputerId,
  }),
  Schema.Struct({
    action: Schema.Literals(["release", "heartbeat"]),
    takeoverId: MuseAgentComputerId,
  }),
  Schema.Struct({
    action: Schema.Literals(["close", "stop", "refresh_environment"]),
  }),
]);
export type MuseAgentComputerAction = typeof MuseAgentComputerAction.Type;

/** The selected environment issues a fresh standard WebSocket ticket for this stream. */
export const museAgentComputerStreamPath = (reference: {
  readonly providerInstanceId: string;
  readonly sessionId: string;
  readonly taskId: string;
}): string =>
  `/api/ai-agents/muse/${encodeURIComponent(reference.providerInstanceId)}/computer/${encodeURIComponent(reference.sessionId)}/${encodeURIComponent(reference.taskId)}/stream`;
