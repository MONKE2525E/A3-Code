import { assert, it, vi } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";

function projectionWithRuntimeRequest(
  runtimeRequest?: OrchestrationV2RuntimeRequest,
): OrchestrationV2ThreadProjection {
  return {
    runtimeRequests: runtimeRequest === undefined ? [] : [runtimeRequest],
  } as unknown as OrchestrationV2ThreadProjection;
}

function resolvedRuntimeRequest(
  requestId: RuntimeRequestId,
  providerSessionId: ProviderSessionId,
): OrchestrationV2RuntimeRequest {
  return {
    id: requestId,
    nodeId: NodeId.make(`node-${requestId}`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status: "resolved",
    responseCapability: {
      type: "live",
      providerSessionId,
    },
    createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
    resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
  };
}

function layerRuntimeRequestTest(
  projection: OrchestrationV2ThreadProjection,
  getSession: ProviderSessionManager.ProviderSessionManagerV2Shape["get"],
) {
  return RuntimeRequestService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRuntimeRequest: (_threadId, requestId) =>
            Effect.succeed(projection.runtimeRequests.find((request) => request.id === requestId)),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: getSession,
        }),
      ),
    ),
  );
}

it.effect("forwards orchestrator-resolved runtime requests to the live adapter", () => {
  const threadId = ThreadId.make("thread-runtime-request-resolved");
  const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-resolved");
  const requestId = RuntimeRequestId.make("request-resolved");
  const respondToRuntimeRequest = vi.fn(
    (_input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
  );
  const getSession = vi.fn(() =>
    Effect.succeed(
      Option.some({
        respondToRuntimeRequest,
      } as never),
    ),
  );
  const projection = {
    runtimeRequests: [
      {
        id: requestId,
        nodeId: NodeId.make("node-runtime-request-resolved"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "resolved",
        responseCapability: {
          type: "live",
          providerSessionId,
        },
        createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
        resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const layerTest = RuntimeRequestService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRuntimeRequest: (_threadId, requestId) =>
            Effect.succeed(projection.runtimeRequests.find((request) => request.id === requestId)),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: getSession,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    yield* service.respond({
      threadId,
      providerSessionId,
      requestId,
      decision: "accept",
    });

    assert.equal(getSession.mock.calls.length, 1);
    assert.equal(respondToRuntimeRequest.mock.calls.length, 1);
    assert.deepEqual(respondToRuntimeRequest.mock.calls[0]?.[0], {
      requestId,
      decision: "accept",
    });
  }).pipe(Effect.provide(layerTest));
});

it.effect.each(["auto_review_approval/", "local_tool_permission/", "connector_grant/"])(
  "executes pending $0 only through its bound native session",
  (prefix) => {
    const threadId = ThreadId.make("native-thread");
    const providerSessionId = ProviderSessionId.make("native-session");
    const requestId = RuntimeRequestId.make(`native-${prefix}`);
    const request: OrchestrationV2RuntimeRequest = {
      ...resolvedRuntimeRequest(requestId, providerSessionId),
      status: "pending",
      resolvedAt: null,
      nativeRequestRef: {
        driver: ProviderDriverKind.make("grok-bot"),
        nativeId: `${prefix}request`,
        strength: "strong",
      },
    };
    const respondToRuntimeRequest = vi.fn(
      (_input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
    );
    const getSession = vi.fn(() =>
      Effect.succeed(Option.some({ respondToRuntimeRequest } as never)),
    );
    const projection = projectionWithRuntimeRequest(request);
    return Effect.gen(function* () {
      const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
      yield* service.respond({ threadId, providerSessionId, requestId, decision: "accept" });
      assert.deepStrictEqual(respondToRuntimeRequest.mock.calls, [
        [{ requestId, decision: "accept" }],
      ]);
      const error = yield* service
        .respond({
          threadId,
          providerSessionId: ProviderSessionId.make("other-session"),
          requestId,
          decision: "accept",
        })
        .pipe(Effect.flip);
      assert.equal(error.reason, "request-not-ready");
      assert.equal(respondToRuntimeRequest.mock.calls.length, 1);
      assert.equal(getSession.mock.calls.length, 1);
      assert.equal(projection.runtimeRequests[0]?.status, "pending");
    }).pipe(Effect.provide(layerRuntimeRequestTest(projection, getSession)));
  },
);

it.effect.each([
  { driver: "codex", strength: "strong", nativeId: "local_tool_permission/request" },
  { driver: "grok-bot", strength: "weak", nativeId: "local_tool_permission/request" },
  { driver: "grok-bot", strength: "strong", nativeId: "unknown/request" },
] as const)(
  "rejects pending live requests with an unrelated or weak native identity: $driver $strength $nativeId",
  (nativeRef) => {
    const threadId = ThreadId.make("unbound-thread");
    const providerSessionId = ProviderSessionId.make("unbound-session");
    const requestId = RuntimeRequestId.make("unbound-request");
    const request: OrchestrationV2RuntimeRequest = {
      ...resolvedRuntimeRequest(requestId, providerSessionId),
      status: "pending",
      resolvedAt: null,
      nativeRequestRef: { ...nativeRef, driver: ProviderDriverKind.make(nativeRef.driver) },
    };
    const getSession = vi.fn(() => Effect.succeed(Option.none()));
    return Effect.gen(function* () {
      const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
      const error = yield* service
        .respond({ threadId, providerSessionId, requestId, decision: "accept" })
        .pipe(Effect.flip);
      assert.equal(error.reason, "request-not-ready");
      assert.equal(getSession.mock.calls.length, 0);
    }).pipe(
      Effect.provide(layerRuntimeRequestTest(projectionWithRuntimeRequest(request), getSession)),
    );
  },
);

it.effect("rejects expired runtime requests before invoking the live adapter", () => {
  const threadId = ThreadId.make("thread-runtime-request-expired");
  const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-expired");
  const requestId = RuntimeRequestId.make("request-expired");
  const respondToRuntimeRequest = vi.fn(
    (_input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
  );
  const getSession = vi.fn(() =>
    Effect.succeed(
      Option.some({
        respondToRuntimeRequest,
      } as never),
    ),
  );
  const projection = {
    runtimeRequests: [
      {
        id: requestId,
        nodeId: NodeId.make("node-runtime-request-expired"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "expired",
        responseCapability: {
          type: "live",
          providerSessionId,
        },
        createdAt: DateTime.makeUnsafe("2026-07-29T00:00:00.000Z"),
        resolvedAt: DateTime.makeUnsafe("2026-07-29T00:00:01.000Z"),
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const layerTest = RuntimeRequestService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getRuntimeRequest: (_threadId, requestId) =>
            Effect.succeed(projection.runtimeRequests.find((request) => request.id === requestId)),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: getSession,
        }),
      ),
    ),
  );

  return Effect.gen(function* () {
    const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    const error = yield* service
      .respond({
        threadId,
        providerSessionId,
        requestId,
        decision: "accept",
      })
      .pipe(Effect.flip);

    assert.equal(error.reason, "request-not-ready");
    assert.equal(
      error.message,
      `Runtime request ${requestId} on thread ${threadId} is not ready for response execution.`,
    );
    assert.isUndefined(error.cause);
    assert.equal(getSession.mock.calls.length, 0);
    assert.equal(respondToRuntimeRequest.mock.calls.length, 0);
  }).pipe(Effect.provide(layerTest));
});

it.effect("executes native cleanup for session-bound message questions", () => {
  const threadId = ThreadId.make("thread-native-message-question");
  const providerSessionId = ProviderSessionId.make("native-question-session");
  const requestId = RuntimeRequestId.make("native-message-question");
  const respondToRuntimeRequest = vi.fn(
    (_input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
  );
  const request = {
    ...resolvedRuntimeRequest(requestId, providerSessionId),
    kind: "user_input" as const,
    responseCapability: { type: "message" as const, providerSessionId },
  };
  const layerTest = layerRuntimeRequestTest(projectionWithRuntimeRequest(request), () =>
    Effect.succeed(Option.some({ respondToRuntimeRequest } as never)),
  );
  return Effect.gen(function* () {
    const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    yield* service.respond({ threadId, providerSessionId, requestId, decision: "cancel" });
    assert.deepEqual(respondToRuntimeRequest.mock.calls[0]?.[0], { requestId, decision: "cancel" });
  }).pipe(Effect.provide(layerTest));
});

it.effect("does not execute native cleanup for an unbound message question", () => {
  const threadId = ThreadId.make("thread-unbound-message-question");
  const providerSessionId = ProviderSessionId.make("unbound-question-session");
  const requestId = RuntimeRequestId.make("unbound-message-question");
  const getSession = vi.fn(() => Effect.succeed(Option.none()));
  const request = {
    ...resolvedRuntimeRequest(requestId, providerSessionId),
    kind: "user_input" as const,
    responseCapability: { type: "message" as const },
  };
  return Effect.gen(function* () {
    const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    const error = yield* service
      .respond({ threadId, providerSessionId, requestId, decision: "cancel" })
      .pipe(Effect.flip);
    assert.equal(error.reason, "request-not-resumable");
    assert.equal(getSession.mock.calls.length, 0);
  }).pipe(
    Effect.provide(layerRuntimeRequestTest(projectionWithRuntimeRequest(request), getSession)),
  );
});

it.effect("runs a native single choice while the bound question is still pending", () => {
  const threadId = ThreadId.make("thread-pending-native-question");
  const providerSessionId = ProviderSessionId.make("pending-native-question-session");
  const requestId = RuntimeRequestId.make("pending-native-question");
  const respondToRuntimeRequest = vi.fn(
    (_input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput) => Effect.void,
  );
  const request = {
    ...resolvedRuntimeRequest(requestId, providerSessionId),
    status: "pending" as const,
    resolvedAt: null,
    kind: "user_input" as const,
    responseCapability: { type: "message" as const, providerSessionId },
  };
  const layerTest = layerRuntimeRequestTest(projectionWithRuntimeRequest(request), () =>
    Effect.succeed(Option.some({ respondToRuntimeRequest } as never)),
  );
  return Effect.gen(function* () {
    const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    yield* service.respond({
      threadId,
      providerSessionId,
      requestId,
      answers: { color: "blue" },
    });
    assert.deepEqual(respondToRuntimeRequest.mock.calls[0]?.[0], {
      requestId,
      answers: { color: "blue" },
    });
  }).pipe(Effect.provide(layerTest));
});

it.effect("never runs native calls for a pending question that is not bound to the session", () => {
  const threadId = ThreadId.make("thread-pending-unbound-question");
  const providerSessionId = ProviderSessionId.make("pending-unbound-question-session");
  const requestId = RuntimeRequestId.make("pending-unbound-question");
  const getSession = vi.fn(() => Effect.succeed(Option.none()));
  const request = {
    ...resolvedRuntimeRequest(requestId, providerSessionId),
    status: "pending" as const,
    resolvedAt: null,
    kind: "user_input" as const,
    responseCapability: { type: "message" as const },
  };
  return Effect.gen(function* () {
    const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    const error = yield* service
      .respond({ threadId, providerSessionId, requestId, decision: "cancel" })
      .pipe(Effect.flip);
    assert.equal(error.reason, "request-not-ready");
    assert.equal(getSession.mock.calls.length, 0);
  }).pipe(
    Effect.provide(layerRuntimeRequestTest(projectionWithRuntimeRequest(request), getSession)),
  );
});

it.effect("classifies runtime request response validation failures", () => {
  const threadId = ThreadId.make("thread-runtime-request-validation");
  const providerSessionId = ProviderSessionId.make("provider-session-runtime-request-validation");
  const otherProviderSessionId = ProviderSessionId.make(
    "provider-session-runtime-request-validation-other",
  );
  const requestId = RuntimeRequestId.make("request-validation");
  const unexpectedGetSession = vi.fn(() => Effect.succeed(Option.none()));
  const layerMissing = layerRuntimeRequestTest(
    projectionWithRuntimeRequest(),
    unexpectedGetSession,
  );
  const layerNotResumable = layerRuntimeRequestTest(
    projectionWithRuntimeRequest(resolvedRuntimeRequest(requestId, otherProviderSessionId)),
    unexpectedGetSession,
  );
  const layerInactive = layerRuntimeRequestTest(
    projectionWithRuntimeRequest(resolvedRuntimeRequest(requestId, providerSessionId)),
    () => Effect.succeed(Option.none()),
  );
  const respond = Effect.gen(function* () {
    const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    return yield* service
      .respond({
        threadId,
        providerSessionId,
        requestId,
        decision: "accept",
      })
      .pipe(Effect.flip);
  });

  return Effect.gen(function* () {
    const missing = yield* respond.pipe(Effect.provide(layerMissing));
    assert.equal(missing.reason, "request-missing");
    assert.equal(
      missing.message,
      `Runtime request ${requestId} no longer exists on thread ${threadId}.`,
    );
    assert.isUndefined(missing.cause);

    const notResumable = yield* respond.pipe(Effect.provide(layerNotResumable));
    assert.equal(notResumable.reason, "request-not-resumable");
    assert.equal(
      notResumable.message,
      `Runtime request ${requestId} on thread ${threadId} is not resumable on provider session ${providerSessionId}.`,
    );
    assert.isUndefined(notResumable.cause);

    const inactive = yield* respond.pipe(Effect.provide(layerInactive));
    assert.equal(inactive.reason, "provider-session-not-active");
    assert.equal(
      inactive.message,
      `Provider session ${providerSessionId} is not active for runtime request ${requestId} on thread ${threadId}.`,
    );
    assert.isUndefined(inactive.cause);
    assert.equal(unexpectedGetSession.mock.calls.length, 0);
  });
});

it.effect("preserves genuine provider session lookup failures as the cause", () => {
  const threadId = ThreadId.make("thread-runtime-request-lookup-failure");
  const providerSessionId = ProviderSessionId.make(
    "provider-session-runtime-request-lookup-failure",
  );
  const requestId = RuntimeRequestId.make("request-lookup-failure");
  const lookupFailure = new ProviderSessionManager.ProviderSessionLookupError({
    providerSessionId,
    cause: "lookup failed",
  });
  const layerTest = layerRuntimeRequestTest(
    projectionWithRuntimeRequest(resolvedRuntimeRequest(requestId, providerSessionId)),
    () => Effect.fail(lookupFailure),
  );

  return Effect.gen(function* () {
    const service = yield* RuntimeRequestService.RuntimeRequestServiceV2;
    const error = yield* service
      .respond({
        threadId,
        providerSessionId,
        requestId,
        decision: "accept",
      })
      .pipe(Effect.flip);

    assert.instanceOf(error, RuntimeRequestService.RuntimeRequestResponseExecutionError);
    assert.equal(error.reason, "unexpected-failure");
    assert.equal(
      error.message,
      `Failed to respond to runtime request ${requestId} on thread ${threadId} via provider session ${providerSessionId}.`,
    );
    assert.strictEqual(error.cause, lookupFailure);
  }).pipe(Effect.provide(layerTest));
});
