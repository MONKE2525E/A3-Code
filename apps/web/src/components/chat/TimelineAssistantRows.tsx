import { UserVideoAttachment } from "./TimelineUserMessageRow";
import { museOptionWidgetText } from "~/lib/museOptionWidgetText";
import { MuseAgentOptionWidgets } from "../agents/MuseAgentOptionWidgets";
import { GrokBotPeerMessageLink } from "../grokBot/GrokBotPeerMessageLink";
import { GrokBotVoiceCallMarkerLabel } from "../grokBot/GrokBotVoiceCallMarkerLabel";
import { GrokBotWorkflowReferenceChips } from "../grokBot/GrokBotWorkflowReferenceChips";
import { isNativeAgentBackingThread } from "@t3tools/contracts";
import { selectMessageImageResources } from "../../session-logic";
import {
  type ChatAttachment,
  isFileAttachment,
  isImageAttachment,
  isVideoAttachment,
} from "../../types";
import { DownloadIcon, EyeIcon } from "lucide-react";
import { useAssetUrls } from "../../assets/assetUrls";
import { buildExpandedImagePreview } from "./ExpandedImagePreview";
import {
  SNAP_SHOT_ATTACHMENT_FRAME_CLASS,
  SnapShotAttachmentDetails,
} from "./SnapShotAttachmentDetails";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { GrokBotConnectorCardView } from "../grokBot/GrokBotConnectorCardView";
import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/markdownPipeline";
import { type RunId } from "@t3tools/contracts";
import { canForkProjectedAssistantItem } from "@t3tools/client-runtime/state/thread-workflows";
import { memo, use, useState } from "react";
import { type ChatMessage, type TurnDiffSummary } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { GitForkIcon } from "lucide-react";
import { Button } from "../ui/button";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { HtmlRenderFrame } from "./HtmlRenderFrame";
import { McpAppFrame } from "./McpAppFrame";
import { ChangedFilesCard } from "./ChangedFilesTree";
import { useFileContextMenuHandler } from "../../fileContextMenu";
import { useProject, useThreadShell } from "../../state/entities";
import { MessageCopyButton } from "./MessageCopyButton";
import { AssistantCitationSource } from "./AssistantCitationSource";
import { resolveAssistantMessageCopyState } from "./MessagesTimeline.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { useV2ItemSupport } from "../../state/v2ItemSupport";
import { TimelineRowCtx, TimelineRowActivityCtx, type TimelineRow } from "./timelineRowContext";
import { MESSAGE_HEADING_LEVEL, MessageAuthorHeading } from "./TimelineRowParts";

