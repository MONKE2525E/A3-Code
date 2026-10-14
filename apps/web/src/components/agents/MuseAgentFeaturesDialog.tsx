import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type MuseAgentFeatureSession,
  type NativeAgentFeatureReadInput,
  ProviderInstanceId as ProviderInstanceIdSchema,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  FingerprintIcon,
  ListChecksIcon,
  ListIcon,
  MessageSquareIcon,
  PencilIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import type { MuseFeaturesTab } from "~/rightPanelStore";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Sheet, SheetDescription, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import {
  museAgentFeatureReadQuery,
  museAgentFeatureUpdate,
  museAgentOpenThread,
  museAgentProfileQuery,
  museAgentStatusQuery,
} from "~/state/museAgent";
import { useComposerDraftStore } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import ChatMarkdown from "~/components/ChatMarkdown";

import { MuseAgentAvatar } from "./MuseAgentAvatar";
import { useMuseAgentAvatar } from "./useMuseAgentAvatar";
import { MuseAgentDeliveryRecovery } from "./MuseAgentDeliveryRecovery";
import { MuseAgentComputerSection } from "./MuseAgentComputerSection";
import { MuseAgentConnectionsSection } from "./MuseAgentConnectionsSection";
import { MuseAgentDictationSection } from "./MuseAgentDictationSection";
import { MuseAgentProfileSection } from "./MuseAgentProfileSection";
import {
  describeMuseSkill,
  groupMuseSkills,
  museMemoryPreview,
  museSessionTitle,
  resolveMuseSessionActions,
  resolveMuseTabSupport,
  type MuseFeatureTabId,
} from "./museAgentFeatures.logic";

type ReadInput = typeof NativeAgentFeatureReadInput.Type;
type Target = {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
};

/** One native read. `null` skips the request, e.g. before a search is submitted. */
function useFeatureRead(environmentId: EnvironmentId, input: ReadInput | null) {
  return useEnvironmentQuery(
    input === null ? null : museAgentFeatureReadQuery({ environmentId, input }),
  );
}

