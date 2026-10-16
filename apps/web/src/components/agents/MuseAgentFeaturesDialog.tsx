import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  ThreadId,
  type NativeAgentFeatureReadInput,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  ListChecksIcon,
  PencilIcon,
  ShieldCheckIcon,
  SparklesIcon,
  ZapIcon,
} from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

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
import { Input } from "~/components/ui/input";
import { Sheet, SheetDescription, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import {
  museAgentFeatureReadQuery,
  museAgentFeatureUpdate,
  museAgentOpenThread,
  museAgentProfileQuery,
  museAgentStatusQuery,
} from "~/state/museAgent";
import { registerRightPanelLeaveGuard } from "~/rightPanelStore";
import { buildThreadRouteParams } from "~/threadRoutes";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { environmentThreadShells } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { ThreadAutomationsPanel } from "~/components/chat/ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "~/components/chat/ThreadRelationshipsControl";

import { MuseAgentAvatar } from "./MuseAgentAvatar";
import { useMuseAgentAvatar } from "./useMuseAgentAvatar";
import { MuseAgentDeliveryRecovery } from "./MuseAgentDeliveryRecovery";
import { findCachedMuseAgentThread, museSessionForThread } from "./aiAgents";
import { MuseAgentComputerSection } from "./MuseAgentComputerSection";
import { MuseAgentConnectionsSection } from "./MuseAgentConnectionsSection";
import { MuseAgentProfileSection } from "./MuseAgentProfileSection";
import { MuseChatLoading } from "./MuseAgentRouteConnection";
import { groupMuseRoutines } from "./museAgentRoutines";
import {
  describeMuseSkill,
  formatMuseNextRun,
  groupMuseSkills,
  museSkillMatches,
  resolveMuseTabSupport,
  type MuseFeatureTabId,
} from "./museAgentFeatures.logic";
import { clearMuseChatOpen, openCachedMuseThread, peekMuseChatOpen } from "./openCachedMuseThread";

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
  keepChildrenOnEmpty = false,
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
  readonly keepChildrenOnEmpty?: boolean;
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
      {isEmpty(view.data) && !keepChildrenOnEmpty ? (
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

const SKILL_SECTION_PREVIEW = 4;
const SKILL_CARD_CLASS =
  "min-w-0 rounded-xl border bg-card flex items-center gap-3 p-3 transition-colors hover:bg-accent/50";

export function MuseAgentSkillsSection({ environmentId, providerInstanceId }: Target) {
  const view = useFeatureRead(environmentId, { operation: "skills", providerInstanceId });
  const skills = view.data?.operation === "skills" ? view.data.data : null;
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const needle = search.trim().toLowerCase();
  const presentCategories = useMemo(
    () => (skills ? groupMuseSkills(skills).map((group) => group.category) : []),
    [skills],
  );
  const sections = useMemo(() => {
    if (skills === null) return [];
    const grouped = groupMuseSkills(skills.filter((skill) => museSkillMatches(skill, needle)));
    return category === "all" ? grouped : grouped.filter((group) => group.category === category);
  }, [category, needle, skills]);
  const searching = needle !== "";
  // Loaded catalog is authoritative. Skip null/loading so a refresh does not wipe a still-valid chip.
  if (skills !== null && category !== "all" && !presentCategories.includes(category)) {
    setCategory("all");
  }
  return (
    <FeatureState
      view={{ ...view, data: skills }}
      label="skills"
      isEmpty={(items) => items.length === 0}
      emptyText="Muse reports no skills."
      keepChildrenOnEmpty
    >
      {(items) => (
        <div className="space-y-6">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <Input
              placeholder="Search skills"
              aria-label="Search skills"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Button size="touch-sm" variant="ghost-muted" onClick={view.refresh}>
              <RefreshIcon refreshing={view.isPending} />
              Refresh
            </Button>
          </div>
          {presentCategories.length > 1 ? (
            <div role="group" aria-label="Skill category" className="flex flex-wrap gap-1">
              {["all", ...presentCategories].map((key) => (
                <Button
                  key={key}
                  size="sm"
                  variant={category === key ? "secondary" : "ghost"}
                  aria-pressed={category === key}
                  onClick={() => setCategory(key)}
                >
                  {key === "all" ? "All" : key}
                </Button>
              ))}
            </div>
          ) : null}
          {items.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">Muse reports no skills.</p>
          ) : sections.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing matches.</p>
          ) : (
            sections.map((section) => {
              const preview = searching || category !== "all" || expanded.has(section.category);
              const shown = preview
                ? section.skills
                : section.skills.slice(0, SKILL_SECTION_PREVIEW);
              return (
                <section key={section.category} className="space-y-2" aria-label={section.category}>
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-medium text-foreground">{section.category}</h4>
                    {!preview && section.skills.length > SKILL_SECTION_PREVIEW ? (
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        onClick={() =>
                          setExpanded((current) => new Set([...current, section.category]))
                        }
                      >
                        View all
                      </Button>
                    ) : null}
                  </div>
                  <ul className="grid gap-2 sm:grid-cols-2">
                    {shown.map((skill) => {
                      const state = describeMuseSkill(skill);
                      return (
                        <li key={skill.name} className={SKILL_CARD_CLASS}>
                          <span
                            aria-hidden="true"
                            className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"
                          >
                            <SparklesIcon className="size-4" />
                          </span>
                          <div className="grid min-w-0 flex-1 gap-0.5">
                            <span className="truncate text-sm font-medium text-foreground">
                              {skill.title ?? skill.name}
                            </span>
                            {skill.description ? (
                              <span className="line-clamp-1 text-xs leading-5 text-muted-foreground">
                                {skill.description}
                              </span>
                            ) : null}
                          </div>
                          {state.showBadge ? (
                            <Badge variant={toneVariant(state.tone)}>{state.label}</Badge>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })
          )}
        </div>
      )}
    </FeatureState>
  );
}

/**
 * Muse's record of what it has done. Conversations live under the Muse row in the sidebar; this page
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

/** Native schedules Muse owns. Empty until Muse reports at least one task. */
function RoutinesSection({
  environmentId,
  providerInstanceId,
  threadId,
}: Target & { readonly threadId?: string }) {
  const view = useFeatureRead(environmentId, { operation: "tasks", providerInstanceId });
  const tasks = view.data?.operation === "tasks" ? view.data.data : null;
  const groups = useMemo(() => (tasks ? groupMuseRoutines(tasks) : []), [tasks]);
  const now = Date.now();
  return (
    <div className="grid gap-6">
      <p className="text-xs text-muted-foreground">
        Routines Muse runs itself. T3 scheduled tasks on this chat, if any, appear separately below.
      </p>
      <FeatureState
        view={{ ...view, data: tasks }}
        label="routines"
        isEmpty={(items) => items.length === 0}
        emptyText="Ask Muse in chat to create a routine. Muse runs these itself; they are not T3 scheduled tasks."
      >
        {() =>
          groups.map((group) => (
            <section key={group.group} className="grid gap-2">
              <h4 className="text-xs font-medium text-muted-foreground uppercase">{group.label}</h4>
              <ul className="grid gap-1">
                {group.tasks.map((routine) => {
                  const nextRun = formatMuseNextRun(routine.nextRunAtUtc, now);
                  return (
                    <Row key={routine.id} icon={<ClockIcon />}>
                      <div className="grid min-w-0 flex-1 gap-0.5">
                        <span className="truncate text-sm font-semibold text-foreground">
                          {routine.title?.trim() || "Untitled routine"}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {routine.scheduleLabel}
                          {nextRun ? ` · ${nextRun}` : ""}
                        </span>
                      </div>
                    </Row>
                  );
                })}
              </ul>
            </section>
          ))
        }
      </FeatureState>
      {threadId ? (
        <ThreadAutomationsPanel environmentId={environmentId} threadId={ThreadId.make(threadId)} />
      ) : null}
    </div>
  );
}

function useResolvedMuseThreadId(
  environmentId: EnvironmentId,
  providerInstanceId: ProviderInstanceId,
  threadId?: string,
): string | undefined {
  const shells = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  if (threadId) return threadId;
  return findCachedMuseAgentThread(shells, providerInstanceId)?.id;
}

/**
 * T3 child tasks on the current Muse chat. Native Muse has its own roster (`subagents.list` /
 * `subagents.status`); that is not in T3's feature-read contract yet, so this never relabels
 * side chats as subagents.
 */
function SubagentsSection({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId?: string;
}) {
  return (
    <div className="grid gap-6">
      <p className="text-xs text-muted-foreground">
        T3 child tasks on this chat. Muse's own subagent roster is not available in T3 yet.
      </p>
      {threadId ? (
        <ThreadRelationshipsPanel
          environmentId={environmentId}
          threadId={ThreadId.make(threadId)}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Open Muse chat to see T3 child tasks on that conversation.
        </p>
      )}
    </div>
  );
}

/** What the Profile page shows instead of its main view. Computer is a list item, not a gear. */
type MuseDetail =
  | "activity"
  | "approvals"
  | "routines"
  | "subagents"
  | "connections"
  | "skills"
  | "computer";

const MUSE_ABILITIES: ReadonlyArray<{
  readonly id: MuseDetail;
  readonly label: string;
  readonly description: string;
}> = [
  { id: "activity", label: "Activity", description: "Tasks Muse has recorded" },
  { id: "approvals", label: "Approvals", description: "Review Muse approvals" },
  { id: "routines", label: "Routines", description: "Jobs Muse runs on its own" },
  { id: "subagents", label: "Subagents", description: "T3 child tasks on this chat" },
  { id: "connections", label: "Connections", description: "Accounts Muse can reach" },
  { id: "skills", label: "Skills", description: "What Muse can do" },
  { id: "computer", label: "Computer", description: "Muse's computer" },
];

type MuseLeaveHandle = {
  requestClose: () => void;
  requestAction: (apply: () => void, cancel?: () => void) => void;
  isDirty: () => boolean;
};

type MuseLeave =
  | { readonly kind: "action"; readonly apply: () => void; readonly cancel?: () => void }
  | { readonly kind: "close" }
  | { readonly kind: "go"; readonly detail: MuseDetail | null };

/**
 * Muse's features for one connected provider instance. The same body fills the thread's right
 * panel and the Settings sheet. Every section reads its own operation, so a tab only claims
 * availability once its query has succeeded.
 */
function MuseAgentFeaturesBody({
  environmentId,
  providerInstanceId,
  threadId,
  onClose,
  closeRef,
}: Target & {
  readonly threadId?: string;
  readonly onClose: () => void;
  readonly closeRef?: Ref<MuseLeaveHandle>;
}) {
  const [detail, setDetail] = useState<MuseDetail | null>(null);
  const canOperateComputer = useAtomValue(
    museAgentFeatureUpdate.permissionAtom(environmentId, { operation: "computer_action" }),
  );
  const canReleaseDelivery = useAtomValue(
    museAgentFeatureUpdate.permissionAtom(environmentId, { operation: "delivery_release" }),
  );
  const canConfigure = useAtomValue(
    museAgentFeatureUpdate.permissionAtom(environmentId, { operation: "profile_save" }),
  );
  const canConnect = useAtomValue(
    museAgentFeatureUpdate.permissionAtom(environmentId, { operation: "connector_auth" }),
  );
  const resolvedThreadId = useResolvedMuseThreadId(environmentId, providerInstanceId, threadId);
  const inventory = useFeatureRead(environmentId, { operation: "inventory", providerInstanceId });
  const inventoryData = inventory.data?.operation === "inventory" ? inventory.data.data : null;
  const target = { environmentId, providerInstanceId };
  const profileQuery = useEnvironmentQuery(
    museAgentProfileQuery({ environmentId, input: { providerInstanceId } }),
  );
  const avatar = useMuseAgentAvatar(environmentId, profileQuery.data);
  const agentName = profileQuery.data?.name?.trim() || "Muse";
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
    if (leave.kind === "action") leave.apply();
    else setDetail(leave.detail);
  };
  const requestLeave = (leave: MuseLeave) => {
    if (profileDirty) {
      setPendingLeave(leave);
      return;
    }
    applyLeave(leave);
  };
  useImperativeHandle(closeRef, () => ({
    requestClose: () => requestLeave({ kind: "close" }),
    requestAction: (apply, cancel) =>
      requestLeave({ kind: "action", apply, ...(cancel ? { cancel } : {}) }),
    isDirty: () => profileDirty,
  }));
  useLayoutEffect(
    () => () => {
      if (pendingLeave?.kind === "action") pendingLeave.cancel?.();
    },
    [pendingLeave],
  );
  const cancelLeave = () => {
    if (pendingLeave?.kind === "action") pendingLeave.cancel?.();
    setPendingLeave(null);
  };
  const confirmLeave = () => {
    const leave = pendingLeave;
    setPendingLeave(null);
    if (!leave) return;
    setProfileDirty(false);
    applyLeave(leave);
  };
  const panelSupport = (feature: MuseFeatureTabId) => resolveMuseTabSupport(inventoryData, feature);
  const unavailable = (
    <p role="status" className="px-6 py-10 text-center text-sm text-muted-foreground">
      This isn't available for Muse yet.
    </p>
  );
  const supportFor = (detail: MuseDetail): MuseFeatureTabId | null => {
    if (detail === "activity" || detail === "approvals" || detail === "subagents") return null;
    return detail;
  };

  let body: ReactNode;
  if (detail !== null) {
    const supportKey = supportFor(detail);
    body = (
      <div className="flex flex-col gap-4 px-5 pb-6">
        <BackToProfile onBack={() => requestLeave({ kind: "go", detail: null })} />
        {supportKey !== null && panelSupport(supportKey) === "unavailable" ? (
          unavailable
        ) : detail === "computer" ? (
          <MuseAgentComputerSection {...target} canWrite={canOperateComputer} />
        ) : detail === "activity" ? (
          <ActivitySection {...target} />
        ) : detail === "approvals" ? (
          <MuseApprovalsSection />
        ) : detail === "routines" ? (
          <RoutinesSection
            {...target}
            {...(resolvedThreadId ? { threadId: resolvedThreadId } : {})}
          />
        ) : detail === "subagents" ? (
          <SubagentsSection
            environmentId={environmentId}
            {...(resolvedThreadId ? { threadId: resolvedThreadId } : {})}
          />
        ) : detail === "connections" ? (
          <MuseAgentConnectionsSection {...target} canWrite={canConnect} />
        ) : (
          <MuseAgentSkillsSection {...target} />
        )}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-6 px-5 pb-6">
        <MuseAgentDeliveryRecovery
          key={threadId ?? "primary"}
          {...target}
          sessionId={museSessionForThread(threadId)}
          canWrite={canReleaseDelivery}
        />
        {panelSupport("profile") === "unavailable" ? (
          unavailable
        ) : (
          <MuseAgentProfileSection
            {...target}
            operations={profileOperations}
            canWrite={canConfigure}
            onDirtyChange={setProfileDirty}
          />
        )}
        <ul className="flex flex-col gap-1">
          {MUSE_ABILITIES.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => requestLeave({ kind: "go", detail: item.id })}
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
                  onClick={() => requestLeave({ kind: "go", detail: null })}
                />
              }
            >
              <PencilIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Edit profile</TooltipPopup>
          </Tooltip>
        </div>
        <p className="text-xl font-semibold">{agentName}</p>
        {profileQuery.data ? (
          <p className="flex items-center gap-1.5 text-sm text-success">
            <ZapIcon className="size-3.5 fill-current" /> Connected
          </p>
        ) : profileQuery.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            Couldn't load this Muse account.
          </p>
        ) : profileQuery.isPending ? (
          <p className="text-sm text-muted-foreground">Loading Muse…</p>
        ) : null}
      </div>
      <div
        role="tabpanel"
        aria-label={detail ?? "profile"}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {body}
      </div>
      <AlertDialog
        open={pendingLeave !== null}
        onOpenChange={(next) => (next ? null : cancelLeave())}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your edits to Muse's profile have not been saved and will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep editing</AlertDialogClose>
            <Button variant="destructive" onClick={confirmLeave}>
              Discard changes
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
  threadId,
  providerInstanceId,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: string;
  readonly onClose: () => void;
}) {
  const closeRef = useRef<MuseLeaveHandle>(null);
  useLayoutEffect(
    () =>
      registerRightPanelLeaveGuard(
        scopeThreadRef(environmentId, ThreadId.make(threadId)),
        "muse-features",
        (proceed) => closeRef.current?.requestAction(proceed),
        () => closeRef.current?.isDirty() ?? false,
      ),
    [environmentId, threadId],
  );
  useBlocker({
    shouldBlockFn: ({ current, next }) =>
      current.pathname === next.pathname
        ? false
        : new Promise<boolean>((resolve) => {
            if (!closeRef.current) {
              resolve(false);
              return;
            }
            closeRef.current.requestAction(
              () => resolve(false),
              () => resolve(true),
            );
          }),
    enableBeforeUnload: () => closeRef.current?.isDirty() ?? false,
  });
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const status = useEnvironmentQuery(
    canRead ? museAgentStatusQuery({ environmentId, input: {} }) : null,
  ).data;
  if (!canRead || !status?.ready || status.provider?.instanceId !== providerInstanceId) return null;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <MuseAgentFeaturesBody
        key={`${environmentId}:${providerInstanceId}:${threadId}`}
        closeRef={closeRef}
        environmentId={environmentId}
        threadId={threadId}
        providerInstanceId={providerInstanceId}
        onClose={onClose}
      />
    </div>
  );
}

/** Muse has not shared its approval history with T3, so the page says so instead of guessing. */
function MuseApprovalsSection() {
  return (
    <div className="grid gap-3 px-5 pb-6">
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
}

function shortOpenError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const line = error.message.split("\n")[0]?.trim() ?? "";
  if (line.length === 0 || line.length > 160 || /[/\\]|\b[\w-]{32,}\b/.test(line)) return fallback;
  return line;
}

/**
 * First-open surface for `/muse/chat`. The sidebar navigates here immediately; this page runs the
 * guarded open and replace-navigates to the opened thread. It never opens another account's chat.
 */
export function MuseAgentChatEntry({ environmentId, providerInstanceId }: Target) {
  const navigate = useNavigate();
  const openThread = useAtomCommand(museAgentOpenThread, { reportFailure: false });
  const canOpen = useAtomValue(museAgentOpenThread.permissionAtom(environmentId));
  const shells = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const profile = useEnvironmentQuery(
    museAgentProfileQuery({ environmentId, input: { providerInstanceId } }),
  );
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const shellsRef = useRef(shells);
  shellsRef.current = shells;
  const openThreadRef = useRef(openThread);
  openThreadRef.current = openThread;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // One open per environment/account/retry. Shell writes and callback identity must not abort it.
  useEffect(() => {
    const intent = peekMuseChatOpen();
    if (
      intent !== null &&
      (intent.environmentId !== environmentId || intent.providerInstanceId !== providerInstanceId)
    ) {
      clearMuseChatOpen();
      setError(
        "This conversation belongs to a different Muse account. Reconnect that account to open it.",
      );
      return;
    }
    if (!canOpen) return;
    let current = true;
    setError((previous) => (previous === null ? previous : null));
    void (async () => {
      try {
        if (intent?.kind === "session") {
          await openCachedMuseThread({
            hit: { environmentId, threadId: intent.threadId },
            shells: shellsRef.current.map((thread) => ({
              environmentId,
              id: thread.id,
              providerInstanceId: thread.providerInstanceId,
            })),
            openThread: async (target) => {
              const result = await openThreadRef.current(target);
              if (result._tag === "Success") return result.value;
              if (isAtomCommandInterrupted(result)) return null;
              throw squashAtomCommandFailure(result);
            },
            navigate: async (target) => {
              if (!current) return;
              clearMuseChatOpen();
              await navigateRef.current({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(
                  scopeThreadRef(target.environmentId, target.threadId),
                ),
                replace: true,
              });
            },
          });
          return;
        }
        const result = await openThreadRef.current({
          environmentId,
          input: { providerInstanceId },
        });
        if (!current) return;
        if (result._tag !== "Success") {
          if (!isAtomCommandInterrupted(result)) {
            setError(
              shortOpenError(squashAtomCommandFailure(result), "Could not open Muse. Try again."),
            );
          }
          return;
        }
        clearMuseChatOpen();
        await navigateRef.current({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(environmentId, result.value.threadId)),
          replace: true,
        });
      } catch (cause: unknown) {
        if (current) setError(shortOpenError(cause, "Could not open Muse. Try again."));
      }
    })();
    return () => {
      current = false;
    };
  }, [canOpen, environmentId, providerInstanceId, retry]);
  if (!canOpen) {
    return (
      <p
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground"
      >
        Opening Muse needs permission to operate on this environment.
      </p>
    );
  }
  if (error !== null) {
    return (
      <div
        role="alert"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <p className="text-sm text-destructive">{error}</p>
        <Button size="sm" variant="outline" onClick={() => setRetry((value) => value + 1)}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <MuseChatLoading
      name={profile.data?.name?.trim() || "Muse"}
      description="Opening this conversation. Nothing is sent to Muse."
    />
  );
}

export type MuseAgentSectionId = "activity" | "approvals" | "chat" | "routines" | "subagents";

const SECTION_TITLE: Record<Exclude<MuseAgentSectionId, "chat">, string> = {
  activity: "Activity",
  approvals: "Approvals",
  routines: "Routines",
  subagents: "Subagents",
};

/** Standalone routes opened from the Muse flyout, plus first-open chat. */
export function MuseAgentSectionPage({
  environmentId,
  providerInstanceId,
  section,
}: Target & { readonly section: MuseAgentSectionId }) {
  if (section === "chat") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <MuseAgentChatEntry environmentId={environmentId} providerInstanceId={providerInstanceId} />
      </div>
    );
  }
  return (
    <MuseAgentNamedSectionPage
      environmentId={environmentId}
      providerInstanceId={providerInstanceId}
      section={section}
    />
  );
}

function MuseAgentNamedSectionPage({
  environmentId,
  providerInstanceId,
  section,
}: Target & { readonly section: Exclude<MuseAgentSectionId, "chat"> }) {
  const inventory = useFeatureRead(environmentId, { operation: "inventory", providerInstanceId });
  const inventoryData = inventory.data?.operation === "inventory" ? inventory.data.data : null;
  const supportKey: MuseFeatureTabId | null =
    section === "activity" ? "conversations" : section === "routines" ? "routines" : null;
  const unavailable =
    supportKey !== null && resolveMuseTabSupport(inventoryData, supportKey) === "unavailable";
  const target = { environmentId, providerInstanceId };
  const threadId = useResolvedMuseThreadId(environmentId, providerInstanceId);
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <h2 className="px-5 pt-5 pb-3 text-xl font-semibold">{SECTION_TITLE[section]}</h2>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {section === "approvals" ? (
          <MuseApprovalsSection />
        ) : unavailable ? (
          <p role="status" className="px-6 py-10 text-center text-sm text-muted-foreground">
            This isn't available for Muse yet.
          </p>
        ) : (
          <div className="px-5 pb-6">
            {section === "activity" ? (
              <ActivitySection {...target} />
            ) : section === "routines" ? (
              <RoutinesSection {...target} {...(threadId ? { threadId } : {})} />
            ) : (
              <SubagentsSection environmentId={environmentId} {...(threadId ? { threadId } : {})} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Header toggle for the thread's Muse features surface, mirroring the Grok Bot Computer toggle. */
export function MuseAgentHeaderFeatures({
  environmentId,
  providerInstanceId,
  pressed,
  onToggle,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId | undefined;
  readonly pressed: boolean;
  readonly onToggle: () => void;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const status = useEnvironmentQuery(
    canRead ? museAgentStatusQuery({ environmentId, input: {} }) : null,
  ).data;
  if (
    !canRead ||
    !status?.ready ||
    !providerInstanceId ||
    status.provider?.instanceId !== providerInstanceId
  )
    return null;
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
  const closeRef = useRef<MuseLeaveHandle>(null);
  // Every feature read needs orchestration read access, so without it neither the button nor
  // its queries exist.
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  if (!canRead) return null;
  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)}>
        <SparklesIcon /> Muse features
      </Button>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (next) setOpen(true);
          else closeRef.current?.requestClose();
        }}
      >
        <SheetPopup side="right" className="flex w-full max-w-md flex-col">
          <SheetTitle className="sr-only">Muse features</SheetTitle>
          <SheetDescription className="sr-only">
            What Muse remembers, runs, and can reach on your account.
          </SheetDescription>
          {open ? (
            <MuseAgentFeaturesBody
              key={`${environmentId}:${providerInstanceId}`}
              closeRef={closeRef}
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
