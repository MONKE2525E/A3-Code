import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  CLIENT_GUARDED_RPC_SCOPES,
  EnvironmentHttpApi,
  NativeAgentError,
  MuseAgentDictationRequestError,
  ProviderInstanceId,
  WS_METHODS,
  WsRpcGroup,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as RpcTest from "effect/rpc/RpcTest";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import * as Auth from "../auth/EnvironmentAuth.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as Http from "../http.ts";
import * as Agents from "./NativeAgentService.ts";

const decodeDictationRequestError = Schema.decodeUnknownSync(MuseAgentDictationRequestError);
const instanceId = ProviderInstanceId.make("muse-agent-routes");
class AvatarTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.museAgentAvatar)
  .add(EnvironmentHttpApi.groups.museAgentComputerPreview)
  .add(EnvironmentHttpApi.groups.museAgentDictation) {}
const avatarApp = () => {
  const calls: Array<{ instanceId: ProviderInstanceId; variant: string }> = [];
  const dictationCalls: Array<{
    providerInstanceId: ProviderInstanceId;
    pcm: Uint8Array;
    language?: string;
  }> = [];
  const computerCalls: Array<{
    instanceId: ProviderInstanceId;
    sessionId: string;
    taskId: string;
  }> = [];
  const auth = Layer.mock(Auth.EnvironmentAuth)({
    authenticateHttpRequest: (request) =>
      Effect.suspend(() => {
        if (request.headers.authorization === undefined)
          return Effect.fail(new Auth.ServerAuthMissingCredentialError({}));
        return Effect.succeed({
          sessionId: AuthSessionId.make("synthetic-session"),
          subject: "synthetic",
          method: "bearer-access-token" as const,
          scopes:
            request.headers.authorization === "Bearer synthetic-read"
              ? [AuthOrchestrationReadScope]
              : request.headers.authorization === "Bearer synthetic-operate"
                ? [AuthOrchestrationOperateScope]
                : [AuthSettingsWriteScope],
        });
      }),
  });
  const agents = Layer.mock(Agents.NativeAgentService)({
    dictationTranscribe: (input) =>
      Effect.suspend(() => {
        dictationCalls.push(input);
        if (input.providerInstanceId !== instanceId)
          return Effect.fail(new MuseAgentDictationRequestError({ code: "account_changed" }));
        if (input.pcm[0] === 255)
          return Effect.fail(new MuseAgentDictationRequestError({ code: "no_speech" }));
        return Effect.succeed({ text: "Synthetic transcript" });
      }),
    computerPreview: (provider, sessionId, taskId) =>
      Effect.suspend(() => {
        computerCalls.push({ instanceId: provider, sessionId, taskId });
        if (
          provider !== instanceId ||
          sessionId !== "primary:synthetic" ||
          taskId !== "task:synthetic"
        )
          return Effect.fail(new NativeAgentError({ reason: "provider_unavailable" }));
        return Effect.succeed({
          bytes: new Uint8Array([4, 5, 6]),
          contentType: "image/jpeg" as const,
        });
      }),
    avatar: (provider, variant) =>
      Effect.suspend(() => {
        calls.push({ instanceId: provider, variant });
        if (provider !== instanceId || !["image", "idle"].includes(variant))
          return Effect.fail(new NativeAgentError({ reason: "provider_unavailable" }));
        return Effect.succeed({
          bytes: new Uint8Array([1, 2, 3]),
          contentType: variant === "image" ? "image/png" : "video/mp4",
        });
      }),
  });
  const app = HttpApiBuilder.layer(AvatarTestApi).pipe(
    Layer.provide(Http.layerMuseAgentAvatarRoute),
    Layer.provide(Http.layerMuseAgentComputerPreviewRoute),
    Layer.provide(Http.layerMuseAgentDictationRoute),
    Layer.provide(agents),
    Layer.provideMerge(auth),
    Layer.provideMerge(HttpPlatform.layer.pipe(Layer.provide(Etag.layerWeak))),
    Layer.provideMerge(Etag.layerWeak),
    Layer.provideMerge(NodeServices.layer),
  );
  return {
    ...HttpRouter.toWebHandler(app, { disableLogger: true }),
    calls,
    computerCalls,
    dictationCalls,
  };
};

