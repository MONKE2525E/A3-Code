import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Service from "./MuseAgentComputerService.ts";
import * as Transport from "./MuseAgentTransport.ts";

const binding = "a".repeat(64);
const scope = { binding, sessionId: "primary", taskId: "browser-task" };
const hash = "b".repeat(64);
const nativeTask = {
  browser_task_id: scope.taskId,
  session_id: scope.sessionId,
  title: "Synthetic browser task",
  status: "running",
  preview_available: true,
  latest_screenshot: {
    url: `/api/computer/previews/${scope.taskId}/${hash}`,
    width: 1280,
    height: 720,
    updated_at_ms: 42,
  },
};
const nativeState = {
  session_id: scope.sessionId,
  presented_task_id: scope.taskId,
  lease: { control_owner: "agent", task_id: scope.taskId },
  active_tab: { title: "Synthetic page", url: "https://example.invalid/" },
  device_clipboard_supported: true,
};
const userState = {
  ...nativeState,
  lease: {
    control_owner: "user",
    task_id: scope.taskId,
    takeover_id: "takeover",
    control_expires_at_ms: 12000,
  },
};
const expectedAgentState = {
  sessionId: "primary",
  presentedTaskId: "browser-task",
  lease: {
    controlOwner: "agent",
    taskId: "browser-task",
    takeoverId: null,
    controlExpiresAtMs: null,
  },
  activeTab: { title: "Synthetic page", url: "https://example.invalid/" },
  deviceClipboardSupported: true,
};
const fixture = () => {
  const calls: { method: string; params: Record<string, unknown>; write: boolean }[] = [];
  const media: { taskId: string; sha256: string }[] = [];
  const streams: { taskId: string; sessionId: string; takeoverId: string }[] = [],
    inputBytes: Uint8Array[] = [];
  let streamClosed = 0;
  let streamFailure: (() => Transport.MuseAgentTransportError) | undefined;
  let account = binding,
    generation = "generation-1";
  const responses: Record<string, unknown> = {
    "sessions.list": { sessions: [{ session_id: "primary", is_primary: true, is_thread: false }] },
    "computer.context": { tasks: [nativeTask] },
    "browser_task.get": nativeState,
    "browser_task.present": nativeState,
    "browser_task.takeover": userState,
    "browser_task.heartbeat": userState,
    "browser_task.release": nativeState,
  };
  let duringRequest: ((method: string) => void) | undefined;
  let requestError: Transport.MuseAgentTransportError | undefined;
  let beforeConnection: (() => Effect.Effect<void>) | undefined;
  let overrideResponse:
    | ((method: string) => Effect.Effect<unknown, Transport.MuseAgentTransportError> | undefined)
    | undefined;
  const transport = Transport.MuseAgentTransport.of({
    acquireTurn: () => Effect.succeed(Effect.void),
    connect: Effect.sync(() => account),
    connectionId: () =>
      Effect.gen(function* () {
        if (beforeConnection) yield* beforeConnection();
        return generation;
      }),
    request: (_binding, method, params, write = false) =>
      Effect.suspend(() => {
        calls.push({ method, params, write });
        duringRequest?.(method);
        return requestError
          ? Effect.fail(requestError)
          : (overrideResponse?.(method) ?? Effect.succeed(responses[method]));
      }),
    openComputerStream: (_binding, input) =>
      Effect.suspend(() => {
        streams.push(input);
        if (streamFailure) return Effect.fail(streamFailure());
        return Effect.succeed({
          events: Stream.fromIterable([new Uint8Array([82, 70, 66])]),
          send: (data: Uint8Array) =>
            Effect.sync(() => {
              inputBytes.push(data);
            }),
          close: Effect.sync(() => {
            streamClosed++;
          }),
        });
      }),
    readComputerPreview: (_binding, input) =>
      Effect.sync(() => {
        media.push({ taskId: input.taskId, sha256: input.sha256 });
        return { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" as const };
      }),
    watch: () => Effect.die("unused watch"),
    cancelOwned: () => Effect.die("unused cancel"),
    releaseOwned: () => Effect.die("unused release"),
    readAvatar: () => Effect.die("unused avatar"),
    registerTools: () => Effect.die("unused tools"),
    unregisterTools: () => Effect.die("unused tools"),
  });
  return {
    calls,
    media,
    responses,
    streams,
    inputBytes,
    streamClosed: () => streamClosed,
    failStream: (callback: () => Transport.MuseAgentTransportError) => {
      streamFailure = callback;
    },
    onConnection: (callback: () => Effect.Effect<void>) => {
      beforeConnection = callback;
    },
    onResponse: (callback: NonNullable<typeof overrideResponse>) => {
      overrideResponse = callback;
    },
    layer: Service.layer.pipe(
      Layer.provide(Layer.succeed(Transport.MuseAgentTransport, transport)),
    ),
    changeAccount: () => {
      account = "c".repeat(64);
    },
    changeConnection: () => {
      generation = "generation-2";
    },
    onRequest: (callback: (method: string) => void) => {
      duringRequest = callback;
    },
    fail: (error: Transport.MuseAgentTransportError) => {
      requestError = error;
    },
  };
};

it.effect(
  "opens a stream only for the exact active user takeover and carries its binary frames",
  () => {
    const f = fixture();
    f.responses["browser_task.get"] = userState;
    return Effect.scoped(
      Effect.gen(function* () {
        const computer = yield* Service.MuseAgentComputerService;
        const viewer = yield* computer.openStream(scope, "takeover");
        expect(f.streams).toEqual([
          { taskId: "browser-task", sessionId: "primary", takeoverId: "takeover" },
        ]);
        yield* viewer.send(new Uint8Array([1, 2, 3]));
        expect(f.inputBytes).toEqual([new Uint8Array([1, 2, 3])]);
        expect(yield* viewer.events.pipe(Stream.runCollect)).toEqual([
          new Uint8Array([82, 70, 66]),
        ]);
        expect(f.streamClosed()).toBe(1);
        expect(f.calls.filter((call) => call.write)).toEqual([
          { method: "browser_task.release", params: { task_id: "browser-task" }, write: true },
        ]);
      }),
    ).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "refuses expired, missing and foreign takeover leases before creating a native stream",
  () => {
    return Effect.gen(function* () {
      for (const receipt of [
        nativeState,
        { ...userState, lease: { ...userState.lease, task_id: "other" } },
        { ...userState, lease: { ...userState.lease, control_expires_at_ms: -1 } },
        { ...userState, presented_task_id: "other" },
      ]) {
        const f = fixture();
        f.responses["browser_task.get"] = receipt;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const computer = yield* Service.MuseAgentComputerService;
            expect((yield* computer.openStream(scope, "takeover").pipe(Effect.flip)).code).toBe(
              "control_conflict",
            );
          }),
        ).pipe(Effect.provide(f.layer));
        expect(f.streams).toEqual([]);
        expect(f.calls.at(-1)?.method).toBe("browser_task.get");
      }
    });
  },
);