export function AssistantTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "message" }> }) {
  const ctx = use(TimelineRowCtx);
  if (row.message.grokBotVoiceCall !== undefined) {
    return (
      <div
        className="flex items-center justify-center gap-1.5 px-1 py-1 text-xs text-muted-foreground"
        data-voice-call-id={row.message.grokBotVoiceCall.callId}
      >
        <GrokBotVoiceCallMarkerLabel marker={row.message.grokBotVoiceCall} />
      </div>
    );
  }
  if (row.message.grokBotConnectorCard !== undefined) {
    return (
      <div className="min-w-0 px-1 py-1">
        <GrokBotConnectorCardView
          environmentId={ctx.activeThreadEnvironmentId}
          card={row.message.grokBotConnectorCard}
          settled={ctx.grokBotSettledConnectorCardIds.has(row.message.id)}
        />
      </div>
    );
  }
  const isNativeAgentChat =
    ctx.threadRef !== null && isNativeAgentBackingThread({ id: ctx.threadRef.threadId });
  const assistantAttachments = isNativeAgentChat ? row.message.attachments : undefined;
  const hasAssistantAttachments = (assistantAttachments?.length ?? 0) > 0;
  const musePresentation = ctx.threadRef?.threadId.startsWith("muse-agent:")
    ? museOptionWidgetText(row.message.text)
    : null;
  const hasMuseOptionWidget = (musePresentation?.widgetIds.length ?? 0) > 0;
  const visibleText = musePresentation?.text ?? row.message.text;
  const messageText =
    visibleText ||
    (row.message.streaming ||
    hasAssistantAttachments ||
    ctx.threadRef?.threadId.startsWith("muse-agent:")
      ? ""
      : "(empty response)");

  return (
    <>
      <div className="relative min-w-0 px-1 py-0.5">
        {row.message.grokBotPeer ? (
          <GrokBotPeerMessageLink
            environmentId={ctx.activeThreadEnvironmentId}
            peer={row.message.grokBotPeer}
          />
        ) : null}
        <MessageAuthorHeading>{row.message.grokBotAuthor?.name || "T3 Code"}</MessageAuthorHeading>
        {row.message.grokBotWorkflowReferences ? (
          <GrokBotWorkflowReferenceChips references={row.message.grokBotWorkflowReferences} />
        ) : null}
        <div data-thread-find-text="true">
          <AssistantCitationSource
            messageId={row.message.id}
            {...(ctx.threadRef ? { threadRef: ctx.threadRef } : {})}
            itemKey={row.id}
            request={ctx.citationRequest}
            listRef={ctx.listRef}
          >
            <ChatMarkdown
              text={messageText}
              cwd={ctx.markdownCwd}
              threadRef={ctx.threadRef ?? undefined}
              isStreaming={Boolean(row.message.streaming)}
              lineBreaks={shouldPreserveAssistantLineBreaks(messageText)}
              skills={ctx.skills}
              headingLevelOffset={MESSAGE_HEADING_LEVEL}
              onUseArtifactTemplate={ctx.onUseArtifactTemplate}
              onRunShellCommand={ctx.onRunShellCommand}
              onImageExpand={ctx.onImageExpand}
              renderLinkOverride={ctx.grokBotConnectorAuthLinkOverride ?? undefined}
            />
          </AssistantCitationSource>
        </div>
        {hasMuseOptionWidget && ctx.threadRef ? (
          <MuseAgentOptionWidgets
            threadRef={ctx.threadRef}
            messageId={row.message.id}
            isStreaming={Boolean(row.message.streaming)}
          />
        ) : null}
        {assistantAttachments && hasAssistantAttachments ? (
          <AssistantMessageAttachments attachments={assistantAttachments} />
        ) : null}
        {ctx.onOpenTurnDiff ? (
          <AssistantChangedFilesSection
            turnSummary={row.assistantTurnDiffSummary}
            routeThreadKey={ctx.routeThreadKey}
            resolvedTheme={ctx.resolvedTheme}
            onOpenTurnDiff={ctx.onOpenTurnDiff}
          />
        ) : null}
        {row.showAssistantMeta ? (
          <AssistantMessageMeta
            className="mt-1.5"
            projectedItem={row.projectedItem}
            message={row.message}
            showCopyButton={row.showAssistantCopyButton}
            copyStreaming={row.assistantCopyStreaming}
          />
        ) : null}
      </div>
    </>
  );
}

function AssistantForkButton({
  projectedItem,
}: {
  readonly projectedItem: NonNullable<Extract<TimelineRow, { kind: "message" }>["projectedItem"]>;
}) {
  const ctx = use(TimelineRowCtx);
  const [busy, setBusy] = useState(false);
  const support = useV2ItemSupport({
    environmentId: ctx.activeThreadEnvironmentId,
    sourceThreadId: projectedItem.sourceThreadId,
    sourceItemId: projectedItem.sourceItemId,
  });
  const canFork = canForkProjectedAssistantItem({
    projectedItem,
    capabilities: support.providerSession?.capabilities,
  });

  const onForkFromRun = ctx.onForkFromRun;
  if (!canFork || onForkFromRun === undefined || projectedItem.item.runId === null) return null;
  const runId = projectedItem.item.runId;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onForkFromRun({ sourceThreadId: projectedItem.sourceThreadId, runId }).finally(
                () => setBusy(false),
              );
            }}
            aria-label="Fork from this response"
          />
        }
      >
        <GitForkIcon className={cn("size-3", busy && "animate-pulse")} />
      </TooltipTrigger>
      <TooltipPopup side="top">Fork from this response</TooltipPopup>
    </Tooltip>
  );
}

export function AssistantMetaTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "assistant-meta" }>;
}) {
  return (
    <div className="px-1">
      <AssistantMessageMeta
        className="mt-0.5"
        projectedItem={row.projectedItem}
        message={row.message}
        showCopyButton={row.showAssistantCopyButton}
        copyStreaming={row.assistantCopyStreaming}
        alwaysVisible
      />
    </div>
  );
}

