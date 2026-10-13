import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { fetchEnvironmentMuseAgentComputerPreview } from "./museAgentComputerPreviewHttp.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("muse-media-environment"),
  label: "Muse media environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  target,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
};
const reference = {
  providerInstanceId: ProviderInstanceId.make("muse-agent-test"),
  sessionId: "session with space",
  taskId: "task one",
};
const expectedUrl =
  "https://environment.example.test/api/ai-agents/muse/muse-agent-test/computer/session%20with%20space/task%20one/preview";
const bytes = new Uint8Array([0, 1, 2, 255]);

function harness(reply: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    return reply();
  };
  return { calls, layer: RpcHttp.layerRemoteHttpClient(fetchFn) };
}

describe("Muse computer preview authenticated transport", () => {
  it.effect.each([
    { name: "cookie", authorization: null },
    { name: "bearer", authorization: { _tag: "Bearer" as const, token: "muse-media-token" } },
  ])(
    "loads binary media from selected environment with $name authentication",
    ({ authorization }) =>
      Effect.gen(function* () {
        const h = harness(() => new Response(bytes, { headers: { "content-type": "image/png" } }));
        const result = yield* fetchEnvironmentMuseAgentComputerPreview({
          prepared: { ...prepared, httpAuthorization: authorization },
          reference,
          signer: Option.none(),
        }).pipe(Effect.provide(h.layer));
        expect(result).toEqual({ _tag: "Available", bytes, contentType: "image/png" });
        expect(h.calls[0]?.url).toBe(expectedUrl);
        expect(h.calls[0]?.init.credentials).toBe(authorization === null ? "include" : undefined);
        expect(new Headers(h.calls[0]?.init.headers).get("authorization")).toBe(
          authorization === null ? null : "Bearer muse-media-token",
        );
      }),
  );

  it.effect("signs the exact provider, native session and task URL for relay access", () =>
    Effect.gen(function* () {
      const proofs: ManagedRelay.ManagedRelayDpopProofInput[] = [];
      const signer = ManagedRelay.ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("muse-media-key"),
        createProof: (input) =>
          Effect.sync(() => {
            proofs.push(input);
            return "media-proof";
          }),
      });
      const h = harness(() => new Response(bytes, { headers: { "content-type": "image/webp" } }));
      const result = yield* fetchEnvironmentMuseAgentComputerPreview({
        prepared: {
          ...prepared,
          httpAuthorization: {
            _tag: "Dpop",
            accessToken: "media-access",
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
          },
        },
        reference,
        signer: Option.some(signer),
        remoteAuthorization: Option.some(
          RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization.of({
            authorizeBearer: () => Effect.die("Unexpected bearer request"),
            authorizeDpop: () => Effect.die("Unexpected socket request"),
            authorizeDpopHttp: () =>
              Effect.succeed({
                environmentId: target.environmentId,
                label: target.label,
                httpBaseUrl: "https://environment.example.test",
                httpAuthorization: {
                  _tag: "Dpop" as const,
                  accessToken: "media-access",
                  expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
                },
              }),
          }),
        ),
      }).pipe(Effect.provide(h.layer));
      expect(result._tag).toBe("Available");
      expect(proofs).toHaveLength(1);
      expect(proofs[0]).toMatchObject({
        method: "GET",
        url: expectedUrl,
        accessToken: "media-access",
      });
      expect(new Headers(h.calls[0]?.init.headers).get("dpop")).toBe("media-proof");
    }),
  );

  it.effect.each([0, 20 * 1024 * 1024 + 1])("rejects invalid media size %s", (size) =>
    Effect.gen(function* () {
      const h = harness(
        () => new Response(new Uint8Array(size), { headers: { "content-type": "image/png" } }),
      );
      const result = yield* fetchEnvironmentMuseAgentComputerPreview({
        prepared,
        reference,
        signer: Option.none(),
      }).pipe(Effect.provide(h.layer));
      expect(result).toEqual({ _tag: "Unavailable" });
    }),
  );

  it.effect("refuses executable content from a successful media response", () =>
    Effect.gen(function* () {
      const h = harness(
        () => new Response("<script>test</script>", { headers: { "content-type": "text/html" } }),
      );
      const error = yield* fetchEnvironmentMuseAgentComputerPreview({
        prepared,
        reference,
        signer: Option.none(),
      }).pipe(Effect.provide(h.layer), Effect.flip);
      expect(error._tag).toBe("RemoteEnvironmentAuthInvalidJsonError");
    }),
  );

  it.effect("treats an optional route absent on an older environment as Missing", () =>
    Effect.gen(function* () {
      const h = harness(() => new Response("Not found", { status: 404 }));
      const result = yield* fetchEnvironmentMuseAgentComputerPreview({
        prepared,
        reference,
        signer: Option.none(),
      }).pipe(Effect.provide(h.layer));
      expect(result).toEqual({ _tag: "Missing" });
    }),
  );
});
