import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, GrokBot } from "@t3tools/contracts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { DraftInput } from "~/components/ui/draft-input";
import { Label } from "~/components/ui/label";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { grokBotsListQuery, grokBotsUpdate } from "~/state/grokBots";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { GROK_BOT_HAPPY_MS } from "./grokBotActivity";
import { GrokBotAppearancePicker } from "./GrokBotAppearancePicker";
import { grokBotFailureMessage, grokBotSurfaceKey } from "./grokBotPresentation";
import {
  isGrokBotProfileSaveRejected,
  type PendingLook,
  type ProfilePatch,
  type ProfileSaveState,
  reconcileProfileSave,
  UNCERTAIN_SAVE_MESSAGE,
} from "./grokBotProfileSave";

type SaveOutcome = "saved" | "rejected" | "uncertain";

export function GrokBotProfileEditor({
  environmentId,
  bot,
  compact = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: GrokBot;
  readonly compact?: boolean;
}) {
  const canUpdate = useAtomValue(grokBotsUpdate.permissionAtom(environmentId));
  const updateBot = useAtomCommand(grokBotsUpdate, { reportFailure: false });
  const roster = useEnvironmentQuery(grokBotsListQuery({ environmentId, input: {} }));
  const identity = grokBotSurfaceKey(environmentId, bot.id);
  // A count, not a flag: a blur-triggered save can overlap a switch or picker save.
  const [pendingCount, setPendingCount] = useState(0);
  const pending = pendingCount > 0;
  const [description, setDescription] = useState(bot.description);
  const [saveState, setSaveState] = useState<ProfileSaveState>({ look: null, issue: null });
  const [reconcileStartedAt, setReconcileStartedAt] = useState<number | null>(null);
  const [appearanceSignal, setAppearanceSignal] = useState(0);
  const [celebrating, setCelebrating] = useState(false);
  const celebrationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (celebrationTimer.current !== null) clearTimeout(celebrationTimer.current);
    },
    [],
  );
  // The roster decides what is confirmed. One pure pass settles the held look and the issue together.
  const reconciled = reconcileProfileSave(saveState, bot, roster.dataUpdatedAt);
  if (reconciled !== saveState) setSaveState(reconciled);
  const { look: pendingLook, issue } = reconciled;
  // Settles only the spinner. A refresh never decides a save: it may fall back to a stale roster.
  if (
    reconcileStartedAt !== null &&
    !roster.isPending &&
    (roster.error !== null || roster.dataUpdatedAt >= reconcileStartedAt)
  ) {
    setReconcileStartedAt(null);
  }
  const look = pendingLook ?? { shape: bot.avatarShape, color: bot.avatarColor, acceptedAt: null };

  const save = useCallback(
    async (patch: ProfilePatch): Promise<SaveOutcome> => {
      if (!canUpdate) return "rejected";
      setPendingCount((count) => count + 1);
      // An uncertain change stays visible until the roster shows it, even across another save.
      setSaveState((current) => ({
        ...current,
        issue: current.issue?.uncertain ? current.issue : null,
      }));
      const result = await updateBot({
        environmentId,
        input: { botId: bot.id, ...patch },
      });
      setPendingCount((count) => count - 1);
      if (result._tag === "Success") return "saved";
      const error = squashAtomCommandFailure(result);
      if (isGrokBotProfileSaveRejected(error, isAtomCommandInterrupted(result))) {
        setSaveState((current) => ({
          ...current,
          issue: { message: grokBotFailureMessage(error), uncertain: null },
        }));
        return "rejected";
      }
      setSaveState((current) => ({
        ...current,
        issue: { message: UNCERTAIN_SAVE_MESSAGE, uncertain: patch },
      }));
      return "uncertain";
    },
    [bot.id, canUpdate, environmentId, updateBot],
  );

  const changeLook = (patch: { avatarShape?: string; avatarColor?: string }) => {
    // Send both avatar fields so the uncertain check covers the whole look, not one half of it.
    const next: PendingLook = {
      shape: patch.avatarShape ?? look.shape,
      color: patch.avatarColor ?? look.color,
      acceptedAt: null,
    };
    setSaveState((current) => ({ ...current, look: next }));
    setAppearanceSignal((current) => current + 1);
    if (celebrationTimer.current !== null) clearTimeout(celebrationTimer.current);
    setCelebrating(true);
    celebrationTimer.current = setTimeout(() => setCelebrating(false), GROK_BOT_HAPPY_MS);
    void save({ avatarShape: next.shape, avatarColor: next.color }).then((outcome) => {
      // A newer look replaced this one, so its outcome no longer applies to what is shown.
      const applies = (current: ProfileSaveState) => current.look === next;
      if (outcome === "rejected") {
        setSaveState((current) => (applies(current) ? { ...current, look: null } : current));
        return;
      }
      setSaveState((current) =>
        applies(current) ? { ...current, look: { ...next, acceptedAt: Date.now() } } : current,
      );
    });
  };

  const refreshRoster = () => {
    setReconcileStartedAt(Date.now());
    roster.refresh();
  };

  return (
    <div className={cn("flex flex-col gap-6", compact && "gap-5")}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <GrokBotAppearancePicker
            botId={bot.id}
            shape={look.shape}
            color={look.color}
            name={bot.name}
            appearanceSignal={appearanceSignal}
            celebrating={celebrating}
            disabled={!canUpdate || pending}
            onSelectShape={(avatarShape) => changeLook({ avatarShape })}
            onSelectColor={(avatarColor) => changeLook({ avatarColor })}
          />
          <div className="min-w-0">
            <p className="truncate text-base font-medium">{bot.name}</p>
            <p className="text-xs text-muted-foreground">Click the bot to change how it looks.</p>
          </div>
        </div>
        {issue ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-destructive-foreground">{issue.message}</p>
            {issue.uncertain !== null ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={pending || reconcileStartedAt !== null}
                onClick={refreshRoster}
              >
                <RefreshIcon refreshing={reconcileStartedAt !== null} />
                Refresh
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <EditorGroup title="Profile">
        <EditorField htmlFor={`grok-bot-name-${identity}`} label="Name">
          <DraftInput
            id={`grok-bot-name-${identity}`}
            size="sm"
            maxLength={200}
            value={bot.name}
            disabled={!canUpdate || pending}
            onCommit={(name) => {
              const next = name.trim();
              if (next.length === 0) return;
              void save({ name: next });
            }}
          />
        </EditorField>
        <EditorField
          htmlFor={`grok-bot-label-${identity}`}
          label="Role"
          hint="Shown next to the name in the sidebar."
        >
          <DraftInput
            id={`grok-bot-label-${identity}`}
            size="sm"
            maxLength={200}
            value={bot.label}
            disabled={!canUpdate || pending}
            onCommit={(label) => void save({ label })}
          />
        </EditorField>
        <EditorField
          htmlFor={`grok-bot-description-${identity}`}
          label="Instructions"
          hint="What this bot does and how it should behave. Saved when you click away."
        >
          <Textarea
            id={`grok-bot-description-${identity}`}
            size="sm"
            className="overflow-hidden [&_textarea]:resize-none"
            maxLength={16000}
            disabled={!canUpdate || pending}
            value={description}
            onChange={(event) => setDescription(event.currentTarget.value)}
            onBlur={() => {
              if (description !== bot.description) void save({ description });
            }}
          />
        </EditorField>
      </EditorGroup>
      <EditorGroup title="Sidebar and notifications">
        <EditorSwitch
          title="Pinned"
          description="Show this bot as a tile at the top of the sidebar."
          checked={bot.pinned}
          disabled={!canUpdate || pending}
          onChange={(pinned) => void save({ pinned })}
        />
        <EditorSwitch
          title="Hidden"
          description="Keep this bot out of the sidebar. It stays available here."
          checked={bot.hidden}
          disabled={!canUpdate || pending}
          onChange={(hidden) => void save({ hidden })}
        />
        <EditorSwitch
          title="Notifications"
          description="Get notified when this bot finishes or needs input."
          checked={bot.notificationEnabled}
          disabled={!canUpdate || pending}
          onChange={(notificationEnabled) => void save({ notificationEnabled })}
        />
      </EditorGroup>
    </div>
  );
}

function EditorGroup({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <div className="flex flex-col gap-3 rounded-xl border border-border/60 p-3">{children}</div>
    </section>
  );
}

function EditorField({
  htmlFor,
  label,
  hint,
  children,
}: {
  readonly htmlFor: string;
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function EditorSwitch({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  readonly title: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        size="sm"
        checked={checked}
        disabled={disabled}
        aria-label={title}
        onCheckedChange={onChange}
      />
    </div>
  );
}
