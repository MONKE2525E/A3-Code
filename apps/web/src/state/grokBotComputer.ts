import * as Effect from "effect/Effect";
import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";

// The viewer grants native pointer/keyboard control, so even its read uses the command guard.
const readComputer = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "grok-bot:computer-read",
  tag: WS_METHODS.grokBotsComputerRead,
});
export const grokBotComputerQuery = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:grok-bot:computer",
  execute: Effect.fn("GrokBotComputer.read")(function* (input: { readonly botId: string }) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const registry = yield* AtomRegistry.AtomRegistry;
    const result = yield* Effect.promise(() =>
      readComputer.run(registry, { environmentId: supervisor.target.environmentId, input }),
    );
    if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
    return result.value;
  }),
  staleTimeMs: 5_000,
  refreshIntervalMs: 5_000,
  idleTtlMs: 0,
});
export const grokBotComputerStart = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "grok-bot:computer-start",
  tag: WS_METHODS.grokBotsComputerStart,
  onSuccess: (target, registry) =>
    Effect.sync(() => registry.refresh(grokBotComputerQuery(target))),
});

/**
 * Replaces the account's computer, so every bot on the account is affected. The server
 * authorizes it again and requires `confirm: true`; callers must confirm with the user first.
 */
export const grokBotComputerRecreate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "grok-bot:computer-recreate",
  tag: WS_METHODS.grokBotsComputerRecreate,
  onSuccess: (target, registry) =>
    Effect.sync(() =>
      registry.refresh(
        grokBotComputerUpgradeScheduleQuery({
          environmentId: target.environmentId,
          input: {},
        }),
      ),
    ),
});
/** Account-wide read of the computer's scheduled upgrade; it has no per-bot scope. */
export const grokBotComputerUpgradeScheduleQuery = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:grok-bot:upgrade-schedule",
    tag: WS_METHODS.grokBotsComputerUpgradeSchedule,
    staleTimeMs: 30_000,
    idleTtlMs: 5 * 60_000,
  },
);

const readTeaching = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "grok-bot:teach-read",
  tag: WS_METHODS.grokBotsTeachRead,
});
export const grokBotTeachQuery = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:grok-bot:teach",
  execute: Effect.fn("GrokBotTeach.read")(function* (input: { readonly botId: string }) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const registry = yield* AtomRegistry.AtomRegistry;
    const result = yield* Effect.promise(() =>
      readTeaching.run(registry, { environmentId: supervisor.target.environmentId, input }),
    );
    if (result._tag === "Failure") return yield* Effect.failCause(result.cause);
    return result.value;
  }),
  staleTimeMs: 2_000,
  refreshIntervalMs: 2_000,
  idleTtlMs: 0,
});
export const grokBotTeachStart = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "grok-bot:teach-start",
  tag: WS_METHODS.grokBotsTeachStart,
  onSuccess: (target, registry) =>
    Effect.sync(() =>
      registry.refresh(
        grokBotTeachQuery({
          environmentId: target.environmentId,
          input: { botId: target.input.botId },
        }),
      ),
    ),
});
export const grokBotTeachStop = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "grok-bot:teach-stop",
  tag: WS_METHODS.grokBotsTeachStop,
  onSuccess: (target, registry) =>
    Effect.sync(() =>
      registry.refresh(
        grokBotTeachQuery({
          environmentId: target.environmentId,
          input: { botId: target.input.botId },
        }),
      ),
    ),
});

/**
 * Restores the account's computer from its last saved snapshot (native ForceRecreateSandBox).
 * Changes since that snapshot are lost and every bot on the account is affected; callers must
 * confirm with the user first.
 */
export const grokBotComputerReset = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "grok-bot:computer-reset",
  tag: WS_METHODS.grokBotsComputerReset,
  onSuccess: (target, registry) =>
    Effect.sync(() =>
      registry.refresh(
        grokBotComputerUpgradeScheduleQuery({
          environmentId: target.environmentId,
          input: {},
        }),
      ),
    ),
});