it("native avatar HTTP routes require read authentication before serving media", async () => {
  const app = avatarApp();
  try {
    const url = `https://synthetic.invalid/api/ai-agents/muse/${instanceId}/avatar/image`;
    assert.equal((await app.handler(new Request(url))).status, 401);
    assert.equal(
      (
        await app.handler(
          new Request(url, { headers: { authorization: "Bearer synthetic-settings" } }),
        )
      ).status,
      403,
    );
    assert.deepEqual(app.calls, []);
    const image = await app.handler(
      new Request(url, { headers: { authorization: "Bearer synthetic-read" } }),
    );
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("cache-control"), "private, no-store");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(new Uint8Array(await image.arrayBuffer()), new Uint8Array([1, 2, 3]));
    const video = await app.handler(
      new Request(url.replace(/image$/, "idle"), {
        headers: { authorization: "Bearer synthetic-read" },
      }),
    );
    assert.equal(video.status, 200);
    assert.equal(video.headers.get("content-type"), "video/mp4");
  } finally {
    await app.dispose();
  }
});

it("avatar HTTP routes select only profile variants and never accept arbitrary cloud paths", async () => {
  const app = avatarApp();
  try {
    const origin = "https://synthetic.invalid/api/ai-agents/muse/";
    for (const path of [
      `${instanceId}/avatar/idle/extra`,
      `${instanceId}/cloud-file/workspace/secret`,
      `${instanceId}/avatar/%2e%2e%2fsecret`,
      `${instanceId}/avatar/https%3A%2F%2Fforeign.invalid`,
      `${instanceId}/avatar/IMAGE`,
      `${instanceId}/avatar/${"a".repeat(65)}`,
      `invalid%20provider/avatar/image`,
    ])
      assert.include(
        [400, 404],
        (
          await app.handler(
            new Request(`${origin}${path}`, {
              headers: { authorization: "Bearer synthetic-read" },
            }),
          )
        ).status,
      );
    assert.deepEqual(app.calls, []);
    assert.equal(
      (
        await app.handler(
          new Request(`${origin}${instanceId}/avatar/missing`, {
            headers: { authorization: "Bearer synthetic-read" },
          }),
        )
      ).status,
      404,
    );
    assert.deepEqual(app.calls, [{ instanceId, variant: "missing" }]);
  } finally {
    await app.dispose();
  }
});

it.effect(
  "the typed avatar client decodes binary image/video media and preserves MIME headers",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(avatarApp),
      (app) => {
        const fetch: typeof globalThis.fetch = (request, init) =>
          app.handler(new Request(request, init));
        return Effect.gen(function* () {
          const httpClient = yield* HttpClient.HttpClient;
          const client = yield* HttpApiClient.group(AvatarTestApi, {
            group: "museAgentAvatar",
            baseUrl: "https://synthetic.invalid",
            httpClient,
          });
          for (const variant of ["image", "idle"]) {
            const [bytes, response] = yield* client.media({
              params: { providerInstanceId: instanceId, variant },
              query: { revision: "a".repeat(64) },
              headers: { authorization: "Bearer synthetic-read" },
              responseMode: "decoded-and-response",
            });
            assert.deepEqual(bytes, new Uint8Array([1, 2, 3]));
            assert.equal(
              response.headers["content-type"],
              variant === "image" ? "image/png" : "video/mp4",
            );
          }
          const missing = yield* client
            .media({
              params: { providerInstanceId: instanceId, variant: "missing" },
              query: {},
              headers: { authorization: "Bearer synthetic-read" },
            })
            .pipe(Effect.flip);
          assert.equal(missing._tag, "EnvironmentResourceNotFoundError");
        }).pipe(
          Effect.provide(
            FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
          ),
        );
      },
      (app) => Effect.promise(() => app.dispose()),
    ),
);

const guardedGroup = WsRpcGroup.omit(
  ...Array.from(WsRpcGroup.requests.keys()).filter(
    (
      tag,
    ): tag is Exclude<
      keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
      | typeof WS_METHODS.museAgentsFeatureRead
      | typeof WS_METHODS.museAgentsFeatureUpdate
      | typeof WS_METHODS.museAgentsSetup
    > =>
      tag !== WS_METHODS.museAgentsFeatureRead &&
      tag !== WS_METHODS.museAgentsFeatureUpdate &&
      tag !== WS_METHODS.museAgentsSetup,
  ),
);

