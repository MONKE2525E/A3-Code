import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { NativeAgentFeatureReadInput, NativeAgentFeatureUpdateInput } from "./nativeAgentApi.ts";
import { MuseAgentComputerAction, MuseAgentComputerTaskDetail } from "./museAgentComputer.ts";

const decodeRead = Schema.decodeUnknownSync(NativeAgentFeatureReadInput);
const decodeUpdate = Schema.decodeUnknownSync(NativeAgentFeatureUpdateInput);
const decodeDetail = Schema.decodeUnknownSync(MuseAgentComputerTaskDetail);
const decodeAction = Schema.decodeUnknownSync(MuseAgentComputerAction);

const scope = {
  providerInstanceId: "muse-agent-synthetic",
  sessionId: "primary:synthetic",
  taskId: "task:synthetic",
};
const detail = {
  task: {
    taskId: scope.taskId,
    sessionId: scope.sessionId,
    title: "Synthetic task",
    readOnly: false,
    previewAvailable: true,
  },
  state: {
    sessionId: scope.sessionId,
    presentedTaskId: scope.taskId,
    lease: {
      controlOwner: "user",
      taskId: scope.taskId,
      takeoverId: "takeover:synthetic",
      controlExpiresAtMs: 1234,
    },
    activeTab: { title: "Synthetic tab", url: "https://synthetic.invalid" },
    deviceClipboardSupported: false,
  },
  preview: {
    taskId: scope.taskId,
    sha256: "a".repeat(64),
    width: 640,
    height: 480,
    updatedAtMs: 1234,
  },
};

describe("Muse computer wire contracts", () => {
  it("round trips selected task state and nested commands without cloud paths or native bindings", () => {
    expect(
      decodeRead({
        ...scope,
        operation: "computer_task",
      }),
    ).toEqual({ ...scope, operation: "computer_task" });
    expect(decodeDetail(detail)).toEqual(detail);
    const command = {
      ...scope,
      operation: "computer_action",
      command: { action: "takeover", viewer: { width: 640, height: 480, devicePixelRatio: 2 } },
    };
    expect(decodeUpdate(command)).toEqual(command);
  });
  it("rejects missing viewers, non-finite dimensions, and unsupported actions", () => {
    for (const command of [
      { action: "viewer" },
      { action: "takeover", viewer: { width: 0, height: 480, devicePixelRatio: 1 } },
      { action: "takeover", viewer: { width: 640, height: 480, devicePixelRatio: Infinity } },
      { action: "execute" },
    ])
      expect(() => decodeAction(command)).toThrow();
    expect(() =>
      decodeDetail({
        ...detail,
        preview: { ...detail.preview, width: Infinity },
      }),
    ).toThrow();
  });
  it("rejects task or session identifiers that could select another route", () => {
    for (const taskId of ["", "foreign/task", "foreign\\task", "bad\u0000task", "a".repeat(1025)])
      expect(() =>
        decodeRead({
          ...scope,
          operation: "computer_task",
          taskId,
        }),
      ).toThrow();
    expect(() =>
      decodeUpdate({
        ...scope,
        operation: "computer_action",
        sessionId: "foreign/session",
        command: { action: "stop" },
      }),
    ).toThrow();
  });
});