/** Loading, error with retry, and empty states shared by every section. */
function FeatureState<T>({
  view,
  label,
  isEmpty,
  emptyText,
  children,
}: {
  readonly view: {
    readonly data: T | null;
    readonly error: string | null;
    readonly isPending: boolean;
    readonly refresh: () => void;
  };
  readonly label: string;
  readonly isEmpty: (data: T) => boolean;
  readonly emptyText: string;
  readonly children: (data: T) => ReactNode;
}) {
  if (view.data === null) {
    if (view.error === null) {
      return (
        <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Loading {label}…
        </div>
      );
    }
    return (
      <div role="alert" className="grid gap-2 py-6 text-sm">
        <p className="text-foreground">Muse {label} could not be loaded.</p>
        <p className="text-xs text-muted-foreground">{view.error}</p>
        <Button size="sm" variant="outline" className="w-fit" onClick={view.refresh}>
          <RefreshIcon /> Try again
        </Button>
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      {view.error !== null ? (
        <p role="alert" className="flex items-center gap-2 text-xs text-destructive">
          Could not refresh {label}; showing the last result.
          <Button size="xs" variant="ghost" onClick={view.refresh}>
            Retry
          </Button>
        </p>
      ) : null}
      {isEmpty(view.data) ? (
        <p className="py-6 text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        children(view.data)
      )}
    </div>
  );
}

/** A list row: a rounded icon tile, then the content. Matches the original Muse app's lists. */
function Row({ children, icon }: { readonly children: ReactNode; readonly icon?: ReactNode }) {
  return (
    <li className="flex min-w-0 items-start gap-3 rounded-xl px-1 py-2">
      <span
        aria-hidden="true"
        className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground [&_svg]:size-4"
      >
        {icon ?? <SparklesIcon />}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-start justify-between gap-2">
        {children}
      </div>
    </li>
  );
}

function toneVariant(tone: "success" | "muted" | "warning") {
  return tone === "success" ? "success" : tone === "warning" ? "warning" : "outline";
}

function MemorySection({ environmentId, providerInstanceId }: Target) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [openUri, setOpenUri] = useState<string | null>(null);
  const search = useFeatureRead(
    environmentId,
    query === null ? null : { operation: "memory_search", providerInstanceId, query },
  );
  const detail = useFeatureRead(
    environmentId,
    openUri === null ? null : { operation: "memory_read", providerInstanceId, uri: openUri },
  );
  const results = search.data?.operation === "memory_search" ? search.data.data : null;
  const memory = detail.data?.operation === "memory_read" ? detail.data.data : null;
  return (
    <div className="grid gap-3">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draft.trim());
        }}
      >
        <Input
          aria-label="Search Muse memory"
          placeholder="Search what Muse remembers"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" variant="outline" disabled={draft.trim().length === 0}>
          Search
        </Button>
      </form>
      {query === null ? (
        <p className="py-4 text-sm text-muted-foreground">
          Search to browse Muse's memories. They are read-only here.
        </p>
      ) : (
        <FeatureState
          view={{ ...search, data: results }}
          label="memories"
          isEmpty={(items) => items.length === 0}
          emptyText={`No memories match “${query}”.`}
        >
          {(items) => (
            <ul className="grid gap-2">
              {items.map((item) => (
                <Row key={item.uri}>
                  <button
                    type="button"
                    className="grid min-w-0 flex-1 gap-0.5 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    onClick={() => setOpenUri(item.uri)}
                  >
                    <span className="truncate text-sm font-medium text-foreground">
                      {item.title || "Untitled memory"}
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {museMemoryPreview(item.summary ?? item.contentMarkdown) ?? "No preview"}
                    </span>
                  </button>
                </Row>
              ))}
            </ul>
          )}
        </FeatureState>
      )}
      <Dialog open={openUri !== null} onOpenChange={(open) => (open ? null : setOpenUri(null))}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{memory?.title || "Memory"}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <FeatureState
              view={{ ...detail, data: memory }}
              label="memory"
              isEmpty={() => false}
              emptyText=""
            >
              {(item) => (
                <ChatMarkdown
                  text={item.contentMarkdown ?? item.summary ?? "This memory has no text."}
                  cwd={undefined}
                  environmentId={environmentId}
                  className="select-text"
                />
              )}
            </FeatureState>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function useOpenMuseChatWithDraft(
  { environmentId, providerInstanceId }: Target,
  onClose: () => void,
) {
  const navigate = useNavigate();
  const openThread = useAtomCommand(museAgentOpenThread, { reportFailure: false });
  const canOpen = useAtomValue(museAgentOpenThread.permissionAtom(environmentId));
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = useCallback(
    async (prompt: string) => {
      if (opening) return;
      setError(null);
      // Always go through the guarded open: the server validates the account, unarchives and
      // reattaches history. It is idempotent, so a repeat returns the same canonical thread.
      setOpening(true);
      const result = await openThread({
        environmentId,
        input: { providerInstanceId: ProviderInstanceIdSchema.make(providerInstanceId) },
      });
      setOpening(false);
      if (result._tag !== "Success") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : "Could not open Muse.");
        }
        return;
      }
      const ref = scopeThreadRef(environmentId, result.value.threadId);
      // Keep whatever the user already typed; the seed goes below it. Never auto-sent.
      const store = useComposerDraftStore.getState();
      const existing = store.getComposerDraft(ref)?.prompt ?? "";
      store.setPrompt(ref, existing.trim().length > 0 ? `${existing}\n\n${prompt}` : prompt);
      onClose();
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
    },
    [environmentId, navigate, onClose, opening, openThread, providerInstanceId],
  );
  return { start, canOpen: canOpen && !opening, error };
}

function SkillsSection({ environmentId, providerInstanceId }: Target) {
  const view = useFeatureRead(environmentId, { operation: "skills", providerInstanceId });
  const skills = view.data?.operation === "skills" ? view.data.data : null;
  const groups = useMemo(() => (skills ? groupMuseSkills(skills) : []), [skills]);
  return (
    <FeatureState
      view={{ ...view, data: skills }}
      label="skills"
      isEmpty={(items) => items.length === 0}
      emptyText="Muse reports no skills."
    >
      {() => (
        <>
          <p className="text-xs text-muted-foreground">
            Skills are managed in the Muse app. Availability is what Muse reports.
          </p>
          {groups.map((group) => (
            <section key={group.category} className="grid gap-2">
              <h4 className="text-xs font-medium text-muted-foreground uppercase">
                {group.category}
              </h4>
              <ul className="grid gap-2">
                {group.skills.map((skill) => {
                  const state = describeMuseSkill(skill);
                  return (
                    <Row key={skill.name}>
                      <div className="grid min-w-0 flex-1 gap-0.5">
                        <span className="truncate text-sm font-medium text-foreground">
                          {skill.title ?? skill.name}
                        </span>
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {skill.description}
                        </span>
                        {state.detail ? (
                          <span className="text-xs text-muted-foreground">{state.detail}</span>
                        ) : null}
                      </div>
                      <Badge variant={toneVariant(state.tone)}>{state.label}</Badge>
                    </Row>
                  );
                })}
              </ul>
            </section>
          ))}
        </>
      )}
    </FeatureState>
  );
}