function AssistantMessageMeta({
  className,
  projectedItem,
  message,
  showCopyButton,
  copyStreaming,
  alwaysVisible = false,
}: {
  className?: string;
  projectedItem?: Extract<TimelineRow, { kind: "message" }>["projectedItem"];
  message: ChatMessage;
  showCopyButton: boolean;
  copyStreaming: boolean;
  alwaysVisible?: boolean;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs tabular-nums transition-opacity duration-200",
        alwaysVisible
          ? "opacity-100"
          : "opacity-0 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/assistant:opacity-100",
        className,
      )}
    >
      {projectedItem && projectedItem.item.status !== "completed" ? (
        <span className="rounded-full border border-border/70 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
          {projectedItem.item.status}
        </span>
      ) : null}
      <AssistantCopyButton
        message={message}
        showCopyButton={showCopyButton}
        streaming={copyStreaming}
      />
      {projectedItem?.item.type === "assistant_message" ? (
        <AssistantForkButton projectedItem={projectedItem} />
      ) : null}
      {!message.streaming && (
        <Tooltip>
          <TooltipTrigger render={<p className="text-muted-foreground text-xs tabular-nums" />}>
            {formatDayAwareTimestamp(message.updatedAt, ctx.timestampFormat)}
          </TooltipTrigger>
          <TooltipPopup>
            {formatChatTimestampTooltip(message.updatedAt, ctx.timestampFormat)}
          </TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

function AssistantCopyButton({
  message,
  showCopyButton,
  streaming,
}: {
  message: ChatMessage;
  showCopyButton: boolean;
  streaming: boolean;
}) {
  const assistantCopyState = resolveAssistantMessageCopyState({
    text: message.text ?? null,
    showCopyButton,
    streaming,
  });

  if (!assistantCopyState.visible) {
    return null;
  }

  return <MessageCopyButton text={assistantCopyState.text ?? ""} variant="ghost" />;
}

export function ProposedPlanTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "proposed-plan" }>;
}) {
  const ctx = use(TimelineRowCtx);

  return (
    <div className="min-w-0 px-1 py-0.5">
      <ProposedPlanCard
        planMarkdown={row.proposedPlan.planMarkdown}
        environmentId={ctx.activeThreadEnvironmentId}
        threadRef={ctx.threadRef ?? undefined}
        cwd={ctx.markdownCwd}
        workspaceRoot={ctx.workspaceRoot}
        findActive={ctx.findActive}
      />
    </div>
  );
}

export function HtmlRenderTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "html-render" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const { onAppFullscreenChange } = ctx;
  const onFullscreenChange = (fullscreen: boolean) => onAppFullscreenChange(row.id, fullscreen);

  if (ctx.renderHtmlRender) {
    return <div className="min-w-0 px-1">{ctx.renderHtmlRender(row)}</div>;
  }
  return (
    <div className="min-w-0 px-1">
      <HtmlRenderFrame
        key={row.htmlRender.attachmentId}
        environmentId={ctx.activeThreadEnvironmentId}
        htmlRender={row.htmlRender}
        threadRef={ctx.threadRef ?? undefined}
        onFullscreenChange={onFullscreenChange}
      />
    </div>
  );
}

export function McpAppTimelineRow({ row }: { row: Extract<TimelineRow, { kind: "mcp-app" }> }) {
  const ctx = use(TimelineRowCtx);
  const { awaitingUser } = use(TimelineRowActivityCtx);

  return (
    <div className="min-w-0 px-1">
      <McpAppFrame
        key={row.mcpApp.attachmentId}
        environmentId={ctx.activeThreadEnvironmentId}
        threadId={row.sourceThreadId}
        conversationThreadId={ctx.threadRef?.threadId ?? row.sourceThreadId}
        itemId={row.itemId}
        revision={row.revision}
        app={row.mcpApp}
        onSendMessage={ctx.onSendAppMessage}
        awaitingUser={awaitingUser}
        onFullscreenChange={(fullscreen) => ctx.onAppFullscreenChange(row.id, fullscreen)}
      />
    </div>
  );
}

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  displayThreadKey?: string;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  displayThreadKey?: string;
  onOpenTurnDiff: (runId: RunId, filePath?: string) => void;
}) {
  const ctx = use(TimelineRowCtx);
  const persistedExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.runId],
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const allDirectoriesExpanded = persistedExpanded ?? false;

  const thread = useThreadShell(ctx.threadRef);
  const activeProject = useProject(
    thread && thread.projectId
      ? { environmentId: thread.environmentId, projectId: thread.projectId }
      : null,
  );
  const onFileContextMenu = useFileContextMenuHandler(ctx.activeThreadEnvironmentId);

  return (
    <ChangedFilesCard
      runId={turnSummary.runId}
      files={checkpointFiles}
      allDirectoriesExpanded={allDirectoriesExpanded}
      resolvedTheme={resolvedTheme}
      onToggleAllDirectories={() =>
        setExpanded(routeThreadKey, turnSummary.runId, !allDirectoriesExpanded)
      }
      onOpenTurnDiff={onOpenTurnDiff}
      onFileContextMenu={(filePath, event) =>
        onFileContextMenu(
          {
            environmentId: ctx.activeThreadEnvironmentId,
            filePath,
            workspaceRoot: ctx.workspaceRoot,
            repositoryRoot:
              thread?.worktreePath == null
                ? activeProject?.repositoryIdentity?.rootPath
                : undefined,
          },
          event,
        )
      }
    />
  );
}

