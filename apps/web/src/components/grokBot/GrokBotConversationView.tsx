import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  GrokBotConversation,
  splitGrokBotAgentStamp,
  type EnvironmentId,
  type GrokBot,
  type GrokBotWorkflowReferences,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon, InfoIcon, SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { ComposerSurface } from "~/components/chat/ComposerSurface";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  grokBotsListQuery,
  grokBotsReadQuery,
  grokBotsSend,
  refreshGrokBotConversation,
} from "~/state/grokBots";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";

import { GrokBotAvatar } from "./GrokBotAvatar";
import { GROK_BOT_AVATAR_COLORS } from "./grokBotAvatarShapes";
import {
  GROK_BOT_SETTLE_LINGER_MS,
  getGrokBotActivity,
  setGrokBotActivity,
  useGrokBotActivity,
} from "./grokBotActivity";
import {
  grokBotErrorReason,
  grokBotUserMessageIds,
  groupGrokBotPeerCounts,
  groupGrokBotTimeline,
  isGrokBotReactionReplyToSend,
  isGrokBotSendDelivered,
  isGrokBotTextReplyAfterSend,
  type GrokBotPeer,
  type GrokBotSentMessage,
  type GrokBotTimelineItem,
} from "./grokBotConversation";
import { GrokBotLimitations } from "./GrokBotLimitations";
import { GrokBotVoiceCallMarkerLabel } from "./GrokBotVoiceCallMarkerLabel";
import { isNativeConnectorAuthLink } from "./grokBotConnectorAuthLink";
import { GrokBotConnectorAuthAction } from "./GrokBotConnectorAuthAction";
import { GrokBotProfileEditor } from "./GrokBotProfileEditor";
import { GrokBotReactions } from "./GrokBotReactions";
import { GrokBotWorkflowReferenceChips } from "./GrokBotWorkflowReferenceChips";
import {
  grokBotFailureMessage,
  grokBotSettingsDestinationSearch,
  grokBotSurfaceKey,
  resolveGrokBotAvatarColor,
} from "./grokBotPresentation";

/** Longest a sent message waits on the bot before it goes back to rest. */
const THINKING_TIMEOUT_MS = 90_000;

type GrokBotMessages = (typeof GrokBotConversation.Type)["messages"];
type GrokBotMessage = GrokBotMessages[number];

/** An accepted send shown in the list until the polled transcript contains it. */
interface OutgoingMessage extends GrokBotSentMessage {
  readonly id: number;
  readonly surfaceKey: string;
}

type SendOutcome =
  | { readonly status: "accepted" }
  | { readonly status: "uncertain" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly message: string };