/**
 * Muse's record of what it has done. Conversations live under the Muse row in the sidebar; this tab
 * holds the tasks and runs Muse recorded, which are the sessions that are not threads.
 */
function ActivitySection({ environmentId, providerInstanceId }: Target) {
  const read = useFeatureRead(environmentId, {
    operation: "sessions",
    providerInstanceId,
    view: "active",
  });
  const sessions = read.data?.operation === "sessions" ? read.data.data : null;
  const tasks = sessions === null ? null : sessions.filter((session) => !session.isThread);
  return (
    <FeatureState
      view={{ ...read, data: tasks }}
      label="activity"
      isEmpty={(items) => items.length === 0}
      emptyText="Muse hasn't recorded any activity yet."
    >
      {(items) => (
        <ul className="grid gap-1">
          {items.map((session) => (
            <Row key={session.sessionId} icon={<ListChecksIcon />}>
              <div className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate text-sm font-semibold text-foreground">
                  {session.title?.trim() || "Untitled task"}
                </span>
                {session.snippet ? (
                  <span className="line-clamp-2 text-sm text-muted-foreground">
                    {session.snippet}
                  </span>
                ) : null}
              </div>
            </Row>
          ))}
        </ul>
      )}
    </FeatureState>
  );
}

/** Top-level panel tabs, matching the original Muse app. Schedules live in Scheduled tasks. */
type MusePanelTab = "activity" | "approvals" | "profile";
type MuseAbility = Extract<MuseFeatureTabId, "memory" | "connections" | "skills" | "dictation">;
/** What the body shows instead of a tab: an ability from Profile, or Muse's computer from the gear. */
type MuseDetail = MuseAbility | "computer";

const MUSE_PANEL_TABS: ReadonlyArray<{
  readonly id: MusePanelTab;
  readonly label: string;
  readonly icon: typeof ListIcon;
}> = [
  { id: "activity", label: "Activity", icon: ListIcon },
  { id: "approvals", label: "Approvals", icon: ShieldCheckIcon },
  { id: "profile", label: "Profile", icon: FingerprintIcon },
];

const MUSE_ABILITIES: ReadonlyArray<{
  readonly id: MuseAbility;
  readonly label: string;
  readonly description: string;
}> = [
  { id: "memory", label: "Memory", description: "Search what Muse remembers" },
  { id: "connections", label: "Connections", description: "Accounts Muse can reach" },
  { id: "skills", label: "Skills", description: "What Muse can do" },
  { id: "dictation", label: "Dictation", description: "Speak to Muse" },
];

/** The inventory feature each tab reads; Approvals has none, because Muse does not share it yet. */
const PANEL_FEATURE: Record<Exclude<MusePanelTab, "approvals">, MuseFeatureTabId> = {
  activity: "conversations",
  profile: "profile",
};

type MuseLeave =
  | { readonly kind: "close" }
  | { readonly kind: "go"; readonly tab: MusePanelTab; readonly detail: MuseDetail | null };

/**
 * Muse's features for one connected provider instance. The same body fills the thread's right
 * panel and the Settings sheet. Every section reads its own operation, so a tab only claims
 * availability once its query has succeeded.
 */
