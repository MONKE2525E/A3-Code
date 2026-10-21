import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as Authorization from "../authorization/service.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { prepareMuseAgentComputerStream } from "./museAgentComputerStream.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("computer-stream-environment"),
  label: "Computer environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  target,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws?wsTicket=already-consumed-rpc-ticket",
  httpAuthorization: null,
};
const reference = {
  providerInstanceId: ProviderInstanceId.make("muse-agent-test"),
  sessionId: "native session",
  taskId: "browser-task:one",
  takeoverId: "owned takeover",
};
const suffix =
  "/api/ai-agents/muse/muse-agent-test/computer/native%20session/browser-task%3Aone/stream?takeoverId=owned+takeover&wsTicket=fresh-viewer-ticket";

function harness() {
  const calls: { url: string; init: RequestInit }[] = [];
  const layer = RpcHttp.layerRemoteHttpClient(async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    return Response.json({ ticket: "fresh-viewer-ticket", expiresAt: "2030-01-01T00:00:00.000Z" });
  });
  return { calls, layer };
}

describe("Muse computer stream authorization", () => {
  it.effect.each([
    { name: "cookie", authorization: null },
    { name: "bearer", authorization: { _tag: "Bearer" as const, token: "test-access" } },
  ])("issues a distinct viewer ticket with $name authentication", ({ authorization }) =>
    Effect.gen(function* () {
      const h = harness();
      const result = yield* prepareMuseAgentComputerStream({
        prepared: { ...prepared, httpAuthorization: authorization },
        reference,
        signer: Option.none(),
      }).pipe(Effect.provide(h.layer));
      expect(result.socketUrl).toBe(`wss://environment.example.test${suffix}`);
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]?.url).toBe("https://environment.example.test/api/auth/websocket-ticket");
      expect(h.calls[0]?.init.method).toBe("POST");
      expect(h.calls[0]?.init.credentials).toBe(authorization === null ? "include" : undefined);
      expect(new Headers(h.calls[0]?.init.headers).get("authorization")).toBe(
        authorization === null ? null : "Bearer test-access",
      );
      expect(result.socketUrl).not.toContain("already-consumed");
      expect(result.socketUrl).not.toContain("test-access");
    }),
  );

  it.effect("signs ticket issuance and follows the refreshed relay origin", () =>
    Effect.gen(function* () {
      const h = harness();
      const proofs: ManagedRelay.ManagedRelayDpopProofInput[] = [];
      const signer = ManagedRelay.ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("test-key"),
        createProof: (input) =>
          Effect.sync(() => {
            proofs.push(input);
            return "test-proof";
          }),
      });
      const result = yield* prepareMuseAgentComputerStream({
        prepared: {
          ...prepared,
          target: new RelayConnectionTarget({
            environmentId: target.environmentId,
            label: target.label,
          }),
          httpAuthorization: { _tag: "Dpop", accessToken: "old-token", expiresAtEpochMs: 0 },
        },
        reference,
        signer: Option.some(signer),
        remoteAuthorization: Option.some(
          Authorization.RemoteEnvironmentAuthorization.of({
            authorizeBearer: () => Effect.die("Unexpected bearer request"),
            authorizeDpop: () => Effect.die("Unexpected RPC connection request"),
            authorizeDpopHttp: () =>
              Effect.succeed({
                environmentId: target.environmentId,
                label: target.label,
                httpBaseUrl: "https://renewed.example.test",
                httpAuthorization: {
                  _tag: "Dpop" as const,
                  accessToken: "renewed-token",
                  expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
                },
              }),
          }),
        ),
      }).pipe(Effect.provide(h.layer));
      expect(result.socketUrl).toBe(`wss://renewed.example.test${suffix}`);
      expect(proofs).toEqual([
        {
          method: "POST",
          url: "https://renewed.example.test/api/auth/websocket-ticket",
          accessToken: "renewed-token",
        },
      ]);
      expect(new Headers(h.calls[0]?.init.headers).get("dpop")).toBe("test-proof");
    }),
  );
});
