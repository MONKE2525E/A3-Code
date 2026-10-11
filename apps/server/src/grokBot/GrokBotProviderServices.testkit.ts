import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as GrokBotManagedBinding from "../orchestration-v2/Adapters/GrokBotManagedBinding.ts";
import * as GrokBotNativeRuntimeService from "./GrokBotNativeRuntimeService.ts";
import * as GrokBotNativeService from "./GrokBotNativeService.ts";

const signedOut = Effect.fail(new GrokBotNativeService.NativeSignedOutError({}));

/** Registry tests supply every built-in driver's dependencies without opening a native account. */
export const layer = Layer.merge(
  GrokBotManagedBinding.blockedLayer,
  Layer.succeed(
    GrokBotNativeRuntimeService.GrokBotNativeRuntimeService,
    GrokBotNativeRuntimeService.GrokBotNativeRuntimeService.of({
      accountBinding: signedOut,
      accountInfo: () => signedOut,
      usageLimits: () => signedOut,
      roster: () => signedOut,
      sessionContext: () => signedOut,
      tasks: () => signedOut,
      startTurn: () => signedOut,
      receiveAttachments: () => Effect.die("Received attachments must be provided by the fixture."),
      uploadAttachments: () => Effect.die("Signed-out providers cannot upload attachments."),
      sendStatus: () => signedOut,
      interrupt: () => signedOut,
      resolveAutoReviewApproval: () => signedOut,
      resolveLocalToolPermission: () => signedOut,
      resolveConnectorGrant: () => signedOut,
      respondToWidget: () => signedOut,
      dismissWidget: () => signedOut,
      submitSecret: () => signedOut,
      secretRequests: () => signedOut,
      recreateComputer: () => signedOut,
      resetComputer: () => signedOut,
      computerUpgradeSchedule: () => signedOut,
      openSettlementWatch: () => signedOut,
      settlementSnapshot: () => signedOut,
      watchSettlements: () => Stream.fail(new GrokBotNativeService.NativeSignedOutError({})),
      watch: () => Stream.fail(new GrokBotNativeService.NativeSignedOutError({})),
      plugins: () => signedOut,
      upsertPlugin: () => signedOut,
      restorePlugin: () => signedOut,
      ensureSkill: () => signedOut,
    }),
  ),
);
