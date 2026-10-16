import { expect, it } from "@effect/vitest";
import { isProviderTextGenerationCapable } from "@t3tools/contracts";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";
import * as Native from "../../museAgent/MuseAgentNativeRuntimeService.ts";
import * as ToolsPort from "../../museAgent/MuseAgentDirectToolsPort.ts";
import {
  binding,
  host,
  makeNative,
  options,
} from "../../orchestration-v2/Adapters/MuseAgentAdapterV2.testkit.ts";
import { MuseAgentDriver } from "./MuseAgentDriver.ts";

it.effect.each([
  { state: "ready", enabled: true, accountBinding: binding },
  { state: "disabled", enabled: false, accountBinding: binding },
  { state: "unbound", enabled: true, accountBinding: null },
  { state: "account mismatch", enabled: true, accountBinding: "f".repeat(64) },
])("excludes $state Muse from application text generation", ({ state, enabled, accountBinding }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const instance = yield* MuseAgentDriver.create({
        ...options,
        enabled,
        config: { accountBinding },
      });
      const snapshot = yield* instance.snapshot.getSnapshot;
      expect(snapshot.supportsTextGeneration).toBe(false);
      expect(isProviderTextGenerationCapable(snapshot)).toBe(false);
      expect([snapshot].filter(isProviderTextGenerationCapable)).toEqual([]);
      yield* instance.snapshot.refresh;
      const refreshed = yield* instance.snapshot.getSnapshot;
      expect(isProviderTextGenerationCapable(refreshed)).toBe(false);
      if (state === "ready") {
        expect(snapshot.status).toBe("ready");
        expect(snapshot.models.map((model) => model.slug)).toEqual(["muse"]);
      }
    }),
  ).pipe(
    Effect.provideService(ProviderHost.ProviderHost, host),
    Effect.provideService(Native.MuseAgentNativeRuntimeService, makeNative()),
    Effect.provideService(
      ToolsPort.MuseAgentDirectToolsPort,
      ToolsPort.MuseAgentDirectToolsPort.of({
        install: () => Effect.succeed({ uninstall: Effect.void }),
        start: () => Effect.succeed({ revoke: Effect.void, close: Effect.void }),
      }),
    ),
  ),
);