function MuseAgentFeaturesBody({
  environmentId,
  providerInstanceId,
  onClose,
  initialTab,
}: Target & { readonly onClose: () => void; readonly initialTab?: MuseFeaturesTab | undefined }) {
  const [tab, setTab] = useState<MusePanelTab>(initialTab ?? "activity");
  const [detail, setDetail] = useState<MuseDetail | null>(null);
  const canWrite = useAtomValue(museAgentFeatureUpdate.permissionAtom(environmentId));
  const inventory = useFeatureRead(environmentId, { operation: "inventory", providerInstanceId });
  const inventoryData = inventory.data?.operation === "inventory" ? inventory.data.data : null;
  const target = { environmentId, providerInstanceId };
  const profileQuery = useEnvironmentQuery(museAgentProfileQuery({ environmentId, input: {} }));
  const avatar = useMuseAgentAvatar(environmentId, profileQuery.data);
  const agentName = profileQuery.data?.name?.trim() || "Muse";
  // A successful hand-off to chat already delivered the transcript, so it closes without the guard.
  const [dictationActive, setDictationActive] = useState(false);
  const dictationChat = useOpenMuseChatWithDraft(target, () => {
    setDictationActive(false);
    onClose();
  });
  const profileOperations =
    inventoryData !== null
      ? (inventoryData.features.find((feature) => feature.feature === "profile")?.operations ?? [])
      : null;
  // Unsaved profile text survives only while its tab is open, so confirm before leaving it. The
  // requested change waits in `pendingLeave` while the profile stays mounted with its edits.
  const [profileDirty, setProfileDirty] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<MuseLeave | null>(null);
  const applyLeave = (leave: MuseLeave) => {
    if (leave.kind === "close") {
      onClose();
      return;
    }
    setTab(leave.tab);
    setDetail(leave.detail);
  };
  const requestLeave = (leave: MuseLeave) => {
    if (profileDirty || dictationActive) {
      setPendingLeave(leave);
      return;
    }
    applyLeave(leave);
  };
  const confirmLeave = () => {
    const leave = pendingLeave;
    setPendingLeave(null);
    if (!leave) return;
    setProfileDirty(false);
    setDictationActive(false);
    applyLeave(leave);
  };
  const panelSupport = (feature: MuseFeatureTabId) => resolveMuseTabSupport(inventoryData, feature);
  const unavailable = (
    <p role="status" className="px-6 py-10 text-center text-sm text-muted-foreground">
      This isn't available for Muse yet.
    </p>
  );

  let body: ReactNode;
  if (detail === "computer") {
    body = (
      <div className="flex flex-col gap-4 px-5 pb-6">
        <BackToProfile onBack={() => requestLeave({ kind: "go", tab: "profile", detail: null })} />
        <MuseAgentComputerSection {...target} canWrite={canWrite} />
      </div>
    );
  } else if (detail !== null) {
    body = (
      <div className="flex flex-col gap-4 px-5 pb-6">
        <BackToProfile onBack={() => requestLeave({ kind: "go", tab: "profile", detail: null })} />
        {panelSupport(detail) === "unavailable" ? (
          unavailable
        ) : detail === "memory" ? (
          <MemorySection {...target} />
        ) : detail === "connections" ? (
          <MuseAgentConnectionsSection {...target} canWrite={canWrite} />
        ) : detail === "skills" ? (
          <SkillsSection {...target} />
        ) : (
          <MuseAgentDictationSection
            key={`${environmentId}:${providerInstanceId}`}
            {...target}
            chat={dictationChat}
            onActiveChange={setDictationActive}
          />
        )}
      </div>
    );
  } else if (tab === "approvals") {
    body = (
      <div className="grid gap-3 px-5 pb-6">
        <h3 className="text-base font-semibold text-foreground">Approvals history</h3>
        <div className="flex flex-col items-center gap-3 rounded-2xl bg-muted/50 px-6 py-10 text-center">
          <span
            aria-hidden="true"
            className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground"
          >
            <ShieldCheckIcon className="size-4" />
          </span>
          <p role="status" className="text-sm text-muted-foreground">
            Muse hasn't shared its approval history with T3 yet.
          </p>
        </div>
      </div>
    );
  } else if (tab === "activity") {
    body =
      panelSupport(PANEL_FEATURE.activity) === "unavailable" ? (
        unavailable
      ) : (
        <div className="px-5 pb-6">
          <ActivitySection {...target} />
        </div>
      );
  } else {
    body = (
      <div className="flex flex-col gap-6 px-5 pb-6">
        {panelSupport(PANEL_FEATURE.profile) === "unavailable" ? (
          unavailable
        ) : (
          <MuseAgentProfileSection
            {...target}
            operations={profileOperations}
            canWrite={canWrite}
            onDirtyChange={setProfileDirty}
          />
        )}
        <ul className="flex flex-col gap-1">
          {MUSE_ABILITIES.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => requestLeave({ kind: "go", tab: "profile", detail: item.id })}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{item.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.description}
                  </span>
                </span>
                <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col items-center gap-1 px-5 pt-4 pb-5">
        <div className="relative w-full">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Muse's computer"
                  aria-pressed={detail === "computer"}
                  className="absolute top-0 right-0"
                  onClick={() =>
                    requestLeave({
                      kind: "go",
                      tab: "profile",
                      detail: detail === "computer" ? null : "computer",
                    })
                  }
                />
              }
            >
              <SettingsIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Muse's computer</TooltipPopup>
          </Tooltip>
        </div>
        <div className="relative mt-2 mb-2">
          <MuseAgentAvatar
            name={agentName}
            imageUrl={avatar.imageUrl}
            videoUrl={avatar.videoUrl}
            size="2xl"
          />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="secondary"
                  aria-label="Edit Muse's profile"
                  className="absolute right-0 bottom-1"
                  onClick={() => requestLeave({ kind: "go", tab: "profile", detail: null })}
                />
              }
            >
              <PencilIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Edit profile</TooltipPopup>
          </Tooltip>
        </div>
        <p className="text-xl font-semibold">{agentName}</p>
        <p className="flex items-center gap-1.5 text-sm text-success">
          <ZapIcon className="size-3.5 fill-current" /> Connected
        </p>
      </div>
      <div
        role="tablist"
        aria-label="Muse features"
        className="mx-5 mb-5 flex gap-1 rounded-full bg-muted p-1"
      >
        {MUSE_PANEL_TABS.map((item) => {
          const Icon = item.icon;
          const selected = tab === item.id && detail === null;
          return (
            <Tooltip key={item.id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-label={item.label}
                    className={cn(
                      "flex flex-1 items-center justify-center rounded-full py-2 transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      selected
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => {
                      if (item.id !== tab || detail !== null) {
                        requestLeave({ kind: "go", tab: item.id, detail: null });
                      }
                    }}
                  />
                }
              >
                <Icon className="size-4" />
              </TooltipTrigger>
              <TooltipPopup side="bottom">{item.label}</TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
      <div role="tabpanel" aria-label={detail ?? tab} className="min-h-0 flex-1 overflow-y-auto">
        {body}
      </div>
      <AlertDialog
        open={pendingLeave !== null}
        onOpenChange={(next) => (next ? null : setPendingLeave(null))}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dictationActive ? "Discard dictation?" : "Discard unsaved changes?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dictationActive
                ? "Recording stops and any transcript you haven't added to chat is lost. Audio already sent for transcription is ignored."
                : "Your edits to Muse's profile have not been saved and will be lost."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep editing</AlertDialogClose>
            <Button variant="destructive" onClick={confirmLeave}>
              {dictationActive ? "Discard dictation" : "Discard changes"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function BackToProfile({ onBack }: { readonly onBack: () => void }) {
  return (
    <button
      type="button"
      className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      onClick={onBack}
    >
      <ArrowLeftIcon className="size-4" /> Profile
    </button>
  );
}

/** The thread's right panel surface for Muse: nothing until Muse is connected. */
export function MuseAgentFeaturesPanel({
  environmentId,
  onClose,
  initialTab,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly initialTab?: MuseFeaturesTab | undefined;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const status = useEnvironmentQuery(
    canRead ? museAgentStatusQuery({ environmentId, input: {} }) : null,
  ).data;
  if (!canRead || !status?.ready || !status.provider) return null;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <MuseAgentFeaturesBody
        environmentId={environmentId}
        providerInstanceId={status.provider.instanceId}
        onClose={onClose}
        initialTab={initialTab}
      />
    </div>
  );
}

/** Header toggle for the thread's Muse features surface, mirroring the Grok Bot Computer toggle. */
export function MuseAgentHeaderFeatures({
  environmentId,
  pressed,
  onToggle,
}: {
  readonly environmentId: EnvironmentId;
  readonly pressed: boolean;
  readonly onToggle: () => void;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const status = useEnvironmentQuery(
    canRead ? museAgentStatusQuery({ environmentId, input: {} }) : null,
  ).data;
  if (!canRead || !status?.ready || !status.provider) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label="Muse features"
            className="relative shrink-0 [-webkit-app-region:no-drag]"
            pressed={pressed}
            variant="ghost"
            size="touch-sm"
            onClick={onToggle}
          />
        }
      >
        <SparklesIcon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">Muse features</TooltipPopup>
    </Tooltip>
  );
}

/** Settings entry for Muse's features, in a side sheet. The thread uses its right panel instead. */
export function MuseAgentFeaturesButton({
  environmentId,
  providerInstanceId,
  variant = "outline",
  size = "sm",
}: Target & {
  readonly variant?: "outline" | "ghost";
  readonly size?: "sm" | "touch-sm";
}) {
  const [open, setOpen] = useState(false);
  // Every feature read needs orchestration read access, so without it neither the button nor
  // its queries exist.
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  if (!canRead) return null;
  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)}>
        <SparklesIcon /> Muse features
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup side="right" className="flex w-full max-w-md flex-col">
          <SheetTitle className="sr-only">Muse features</SheetTitle>
          <SheetDescription className="sr-only">
            What Muse remembers, runs, and can reach on your account.
          </SheetDescription>
          {open ? (
            <MuseAgentFeaturesBody
              environmentId={environmentId}
              providerInstanceId={providerInstanceId}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </SheetPopup>
      </Sheet>
    </>
  );
}
