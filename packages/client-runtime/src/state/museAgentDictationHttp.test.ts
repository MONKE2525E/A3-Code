import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { transcribeEnvironmentMuseAudio } from "./museAgentDictationHttp.ts";

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
  pcm: new Uint8Array([0, 0, 1, 0, 255, 255]),
  language: "en" as const,
};
const expectedUrl =
  "https://environment.example.test/api/ai-agents/muse/muse-agent-test/dictation?language=en";
const transcript = { text: "Synthetic speech transcript." };

function harness(reply: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    return reply();
  };
  return { calls, layer: RpcHttp.layerRemoteHttpClient(fetchFn) };
}

describe("Muse dictation authenticated transport", () => {
  it.effect.each([
    { name: "cookie", authorization: null },
    { name: "bearer", authorization: { _tag: "Bearer" as const, token: "muse-media-token" } },
  ])(
    "uploads raw audio to the selected environment with $name authentication",
    ({ authorization }) =>
      Effect.gen(function* () {
        const h = harness(
          () =>
            new Response(JSON.stringify(transcript), {
              headers: { "content-type": "application/json" },
            }),
        );
        const result = yield* transcribeEnvironmentMuseAudio({
          prepared: { ...prepared, httpAuthorization: authorization },
          recording: reference,
          signer: Option.none(),
        }).pipe(Effect.provide(h.layer));
        expect(result).toEqual(transcript);
        expect(h.calls[0]?.url).toBe(expectedUrl);
        expect(h.calls[0]?.init.method).toBe("POST");
        expect(new Headers(h.calls[0]?.init.headers).get("content-type")).toBe(
          "application/octet-stream",
        );
        expect(new Uint8Array(h.calls[0]?.init.body as ArrayBuffer)).toEqual(reference.pcm);
        expect(h.calls[0]?.init.credentials).toBe(authorization === null ? "include" : undefined);
        expect(new Headers(h.calls[0]?.init.headers).get("authorization")).toBe(
          authorization === null ? null : "Bearer muse-media-token",
        );
      }),
  );

  it.effect("signs the exact POST destination and language for relay access", () =>
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
      const h = harness(
        () =>
          new Response(JSON.stringify(transcript), {
            headers: { "content-type": "application/json" },
          }),
      );
      const result = yield* transcribeEnvironmentMuseAudio({
        prepared: {
          ...prepared,
          httpAuthorization: {
            _tag: "Dpop",
            accessToken: "media-access",
            expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
          },
        },
        recording: reference,
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
      expect(result).toEqual(transcript);
      expect(proofs).toHaveLength(1);
      expect(proofs[0]).toMatchObject({
        method: "POST",
        url: expectedUrl,
        accessToken: "media-access",
      });
      expect(new Headers(h.calls[0]?.init.headers).get("dpop")).toBe("media-proof");
    }),
  );

  it.effect("preserves a declared no-speech error without retrying the recording", () =>
    Effect.gen(function* () {
      const h = harness(
        () =>
          new Response(
            JSON.stringify({ _tag: "MuseAgentDictationRequestError", code: "no_speech" }),
            { status: 422, headers: { "content-type": "application/json" } },
          ),
      );
      const error = yield* transcribeEnvironmentMuseAudio({
        prepared,
        recording: reference,
        signer: Option.none(),
      }).pipe(Effect.provide(h.layer), Effect.flip);
      expect(error._tag).toBe("MuseAgentDictationRequestError");
      expect(h.calls).toHaveLength(1);
    }),
  );
});