function AssistantMessageAttachments({
  attachments,
}: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
}) {
  const ctx = use(TimelineRowCtx);
  const resources = selectMessageImageResources(attachments);
  const previewUrls = useAssetUrls(ctx.activeThreadEnvironmentId, resources);
  const images = (() => {
    const urlsById = new Map(
      resources.flatMap((resource, index) => {
        const url = previewUrls[index];
        return url ? [[resource.attachmentId, url] as const] : [];
      }),
    );
    return attachments.filter(isImageAttachment).map((image) => {
      const previewUrl = urlsById.get(image.id) ?? image.previewUrl;
      return previewUrl ? { ...image, previewUrl } : image;
    });
  })();
  const files = attachments.filter(isFileAttachment);
  const videos = files.filter(isVideoAttachment);
  const otherFiles = files.filter((file) => !isVideoAttachment(file));
  const unknownAttachments = attachments.filter(
    (attachment) => !isImageAttachment(attachment) && !isFileAttachment(attachment),
  );

  return (
    <div className="mt-2 flex flex-col gap-2">
      {images.length > 0 || videos.length > 0 ? (
        <div className="grid max-w-[360px] grid-cols-2 gap-2">
          {images.map((image) => (
            <div
              key={image.id}
              className={cn(
                "bg-background/70",
                image.source?.kind === "snap-shot" && image.previewUrl
                  ? cn(SNAP_SHOT_ATTACHMENT_FRAME_CLASS, "col-span-2")
                  : "aspect-[4/3] overflow-hidden rounded-lg border border-border/80",
              )}
            >
              {image.previewUrl ? (
                <button
                  type="button"
                  className="block h-full w-full cursor-zoom-in"
                  aria-label={`Preview ${image.name}`}
                  onClick={() => {
                    const preview = buildExpandedImagePreview(images, image.id);
                    if (preview) ctx.onImageExpand(preview);
                  }}
                >
                  <img
                    src={image.previewUrl}
                    alt={image.name}
                    className="block size-full object-cover"
                  />
                </button>
              ) : (
                <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-2xs text-muted-foreground/70">
                  {image.name}
                </div>
              )}
              {image.previewUrl && image.source?.kind === "snap-shot" ? (
                <SnapShotAttachmentDetails source={image.source} />
              ) : null}
            </div>
          ))}
          {videos.map((file) => (
            <UserVideoAttachment key={file.id} file={file} />
          ))}
        </div>
      ) : null}
      {otherFiles.map((file) => (
        <div key={file.id} className="flex min-w-0 items-center gap-1">
          {file.downloadable !== false ? (
            <button
              type="button"
              aria-label={`Preview ${file.name}`}
              onClick={() => ctx.onFileOpen(file)}
              className="focus-visible:ring-ring/70 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md py-1 text-left text-sm hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
            >
              <PierreEntryIcon pathValue={file.name} kind="file" theme={ctx.resolvedTheme} />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <EyeIcon className="size-4 shrink-0" />
            </button>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2 py-1 text-sm">
              <PierreEntryIcon pathValue={file.name} kind="file" theme={ctx.resolvedTheme} />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
            </div>
          )}
          {file.downloadable !== false ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Download ${file.name}`}
                    onClick={() => ctx.onFileDownload(file)}
                  />
                }
              >
                <DownloadIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">Download {file.name}</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      ))}
      {unknownAttachments.map((attachment) => (
        <div key={attachment.id} className="flex min-w-0 items-center gap-2 py-1 text-sm">
          <PierreEntryIcon pathValue={attachment.name} kind="file" theme={ctx.resolvedTheme} />
          <span className="min-w-0 flex-1 truncate">{attachment.name}</span>
        </div>
      ))}
    </div>
  );
}