it.effect.each(
  [false, true].flatMap((delivery) => [
    { delivery, scopes: [AuthOrchestrationReadScope], expected: [1, 0, 0] },
    { delivery, scopes: [AuthOrchestrationOperateScope], expected: [0, 1, 0] },
    { delivery, scopes: [AuthSettingsWriteScope], expected: [0, 0, 1] },
    { delivery, scopes: [], expected: [0, 0, 0] },
  ]),
)(
  "RPC guards enforce separate feature read/update/setup permissions for $scopes (delivery=$delivery)",
  ({ scopes, expected, delivery }) =>
    Effect.gen(function* () {
      const calls: [number, number, number] = [0, 0, 0];
      const client = yield* RpcTest.makeClient(guardedGroup).pipe(
        Effect.provide(
          Layer.mergeAll(
            guardedGroup.toLayerHandler(WS_METHODS.museAgentsFeatureRead, () =>
              Effect.sync(() => {
                calls[0]++;
                return delivery
                  ? {
                      operation: "pending_deliveries" as const,
                      data: { sessionId: "primary", deliveries: [] },
                    }
                  : { operation: "tasks" as const, data: [] };
              }),
            ),
            guardedGroup.toLayerHandler(WS_METHODS.museAgentsFeatureUpdate, () =>
              Effect.sync(() => {
                calls[1]++;
                return { updated: true as const };
              }),
            ),
            guardedGroup.toLayerHandler(WS_METHODS.museAgentsSetup, () =>
              Effect.sync(() => {
                calls[2]++;
                return {
                  installed: true,
                  sessionPresent: true,
                  ready: true,
                  message: "Synthetic",
                  provider: null,
                  capabilities: ["chat", "profile"],
                };
              }),
            ),
            RpcAuthorization.layer(scopes as ReadonlyArray<AuthEnvironmentScope>),
          ),
        ),
      );
      const results = yield* Effect.all([
        client[WS_METHODS.museAgentsFeatureRead](
          delivery
            ? {
                operation: "pending_deliveries",
                providerInstanceId: instanceId,
                sessionId: "primary",
              }
            : { operation: "tasks", providerInstanceId: instanceId },
        ).pipe(Effect.exit),
        client[WS_METHODS.museAgentsFeatureUpdate](
          delivery
            ? {
                operation: "delivery_release",
                providerInstanceId: instanceId,
                sessionId: "primary",
                deliveryKey: "synthetic-attempt",
              }
            : { operation: "task_delete", providerInstanceId: instanceId, jobId: "synthetic" },
        ).pipe(Effect.exit),
        client[WS_METHODS.museAgentsSetup]({}).pipe(Effect.exit),
      ]);
      assert.deepEqual(calls, expected);
      assert.deepEqual(
        results.map((result) => (result._tag === "Success" ? 1 : 0)),
        expected,
      );
      assert.equal(
        CLIENT_GUARDED_RPC_SCOPES[WS_METHODS.museAgentsFeatureUpdate],
        AuthOrchestrationOperateScope,
      );
      assert.equal(CLIENT_GUARDED_RPC_SCOPES[WS_METHODS.museAgentsSetup], AuthSettingsWriteScope);
    }).pipe(Effect.scoped),
);

it("computer preview HTTP requires read authentication and preserves selected task bytes/MIME", async () => {
  const app = avatarApp();
  try {
    const origin = `https://synthetic.invalid/api/ai-agents/muse/${instanceId}/computer/`;
    const path = `${encodeURIComponent("primary:synthetic")}/${encodeURIComponent("task:synthetic")}/preview`;
    assert.equal((await app.handler(new Request(origin + path))).status, 401);
    assert.equal(
      (
        await app.handler(
          new Request(origin + path, { headers: { authorization: "Bearer synthetic-settings" } }),
        )
      ).status,
      403,
    );
    assert.deepEqual(app.computerCalls, []);
    const response = await app.handler(
      new Request(origin + path, { headers: { authorization: "Bearer synthetic-read" } }),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([4, 5, 6]));
    assert.deepEqual(app.computerCalls, [
      { instanceId, sessionId: "primary:synthetic", taskId: "task:synthetic" },
    ]);
    for (const invalid of ["primary/foreign/preview", "foreign/task%3Asynthetic/preview"]) {
      assert.equal(
        (
          await app.handler(
            new Request(origin + invalid, { headers: { authorization: "Bearer synthetic-read" } }),
          )
        ).status,
        404,
      );
    }
    const called = app.computerCalls.length;
    for (const invalid of [
      "primary%2Fsecret/task/preview",
      "primary/task%2Fsecret/preview",
      `primary/${"a".repeat(1025)}/preview`,
      "primary/task/preview/extra",
    ]) {
      assert.include(
        [400, 404],
        (
          await app.handler(
            new Request(origin + invalid, { headers: { authorization: "Bearer synthetic-read" } }),
          )
        ).status,
      );
    }
    assert.equal(app.computerCalls.length, called);
  } finally {
    await app.dispose();
  }
});