it.effect(
  "heartbeats a held takeover and leaves a replacement takeover untouched during cleanup",
  () => {
    const f = fixture();
    f.responses["browser_task.get"] = userState;
    return Effect.scoped(
      Effect.gen(function* () {
        const computer = yield* Service.MuseAgentComputerService;
        const viewer = yield* computer.openStream(scope, "takeover");
        yield* TestClock.adjust("5 seconds");
        expect(f.calls.filter((call) => call.write)).toEqual([
          { method: "browser_task.heartbeat", params: { task_id: "browser-task" }, write: true },
        ]);
        f.responses["browser_task.get"] = {
          ...userState,
          lease: { ...userState.lease, takeover_id: "replacement" },
        };
        yield* viewer.close;
        expect(f.streamClosed()).toBe(1);
        expect(f.calls.filter((call) => call.write)).toEqual([
          { method: "browser_task.heartbeat", params: { task_id: "browser-task" }, write: true },
        ]);
      }),
    ).pipe(Effect.provide(f.layer));
  },
);

it.effect("refuses delayed release, heartbeat and resize from a superseded takeover", () => {
  const f = fixture();
  f.responses["browser_task.get"] = {
    ...userState,
    lease: { ...userState.lease, takeover_id: "replacement" },
  };
  return Effect.gen(function* () {
    const computer = yield* Service.MuseAgentComputerService;
    for (const action of [
      { action: "release", takeoverId: "takeover" },
      { action: "heartbeat", takeoverId: "takeover" },
      {
        action: "viewer",
        takeoverId: "takeover",
        viewer: { width: 800, height: 600, devicePixelRatio: 1 },
      },
    ] as const)
      expect((yield* computer.operate(scope, action).pipe(Effect.flip)).code).toBe(
        "control_conflict",
      );
    expect(f.calls.filter((call) => call.write)).toEqual([]);
    expect(
      yield* computer.operate(scope, { action: "release", takeoverId: "replacement" }),
    ).toEqual({ action: "release", state: expectedAgentState });
    expect(f.calls.filter((call) => call.write)).toEqual([
      { method: "browser_task.release", params: { task_id: "browser-task" }, write: true },
    ]);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "does not adopt a replacement takeover while the websocket handshake is in flight",
  () => {
    const f = fixture();
    f.responses["browser_task.get"] = {
      ...userState,
      lease: { ...userState.lease, takeover_id: "replacement" },
    };
    return Effect.scoped(
      Effect.gen(function* () {
        const computer = yield* Service.MuseAgentComputerService;
        expect((yield* computer.openStream(scope, "takeover").pipe(Effect.flip)).code).toBe(
          "control_conflict",
        );
        expect(f.streams).toEqual([]);
        expect(f.calls.filter((call) => call.write)).toEqual([]);
        const current = yield* computer.openStream(scope, "replacement");
        expect(f.streams).toEqual([
          { taskId: "browser-task", sessionId: "primary", takeoverId: "replacement" },
        ]);
        yield* current.close;
      }),
    ).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "cleans up a failed stream acquisition without releasing a replacement or masking its error",
  () => {
    return Effect.gen(function* () {
      for (const replacement of [false, true]) {
        const f = fixture();
        f.responses["browser_task.get"] = userState;
        f.failStream(() => {
          if (replacement)
            f.responses["browser_task.get"] = {
              ...userState,
              lease: { ...userState.lease, takeover_id: "replacement" },
            };
          return new Transport.MuseAgentTransportError({ kind: "unavailable" });
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const computer = yield* Service.MuseAgentComputerService;
            expect((yield* computer.openStream(scope, "takeover").pipe(Effect.flip)).code).toBe(
              "connection_unavailable",
            );
          }),
        ).pipe(Effect.provide(f.layer));
        expect(f.calls.filter((call) => call.write)).toEqual(
          replacement
            ? []
            : [
                {
                  method: "browser_task.release",
                  params: { task_id: "browser-task" },
                  write: true,
                },
              ],
        );
        expect(f.streams).toEqual([
          { taskId: "browser-task", sessionId: "primary", takeoverId: "takeover" },
        ]);
      }
    });
  },
);

it.effect(
  "serializes stale viewer cleanup with takeover so a delayed read cannot release its replacement",
  () => {
    const f = fixture();
    f.responses["browser_task.get"] = userState;
    return Effect.scoped(
      Effect.gen(function* () {
        const checked = yield* Deferred.make<void>(),
          resume = yield* Deferred.make<void>();
        let checks = 0;
        f.onConnection(() =>
          Effect.gen(function* () {
            checks++;
            if (checks === 4) {
              yield* Deferred.succeed(checked, undefined);
              yield* Deferred.await(resume);
            }
          }),
        );
        const replacement = {
          ...userState,
          lease: { ...userState.lease, takeover_id: "replacement" },
        };
        f.responses["browser_task.takeover"] = replacement;
        f.onRequest((method) => {
          if (method === "browser_task.takeover") f.responses["browser_task.get"] = replacement;
        });
        const computer = yield* Service.MuseAgentComputerService;
        const old = yield* computer.openStream(scope, "takeover");
        const closing = yield* old.close.pipe(Effect.forkScoped);
        yield* Deferred.await(checked);
        const replacing = yield* computer
          .operate(scope, { action: "takeover" })
          .pipe(Effect.forkScoped);
        yield* TestClock.adjust("2 seconds");
        expect((yield* Fiber.join(replacing)).action).toBe("takeover");
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(closing);
        expect(f.calls.filter((call) => call.write)).toEqual([
          { method: "browser_task.takeover", params: { task_id: "browser-task" }, write: true },
        ]);
        expect((yield* computer.readTask(scope)).state.lease?.takeoverId).toBe("replacement");
      }),
    ).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "serializes heartbeat validation and renewal before a queued replacement takeover",
  () => {
    const f = fixture();
    f.responses["browser_task.get"] = userState;
    return Effect.scoped(
      Effect.gen(function* () {
        const checked = yield* Deferred.make<void>(),
          resume = yield* Deferred.make<void>();
        let reads = 0;
        f.onResponse((method) => {
          if (method !== "browser_task.get" || ++reads !== 2) return undefined;
          return Deferred.succeed(checked, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.as(userState),
          );
        });
        const replacement = {
          ...userState,
          lease: { ...userState.lease, takeover_id: "replacement" },
        };
        f.responses["browser_task.takeover"] = replacement;
        f.onRequest((method) => {
          if (method === "browser_task.takeover") {
            f.responses["browser_task.get"] = replacement;
            f.responses["browser_task.heartbeat"] = replacement;
          }
        });
        const computer = yield* Service.MuseAgentComputerService;
        const old = yield* computer.openStream(scope, "takeover");
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.await(checked);
        const replacing = yield* computer
          .operate(scope, { action: "takeover" })
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(resume, undefined);
        expect((yield* Fiber.join(replacing)).action).toBe("takeover");
        yield* old.close;
        expect(f.calls.filter((call) => call.write)).toEqual([
          { method: "browser_task.heartbeat", params: { task_id: "browser-task" }, write: true },
          { method: "browser_task.takeover", params: { task_id: "browser-task" }, write: true },
        ]);
        expect((yield* computer.readTask(scope)).state.lease?.takeoverId).toBe("replacement");
      }),
    ).pipe(Effect.provide(f.layer));
  },
);

it.effect("reads only the selected task and exposes a scoped preview descriptor", () => {
  const f = fixture();
  f.responses["browser_task.get"] = { ...nativeState, privateCredential: "synthetic-hidden" };
  return Effect.gen(function* () {
    const computer = yield* Service.MuseAgentComputerService;
    expect(yield* computer.readTask(scope)).toEqual({
      task: {
        taskId: "browser-task",
        sessionId: "primary",
        title: "Synthetic browser task",
        status: "running",
        readOnly: false,
        previewAvailable: true,
      },
      state: expectedAgentState,
      preview: { taskId: "browser-task", sha256: hash, width: 1280, height: 720, updatedAtMs: 42 },
    });
  }).pipe(Effect.provide(f.layer));
});
it.effect(
  "transfers the image selected by current metadata through the authenticated media boundary",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const computer = yield* Service.MuseAgentComputerService;
      expect(yield* computer.preview(scope)).toEqual({
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "image/png",
      });
      expect(f.media).toEqual([{ taskId: "browser-task", sha256: hash }]);
      expect(f.calls.map((call) => call.method)).toEqual(["computer.context", "browser_task.get"]);
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect(
  "allows a visible computer task owned by a read-only worker session absent from chats",
  () => {
    const f = fixture();
    const worker = { ...scope, sessionId: "worker:readonly-execution" };
    f.responses["sessions.list"] = { sessions: [] };
    f.responses["computer.context"] = { tasks: [{ ...nativeTask, session_id: worker.sessionId }] };
    f.responses["browser_task.get"] = { ...nativeState, session_id: worker.sessionId };
    f.responses["browser_task.takeover"] = { ...userState, session_id: worker.sessionId };
    return Effect.gen(function* () {
      const computer = yield* Service.MuseAgentComputerService;
      expect((yield* computer.readTask(worker)).state.sessionId).toBe(worker.sessionId);
      expect(yield* computer.preview(worker)).toEqual({
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "image/png",
      });
      expect((yield* computer.operate(worker, { action: "takeover" })).action).toBe("takeover");
      expect(f.calls.some((call) => call.method === "sessions.list")).toBe(false);
      expect(f.calls.filter((call) => call.write)).toEqual([
        { method: "browser_task.takeover", params: { task_id: worker.taskId }, write: true },
      ]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "refuses foreign context/state sessions and readonly activity before preview or mutation",
  () =>
    Effect.gen(function* () {
      for (const kind of ["foreign-context", "foreign-state", "activity"] as const) {
        const f = fixture();
        if (kind === "foreign-state")
          f.responses["browser_task.get"] = { ...nativeState, session_id: "other" };
        else
          f.responses["computer.context"] = {
            tasks: [
              kind === "foreign-context"
                ? { ...nativeTask, session_id: "other" }
                : { activity_thread_id: scope.taskId, name: "Readonly activity" },
            ],
          };
        yield* Effect.gen(function* () {
          const computer = yield* Service.MuseAgentComputerService;
          for (const effect of [
            computer.preview(scope).pipe(Effect.asVoid),
            computer.operate(scope, { action: "takeover" }).pipe(Effect.asVoid),
          ])
            expect((yield* Effect.flip(effect)).code).toBe(
              kind === "activity" ? "read_only" : "task_unavailable",
            );
        }).pipe(Effect.provide(f.layer));
        expect(f.calls.filter((call) => call.write)).toEqual([]);
        expect(f.media).toEqual([]);
        expect(f.calls[0]).toEqual({ method: "computer.context", params: {}, write: false });
      }
    }),
);
it.effect("rejects account and physical connection changes before preview or control", () => {
  return Effect.gen(function* () {
    const account = fixture();
    account.changeAccount();
    const accountError = yield* Effect.gen(function* () {
      const computer = yield* Service.MuseAgentComputerService;
      return yield* computer.preview(scope).pipe(Effect.flip);
    }).pipe(Effect.provide(account.layer));
    expect(accountError.code).toBe("account_changed");
    expect(account.calls).toEqual([]);
    const changed = fixture();
    changed.onRequest((method) => {
      if (method === "browser_task.get") changed.changeConnection();
    });
    const connectionError = yield* Effect.gen(function* () {
      const computer = yield* Service.MuseAgentComputerService;
      return yield* computer.preview(scope).pipe(Effect.flip);
    }).pipe(Effect.provide(changed.layer));
    expect(connectionError.code).toBe("connection_changed");
    expect(changed.media).toEqual([]);
    expect(changed.calls.at(-1)).toEqual({
      method: "browser_task.get",
      params: { task_id: "browser-task" },
      write: false,
    });
  });
});
it.effect("refuses foreign and legacy preview URLs while retaining readable task state", () => {
  return Effect.gen(function* () {
    for (const url of [
      `/api/computer/previews/other/${hash}`,
      `https://example.invalid/api/computer/previews/browser-task/${hash}`,
      "/api/browser-activity/actions/old/snapshot",
    ]) {
      const f = fixture();
      f.responses["computer.context"] = {
        tasks: [{ ...nativeTask, latest_screenshot: { ...nativeTask.latest_screenshot, url } }],
      };
      yield* Effect.gen(function* () {
        const computer = yield* Service.MuseAgentComputerService;
        expect((yield* computer.readTask(scope)).state).toEqual(expectedAgentState);
        expect((yield* computer.preview(scope).pipe(Effect.flip)).code).toBe("preview_unavailable");
      }).pipe(Effect.provide(f.layer));
      expect(f.media).toEqual([]);
    }
  });
});
it.effect(
  "takes over the exact task with the shipped viewer payload and validates its lease",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const computer = yield* Service.MuseAgentComputerService;
      expect(
        yield* computer.operate(scope, {
          action: "takeover",
          viewer: { width: 1920, height: 1080, devicePixelRatio: 2 },
        }),
      ).toEqual({
        action: "takeover",
        state: {
          ...expectedAgentState,
          lease: {
            controlOwner: "user",
            taskId: "browser-task",
            takeoverId: "takeover",
            controlExpiresAtMs: 12000,
          },
        },
      });
      expect(f.calls.at(-1)).toEqual({
        method: "browser_task.takeover",
        params: {
          task_id: "browser-task",
          viewer: { width: 1920, height: 1080, device_pixel_ratio: 2 },
        },
        write: true,
      });
    }).pipe(Effect.provide(f.layer));
  },
);
it.effect("refuses a takeover receipt for another presented task or user lease", () => {
  return Effect.gen(function* () {
    for (const receipt of [
      { ...userState, presented_task_id: "other" },
      { ...userState, lease: { ...userState.lease, task_id: "other" } },
    ]) {
      const f = fixture();
      f.responses["browser_task.takeover"] = receipt;
      yield* Effect.gen(function* () {
        const computer = yield* Service.MuseAgentComputerService;
        expect(
          (yield* computer.operate(scope, { action: "takeover" }).pipe(Effect.flip)).code,
        ).toBe("control_conflict");
      }).pipe(Effect.provide(f.layer));
      expect(f.calls.at(-1)?.method).toBe("browser_task.takeover");
    }
  });
});
it.effect("renews and releases only a user lease for the selected task", () => {
  const f = fixture();
  f.responses["browser_task.get"] = userState;
  return Effect.gen(function* () {
    const computer = yield* Service.MuseAgentComputerService;
    expect(
      (yield* computer.operate(scope, { action: "heartbeat", takeoverId: "takeover" })).action,
    ).toBe("heartbeat");
    expect(yield* computer.operate(scope, { action: "release", takeoverId: "takeover" })).toEqual({
      action: "release",
      state: expectedAgentState,
    });
    expect(f.calls.filter((call) => call.write)).toEqual([
      { method: "browser_task.heartbeat", params: { task_id: "browser-task" }, write: true },
      { method: "browser_task.release", params: { task_id: "browser-task" }, write: true },
    ]);
  }).pipe(Effect.provide(f.layer));
});
it.effect("refuses heartbeat, resize and release for an unrelated user lease", () => {
  const f = fixture();
  f.responses["browser_task.get"] = {
    ...userState,
    lease: { ...userState.lease, task_id: "other" },
  };
  return Effect.gen(function* () {
    const computer = yield* Service.MuseAgentComputerService;
    for (const action of [
      { action: "heartbeat", takeoverId: "takeover" },
      { action: "release", takeoverId: "takeover" },
      {
        action: "viewer",
        takeoverId: "takeover",
        viewer: { width: 800, height: 600, devicePixelRatio: 1 },
      },
    ] as const)
      expect((yield* computer.operate(scope, action).pipe(Effect.flip)).code).toBe(
        "control_conflict",
      );
    expect(f.calls.filter((call) => call.write)).toEqual([]);
    expect(f.calls[0]?.method).toBe("computer.context");
  }).pipe(Effect.provide(f.layer));
});
it.effect("bounds framebuffer dimensions before making a native request", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const computer = yield* Service.MuseAgentComputerService;
    expect(
      (yield* computer
        .operate(scope, {
          action: "present",
          viewer: { width: 1, height: 40000, devicePixelRatio: 1 },
        })
        .pipe(Effect.flip)).code,
    ).toBe("invalid_request");
    expect(f.calls).toEqual([]);
    expect(yield* computer.operate(scope, { action: "present" })).toEqual({
      action: "present",
      state: expectedAgentState,
    });
  }).pipe(Effect.provide(f.layer));
});
it.effect("stops and closes without inventing acknowledgement fields", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const computer = yield* Service.MuseAgentComputerService;
    expect(yield* computer.operate(scope, { action: "stop" })).toEqual({ action: "stop" });
    expect(yield* computer.operate(scope, { action: "close" })).toEqual({ action: "close" });
    expect(f.calls.filter((call) => call.write)).toEqual([
      { method: "browser_task.stop", params: { task_id: "browser-task" }, write: true },
      { method: "browser_task.close", params: { task_id: "browser-task" }, write: true },
    ]);
  }).pipe(Effect.provide(f.layer));
});
it.effect("keeps uncertain writes uncertain and never retries a native action", () => {
  const f = fixture();
  f.onRequest((method) => {
    if (method === "browser_task.stop")
      f.fail(new Transport.MuseAgentTransportError({ kind: "uncertain" }));
  });
  return Effect.gen(function* () {
    const computer = yield* Service.MuseAgentComputerService;
    expect((yield* computer.operate(scope, { action: "stop" }).pipe(Effect.flip)).code).toBe(
      "write_uncertain",
    );
    expect(f.calls.filter((call) => call.write)).toEqual([
      { method: "browser_task.stop", params: { task_id: "browser-task" }, write: true },
    ]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("resizes only the selected user task with native viewer dimensions", () => {
  const f = fixture();
  f.responses["browser_task.get"] = userState;
  return Effect.gen(function* () {
    const computer = yield* Service.MuseAgentComputerService;
    expect(
      yield* computer.operate(scope, {
        action: "viewer",
        takeoverId: "takeover",
        viewer: { width: 800, height: 600, devicePixelRatio: 1 },
      }),
    ).toEqual({ action: "viewer" });
    expect(f.calls.at(-1)).toEqual({
      method: "browser_task.viewer",
      params: {
        task_id: "browser-task",
        viewer: { width: 800, height: 600, device_pixel_ratio: 1 },
      },
      write: true,
    });
  }).pipe(Effect.provide(f.layer));
});
it.effect(
  "refreshes the selected environment using the verified residential profile and receipt",
  () => {
    const f = fixture();
    const receipt = {
      previous_vm_uuid: "previous-vm",
      vm_uuid: "new-vm",
      presented: true,
      browser_incarnation: "incarnation",
      route_generation: 3,
      egress_profile: "residential",
    };
    f.responses["browser_task.refresh_environment"] = {
      ...receipt,
      privateCredential: "synthetic-hidden",
    };
    return Effect.gen(function* () {
      const computer = yield* Service.MuseAgentComputerService;
      expect(yield* computer.operate(scope, { action: "refresh_environment" })).toEqual({
        action: "refresh_environment",
        environment: receipt,
      });
      expect(f.calls.at(-1)).toEqual({
        method: "browser_task.refresh_environment",
        params: { task_id: "browser-task", requested_egress_profile: "residential" },
        write: true,
      });
      f.responses["browser_task.refresh_environment"] = { ...receipt, egress_profile: "unknown" };
      expect(
        (yield* computer.operate(scope, { action: "refresh_environment" }).pipe(Effect.flip)).code,
      ).toBe("invalid_response");
    }).pipe(Effect.provide(f.layer));
  },
);