/** `readOnly` shows the transcript without a composer, for legacy history that must not receive sends. */
export function GrokBotConversationView({
  environmentId,
  botId,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly readOnly?: boolean;
}) {
  const conversation = useEnvironmentQuery(grokBotsReadQuery({ environmentId, input: { botId } }));
  const [profileOpen, setProfileOpen] = useState(false);
  const bot = conversation.data?.bot ?? null;
  const messages = conversation.data?.messages ?? [];
  const surfaceKey = grokBotSurfaceKey(environmentId, botId);
  const loading = conversation.isPending && conversation.data === null;
  const streaming = messages.at(-1)?.streaming === true;
  const wasStreaming = useRef(false);
  const lastMessage = messages.at(-1);
  const lastMessageId = lastMessage?.id;
  const [outgoing, setOutgoing] = useState<readonly OutgoingMessage[]>([]);
  const outgoingSequence = useRef(0);
  const sendMessage = useAtomCommand(grokBotsSend, { reportFailure: false });
  /**
   * Set while a send waits for its reply; cleared when a settled text reply follows the send, a
   * bot reaction lands on the send's message, or the send fails.
   */
  const replyAwaiting = useRef<{
    readonly sent: GrokBotSentMessage;
    readonly afterMessageId: string | undefined;
  } | null>(null);

  // Opening a chat re-reads it and the roster right away, so a profile edit made elsewhere
  // shows here without waiting for the poll.
  useEffect(() => {
    refreshGrokBotConversation(appAtomRegistry, environmentId, botId);
  }, [botId, environmentId]);

  // The bot rests unless something is happening, so each phase of a chat sets
  // the activity the avatar plays; one-shot reactions clear themselves.
  useEffect(() => {
    if (loading) setGrokBotActivity(surfaceKey, "loading");
    else if (getGrokBotActivity(surfaceKey) === "loading") setGrokBotActivity(surfaceKey, null);
  }, [loading, surfaceKey]);
  useEffect(() => {
    if (streaming) {
      setGrokBotActivity(surfaceKey, "streaming");
    } else if (wasStreaming.current) {
      setGrokBotActivity(surfaceKey, "finished", GROK_BOT_SETTLE_LINGER_MS);
    }
    wasStreaming.current = streaming;
  }, [streaming, surfaceKey]);
  // A reply answers the send when a settled text message arrived after it, or when the bot
  // reacted to the message the send produced. Rows from before the send do not count, and neither
  // does a reaction on any other message. A standalone reaction after the reply does not hide it.
  useEffect(() => {
    const awaiting = replyAwaiting.current;
    if (
      awaiting !== null &&
      (isGrokBotTextReplyAfterSend({
        afterMessageId: awaiting.afterMessageId,
        botId,
        messages,
      }) ||
        isGrokBotReactionReplyToSend({ sent: awaiting.sent, messages }))
    ) {
      replyAwaiting.current = null;
      setGrokBotActivity(surfaceKey, "finished", GROK_BOT_SETTLE_LINGER_MS);
    }
  }, [botId, messages, surfaceKey]);
  // Leaving the chat ends what only this view could observe; a pending
  // "thinking" survives so the sidebar keeps showing the bot at work.
  useEffect(
    () => () => {
      const current = getGrokBotActivity(surfaceKey);
      if (current === "loading" || current === "streaming") setGrokBotActivity(surfaceKey, null);
    },
    [surfaceKey],
  );

  const send = async (sent: GrokBotSentMessage): Promise<SendOutcome> => {
    const id = ++outgoingSequence.current;
    setOutgoing((items) => [...items, { ...sent, id, surfaceKey }]);
    setGrokBotActivity(surfaceKey, "sending");
    replyAwaiting.current = { sent, afterMessageId: lastMessageId };
    const result = await sendMessage({
      environmentId,
      input: { botId, message: sent.text },
    });
    if (result._tag === "Success") {
      // A fast reply may already have settled the wait; then "thinking" would be stale.
      if (replyAwaiting.current !== null) {
        setGrokBotActivity(surfaceKey, "thinking", THINKING_TIMEOUT_MS);
      }
      return { status: "accepted" };
    }
    replyAwaiting.current = null;
    setOutgoing((items) => items.filter((item) => item.id !== id));
    if (isAtomCommandInterrupted(result)) {
      setGrokBotActivity(surfaceKey, null);
      return { status: "cancelled" };
    }
    const error = squashAtomCommandFailure(result);
    // The send may have landed, so the composer keeps the draft and the transcript decides.
    if (grokBotErrorReason(error) === "delivery_unknown") {
      setGrokBotActivity(surfaceKey, null);
      return { status: "uncertain" };
    }
    setGrokBotActivity(surfaceKey, "failed", GROK_BOT_SETTLE_LINGER_MS);
    return { status: "failed", message: grokBotFailureMessage(error) };
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner size="lg" tone="muted" />
      </div>
    );
  }

  if (conversation.error && conversation.data === null) {
    return (
      <Empty size="hero">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SettingsIcon />
          </EmptyMedia>
          <EmptyTitle>Could not load this bot</EmptyTitle>
          <EmptyDescription>{conversation.error}</EmptyDescription>
        </EmptyHeader>
        <Button size="sm" variant="outline" onClick={() => conversation.refresh()}>
          Retry
        </Button>
      </Empty>
    );
  }

  if (bot === null) {
    return (
      <Empty size="hero">
        <EmptyHeader>
          <EmptyTitle>Bot not found</EmptyTitle>
          <EmptyDescription>This bot is no longer in your Grok Bot account.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const pending = outgoing.filter(
    (item) => item.surfaceKey === surfaceKey && !isGrokBotSendDelivered(messages, item),
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <GrokBotConversationHeader
          bot={bot}
          environmentId={environmentId}
          profileOpen={profileOpen}
          onToggleProfile={() => setProfileOpen((open) => !open)}
        />
        {conversation.error ? (
          <p className="px-4 py-2 text-sm text-destructive-foreground">{conversation.error}</p>
        ) : null}
        <GrokBotMessageList
          key={`messages:${surfaceKey}`}
          bot={bot}
          messages={messages}
          pending={pending}
          environmentId={environmentId}
        />
        {readOnly ? null : (
          <GrokBotComposer
            key={`composer:${surfaceKey}`}
            environmentId={environmentId}
            bot={bot}
            messages={messages}
            onSend={send}
          />
        )}
      </section>
      {profileOpen ? (
        <aside className="min-h-0 w-[22rem] shrink-0 overflow-y-auto border-l border-border/60 px-4 py-5 max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-20 max-lg:bg-background">
          <GrokBotProfileEditor
            key={`profile:${surfaceKey}`}
            environmentId={environmentId}
            bot={bot}
          />
          <GrokBotLimitations className="mt-6" />
        </aside>
      ) : null}
    </div>
  );
}

function GrokBotConversationHeader({
  bot,
  environmentId,
  profileOpen,
  onToggleProfile,
}: {
  readonly bot: GrokBot;
  readonly environmentId: EnvironmentId;
  readonly profileOpen: boolean;
  readonly onToggleProfile: () => void;
}) {
  const navigate = useNavigate();
  const activity = useGrokBotActivity(grokBotSurfaceKey(environmentId, bot.id));
  return (
    <header className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 border-b border-border/50 px-4">
      <GrokBotAvatar bot={bot} size="sm" featured={bot.featured} state={activity} />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-sm font-medium">{bot.name}</h1>
        {bot.label.trim().length > 0 ? (
          <p className="truncate text-xs text-muted-foreground">{bot.label}</p>
        ) : null}
      </div>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Bot settings"
        onClick={() =>
          void navigate({
            to: "/settings/providers",
            search: grokBotSettingsDestinationSearch({
              environmentId,
              botId: bot.id,
            }),
            hash: "grok-bots-editor",
          })
        }
      >
        <SettingsIcon />
      </Button>
      <Button
        size="icon-xs"
        variant={profileOpen ? "ghost" : "ghost-muted"}
        aria-pressed={profileOpen}
        aria-label={profileOpen ? "Hide bot details" : "Show bot details"}
        onClick={onToggleProfile}
      >
        <InfoIcon />
      </Button>
    </header>
  );
}

function GrokBotMessageList({
  bot,
  messages,
  pending,
  environmentId,
}: {
  readonly bot: GrokBot;
  readonly messages: GrokBotMessages;
  readonly pending: readonly OutgoingMessage[];
  readonly environmentId: EnvironmentId;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const roster = useEnvironmentQuery(grokBotsListQuery({ environmentId, input: {} })).data ?? [];
  const timeline = useMemo(() => groupGrokBotTimeline(messages, bot.id), [messages, bot.id]);
  const peerCounts = useMemo(() => groupGrokBotPeerCounts(messages, bot.id), [messages, bot.id]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.at(-1)?.id, messages.at(-1)?.text, messages.at(-1)?.streaming, pending.length]);

  if (messages.length === 0 && pending.length === 0) {
    return (
      <Empty className="flex-1" size="default">
        <EmptyHeader>
          <GrokBotAvatar bot={bot} size="lg" />
          <EmptyTitle>Message {bot.name}</EmptyTitle>
          <EmptyDescription>
            {bot.description.trim() || "Chats stay with this bot. Start a message below."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1" scrollFade>
      <ol className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-6 px-4 py-6">
        {peerCounts.length > 0 ? (
          <li className="flex flex-wrap gap-2">
            {peerCounts.map((peer) => (
              <GrokBotPeerChip
                key={peer.key}
                peer={peer.peer}
                count={peer.count}
                environmentId={environmentId}
              />
            ))}
          </li>
        ) : null}
        {timeline.map((item, index) => {
          if (item.kind === "peer") {
            return (
              <GrokBotPeerGroup
                key={`peer:${item.messages[0]?.id}`}
                item={item}
                roster={roster}
                environmentId={environmentId}
              />
            );
          }
          const { message } = item;
          if (message.voiceCall !== undefined) {
            return <GrokBotVoiceCallRow key={message.id} marker={message.voiceCall} />;
          }
          // Reaction-only entries are the fallback for a reaction whose target is not in the
          // transcript; a reaction on a message in view is shown as a pill on that message.
          if (message.reactionOnly) {
            return (
              <li
                key={message.id}
                className={cn(
                  "flex",
                  message.sender.kind === "user" ? "justify-end" : "justify-start",
                )}
              >
                <GrokBotReactions reactions={message.reactions} />
              </li>
            );
          }
          if (message.sender.kind === "user") {
            const stamp = splitGrokBotAgentStamp(message.text);
            return (
              <li key={message.id} className="flex flex-col items-end gap-1">
                {stamp.fromAgent ? (
                  <p
                    className="me-1 text-2xs text-muted-foreground/70"
                    data-user-message-attribution="agent"
                  >
                    Sent by another agent
                  </p>
                ) : null}
                <GrokBotUserBubble
                  text={stamp.text}
                  references={message.grokBotWorkflowReferences}
                />
                <GrokBotReactions reactions={message.reactions} />
              </li>
            );
          }
          const previous = timeline[index - 1];
          const continuesBot =
            previous?.kind === "message" &&
            previous.message.sender.kind !== "user" &&
            previous.message.voiceCall === undefined &&
            previous.message.reactionOnly !== true;
          return (
            <li key={message.id} className="flex min-w-0 gap-3">
              {continuesBot ? (
                <span className="w-6 shrink-0" />
              ) : (
                <GrokBotAvatar
                  bot={bot}
                  size="xs"
                  state={message.streaming ? "streaming" : undefined}
                  className="mt-0.5"
                />
              )}
              <div className="min-w-0 flex-1">
                <GrokBotMessageBody message={message} environmentId={environmentId} />
              </div>
            </li>
          );
        })}
        {pending.map((item) => (
          <li key={`pending:${item.id}`} className="flex justify-end opacity-70">
            <GrokBotUserBubble text={item.text} />
          </li>
        ))}
        <div ref={endRef} />
      </ol>
    </ScrollArea>
  );
}

/** A voice call in the transcript: one quiet line, with its duration only when native recorded one. */
function GrokBotVoiceCallRow({
  marker,
}: {
  readonly marker: NonNullable<GrokBotMessage["voiceCall"]>;
}) {
  return (
    <li
      className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground"
      data-voice-call-id={marker.callId}
    >
      <GrokBotVoiceCallMarkerLabel marker={marker} />
    </li>
  );
}

function GrokBotMessageBody({
  message,
  environmentId,
}: {
  readonly message: GrokBotMessage;
  readonly environmentId: EnvironmentId;
}) {
  return (
    <>
      <ChatMarkdown
        text={message.text}
        cwd={undefined}
        environmentId={environmentId}
        isStreaming={message.streaming}
        renderLinkOverride={({ href }) =>
          message.sender.kind !== "user" && isNativeConnectorAuthLink(href) ? (
            <GrokBotConnectorAuthAction environmentId={environmentId} />
          ) : undefined
        }
      />
      <GrokBotReactions reactions={message.reactions} className="mt-1" />
    </>
  );
}

/** Messages exchanged with another bot, under one header per run from the same peer. */
function GrokBotPeerGroup({
  item,
  roster,
  environmentId,
}: {
  readonly item: Extract<GrokBotTimelineItem, { kind: "peer" }>;
  readonly roster: readonly GrokBot[];
  readonly environmentId: EnvironmentId;
}) {
  const name = peerName(item.peer);
  const avatar = peerAvatar(item.peer, roster);
  const tint = `color-mix(in srgb, ${GROK_BOT_AVATAR_COLORS[resolveGrokBotAvatarColor(avatar.avatarColor, avatar.id)]} 14%, transparent)`;
  return (
    <li className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <GrokBotAvatar bot={avatar} size="xs" />
        <span className="truncate">
          {item.direction === "from" ? `Message from ${name}` : `Message to ${name}`}
        </span>
      </div>
      {item.messages.map((message) => (
        <div
          key={message.id}
          className="ml-8 min-w-0 max-w-[80%] rounded-2xl p-3"
          style={{ backgroundColor: tint }}
        >
          <GrokBotMessageBody message={message} environmentId={environmentId} />
        </div>
      ))}
    </li>
  );
}

/** Summarizes the bot-to-bot messages with one peer; a bot peer opens its own conversation. */
function GrokBotPeerChip({
  peer,
  count,
  environmentId,
}: {
  readonly peer: GrokBotPeer;
  readonly count: number;
  readonly environmentId: EnvironmentId;
}) {
  const navigate = useNavigate();
  const label = `${count} ${count === 1 ? "message" : "messages"} with ${peerName(peer)}`;
  if (peer.kind === "unknown") {
    return <span className="px-2 py-1 text-xs text-muted-foreground">{label}</span>;
  }
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={() =>
        void navigate({
          to: "/grok-bots/$botId",
          params: { botId: peer.id },
          search: { environmentId },
        })
      }
    >
      {label}
    </Button>
  );
}

function peerName(peer: GrokBotPeer): string {
  return peer.kind === "bot" ? peer.name : peer.label;
}

/** A peer missing from the roster keeps its wire name, and its avatar follows that name. */
function peerAvatar(
  peer: GrokBotPeer,
  roster: readonly GrokBot[],
): Pick<GrokBot, "id" | "name" | "avatarShape" | "avatarColor"> {
  const known = peer.kind === "bot" ? roster.find((bot) => bot.id === peer.id) : undefined;
  if (known !== undefined) return known;
  const name = peerName(peer);
  return { id: name, name, avatarShape: "", avatarColor: "" };
}

function GrokBotUserBubble({
  text,
  references,
}: {
  readonly text: string;
  readonly references?: GrokBotWorkflowReferences | undefined;
}) {
  return (
    <div className="max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
      {references ? <GrokBotWorkflowReferenceChips references={references} /> : null}
      <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{text}</p>
    </div>
  );
}

function GrokBotComposer({
  environmentId,
  bot,
  messages,
  onSend,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: GrokBot;
  readonly messages: GrokBotMessages;
  readonly onSend: (sent: GrokBotSentMessage) => Promise<SendOutcome>;
}) {
  const canSend = useAtomValue(grokBotsSend.permissionAtom(environmentId));
  const identity = grokBotSurfaceKey(environmentId, bot.id);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState<GrokBotSentMessage | null>(null);
  const disabled = !canSend || sending;

  // An uncertain send resolves when the transcript shows it; until then the draft waits for the user.
  useEffect(() => {
    if (uncertain === null || !isGrokBotSendDelivered(messages, uncertain)) return;
    setUncertain(null);
    setDraft((current) => (current.trim() === uncertain.text ? "" : current));
    setGrokBotActivity(identity, "thinking", THINKING_TIMEOUT_MS);
  }, [identity, messages, uncertain]);

  const submit = async () => {
    const message = draft.trim();
    if (message.length === 0 || disabled) return;
    setSending(true);
    setError(null);
    setUncertain(null);
    const sent = { text: message, baselineUserIds: grokBotUserMessageIds(messages) };
    const outcome = await onSend(sent);
    setSending(false);
    switch (outcome.status) {
      case "accepted":
        setDraft("");
        return;
      case "uncertain":
        setUncertain(sent);
        return;
      case "failed":
        setError(outcome.message);
        return;
      case "cancelled":
        return;
    }
  };

  return (
    <form
      className="px-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div className="rounded-3xl">
              <label className="sr-only" htmlFor={`grok-bot-composer-${identity}`}>
                Message {bot.name}
              </label>
              <textarea
                id={`grok-bot-composer-${identity}`}
                rows={2}
                value={draft}
                disabled={disabled}
                maxLength={64000}
                placeholder={`Message ${bot.name}`}
                aria-busy={sending}
                className="block max-h-52 min-h-14 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-sm outline-none placeholder:text-placeholder disabled:opacity-64"
                onChange={(event) => setDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
              <div className="flex items-center justify-end gap-2 px-3 pb-3">
                {error ? (
                  <p className="min-w-0 flex-1 truncate text-xs text-destructive-foreground">
                    {error}
                  </p>
                ) : null}
                {uncertain ? (
                  <p
                    role="status"
                    className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                  >
                    Delivery is uncertain. Checking the conversation...
                  </p>
                ) : null}
                <button
                  type="submit"
                  aria-label="Send message"
                  disabled={disabled || draft.trim().length === 0}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover disabled:opacity-30"
                >
                  {sending ? <Spinner size="xs" /> : <ArrowUpIcon className="size-4" />}
                </button>
              </div>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
      <div aria-hidden className="h-4" />
    </form>
  );
}