it.effect("the typed computer preview client preserves binary media and MIME", () =>
  Effect.acquireUseRelease(
    Effect.sync(avatarApp),
    (app) => {
      const fetch: typeof globalThis.fetch = (request, init) =>
        app.handler(new Request(request, init));
      return Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;
        const client = yield* HttpApiClient.group(AvatarTestApi, {
          group: "museAgentComputerPreview",
          baseUrl: "https://synthetic.invalid",
          httpClient,
        });
        const [bytes, response] = yield* client.media({
          params: {
            providerInstanceId: instanceId,
            sessionId: "primary:synthetic",
            taskId: "task:synthetic",
          },
          headers: { authorization: "Bearer synthetic-read" },
          responseMode: "decoded-and-response",
        });
        assert.deepEqual(bytes, new Uint8Array([4, 5, 6]));
        assert.equal(response.headers["content-type"], "image/jpeg");
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
    },
    (app) => Effect.promise(() => app.dispose()),
  ),
);

it("dictation HTTP authenticates operate scope before reading audio and returns reviewed text", async () => {
  const app = avatarApp();
  try {
    const url = `https://synthetic.invalid/api/ai-agents/muse/${instanceId}/dictation?language=en`;
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(6));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const init = {
      method: "POST",
      body: stream,
      duplex: "half" as const,
      headers: { "content-type": "application/octet-stream" },
    };
    assert.equal((await app.handler(new Request(url, init))).status, 401);
    assert.equal(pulls, 0);
    for (const token of ["synthetic-read", "synthetic-settings"])
      assert.equal(
        (
          await app.handler(
            new Request(url, {
              method: "POST",
              body: new Uint8Array(6),
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/octet-stream",
              },
            }),
          )
        ).status,
        403,
      );
    assert.deepEqual(app.dictationCalls, []);
    const pcm = new Uint8Array([0, 0, 1, 0, 2, 0]);
    const response = await app.handler(
      new Request(url, {
        method: "POST",
        body: pcm,
        headers: {
          authorization: "Bearer synthetic-operate",
          "content-type": "application/octet-stream",
        },
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "Synthetic transcript" });
    assert.deepEqual(app.dictationCalls, [{ providerInstanceId: instanceId, pcm, language: "en" }]);
  } finally {
    await app.dispose();
  }
});

it("dictation HTTP bounds PCM even without Content-Length and returns safe failure codes", async () => {
  const app = avatarApp();
  try {
    const url = `https://synthetic.invalid/api/ai-agents/muse/${instanceId}/dictation`;
    const headers = {
      authorization: "Bearer synthetic-operate",
      "content-type": "application/octet-stream",
    };
    for (const pcm of [new Uint8Array(), new Uint8Array(7), new Uint8Array(2_880_002)]) {
      const response = await app.handler(new Request(url, { method: "POST", body: pcm, headers }));
      assert.equal(response.status, 422);
      assert.equal(decodeDictationRequestError(await response.json()).code, "invalid_audio");
    }
    const early = await app.handler(
      new Request(url, {
        method: "POST",
        body: new Uint8Array(6),
        headers: { ...headers, "content-length": "2880002" },
      }),
    );
    assert.equal(early.status, 422);
    assert.deepEqual(app.dictationCalls, []);
    const noSpeech = await app.handler(
      new Request(url, { method: "POST", body: new Uint8Array([255, 0, 0, 0, 0, 0]), headers }),
    );
    assert.equal(noSpeech.status, 422);
    assert.equal(decodeDictationRequestError(await noSpeech.json()).code, "no_speech");
    const wrong = await app.handler(
      new Request(url.replace(String(instanceId), "wrong-provider"), {
        method: "POST",
        body: new Uint8Array(6),
        headers,
      }),
    );
    assert.equal(wrong.status, 422);
    assert.equal(decodeDictationRequestError(await wrong.json()).code, "account_changed");
    assert.equal(
      (
        await app.handler(
          new Request(url + "?language=invalid", {
            method: "POST",
            body: new Uint8Array(6),
            headers,
          }),
        )
      ).status,
      400,
    );
  } finally {
    await app.dispose();
  }
});

it.effect("typed dictation client sends binary PCM and decodes review text", () =>
  Effect.acquireUseRelease(
    Effect.sync(avatarApp),
    (app) => {
      const fetch: typeof globalThis.fetch = (request, init) =>
        app.handler(new Request(request, init));
      return Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;
        const client = yield* HttpApiClient.group(AvatarTestApi, {
          group: "museAgentDictation",
          baseUrl: "https://synthetic.invalid",
          httpClient,
        });
        const pcm = new Uint8Array([0, 0, 1, 0, 2, 0]);
        assert.deepEqual(
          yield* client.transcribe({
            params: { providerInstanceId: instanceId },
            query: { language: "auto" },
            payload: pcm,
            headers: { authorization: "Bearer synthetic-operate" },
          }),
          { text: "Synthetic transcript" },
        );
        assert.deepEqual(app.dictationCalls, [
          { providerInstanceId: instanceId, pcm, language: "auto" },
        ]);
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
    },
    (app) => Effect.promise(() => app.dispose()),
  ),
);
