import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2TurnItemJson,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** T3 identities saved before native admission; no prompt or native account data. */
export const MuseAgentDeliveryContext = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  runId: RunId,
  nodeId: NodeId,
  providerThreadId: ProviderThreadId,
  providerTurnId: ProviderTurnId,
  userMessageId: MessageId,
});
export type MuseAgentDeliveryContext = typeof MuseAgentDeliveryContext.Type;

export const MuseAgentManagedMessageSnapshot = Schema.Struct({
  message: OrchestrationV2ConversationMessageJson,
  turnItem: OrchestrationV2TurnItemJson,
});
export type MuseAgentManagedMessageSnapshot = typeof MuseAgentManagedMessageSnapshot.Type;

export interface MuseAgentHistoryOwnership {
  readonly receipts: readonly {
    readonly messageId: string;
    readonly replyToMessageId: string;
    readonly context: MuseAgentDeliveryContext;
  }[];
  readonly messages: readonly {
    readonly nativeMessageId: string;
    readonly deliveryKey: string;
    readonly context: MuseAgentDeliveryContext;
    readonly snapshot: MuseAgentManagedMessageSnapshot;
    readonly frozen: boolean;
  }[];
}

export interface MuseAgentPendingDelivery {
  readonly deliveryKey: string;
  readonly status: "intent" | "accepted";
  readonly context: MuseAgentDeliveryContext | null;
}

export interface MuseAgentAccountPendingDelivery extends MuseAgentPendingDelivery {
  readonly sessionId: string;
}

export interface MuseAgentDeliveryScope {
  readonly binding: string;
  readonly sessionId: string;
}

export interface MuseAgentHistoryOwnershipScope extends MuseAgentDeliveryScope {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}
