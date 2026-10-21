import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import type { Project } from "../../types";

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  roots: new Map<EnvironmentId, { nativeAgentWorkspaceRoot?: string }>(),
  denied: new Set<EnvironmentId>(),
  update: vi.fn(),
  remove: vi.fn(),
  confirm: vi.fn(),
  release: vi.fn(),
  clear: vi.fn(),
  navigate: vi.fn(),
}));
vi.mock("/src/state/entities.ts", () => ({
  useProjects: () => state.projects,
  useServerConfigs: () => state.roots,
  useThreadShells: () => [],
  waitForProjectRemoval: async () => undefined,
}));
vi.mock("/src/state/environments.ts", () => ({
  useEnvironments: () => ({
    environments: ["primary", "remote"].map((environmentId) => ({
      environmentId,
      label: environmentId,
      connection: { phase: "connected" },
      serverConfig: {},
    })),
  }),
  usePrimaryEnvironmentId: () => "primary",
}));
vi.mock("/src/state/session.ts", () => ({
  useEnvironmentsWithScope: (members: ReadonlyArray<{ environmentId: EnvironmentId }>) =>
    new Set(
      members
        .filter((member) => !state.denied.has(member.environmentId))
        .map((member) => member.environmentId),
    ),
  readEnvironmentScope: (id: EnvironmentId) => !state.denied.has(id),
}));
vi.mock("/src/state/projects.ts", () => ({
  projectEnvironment: { update: "update", delete: "delete" },
}));
vi.mock("/src/state/use-orchestration-command.ts", () => ({
  useOrchestrationCommand: (command: string) =>
    command === "update" ? state.update : state.remove,
}));
vi.mock("/src/hooks/useSettings.ts", () => ({
  useClientSettings: (selector: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector(DEFAULT_CLIENT_SETTINGS),
}));
vi.mock("/src/localApi.ts", () => ({
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));
vi.mock("/src/composerDraftStore.ts", () => ({
  DraftId: { make: (value: string) => value },
  useComposerDraftStore: {
    getState: () => ({
      getDraftThreadByProjectRef: () => null,
      clearProjectDraftThreadId: state.clear,
    }),
  },
}));
vi.mock("/src/lib/composerDraftUploads.ts", () => ({ releaseProjectDraftUploads: state.release }));
vi.mock("@tanstack/react-router", async () => ({
  ...(await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")),
  useNavigate: () => state.navigate,
  useLocation: () => "/settings/projects",
}));
vi.mock("/src/components/settings/ProjectDefaultsSettings.tsx", () => ({
  ProjectDefaultsSettings: () => null,
}));
vi.mock("/src/components/settings/ProjectActionsSettings.tsx", () => ({
  ProjectActionsSettings: () => null,
}));
vi.mock("/src/components/settings/ProjectFaviconPickerDialog.tsx", () => ({
  canPickExternalProjectFavicon: () => false,
  ProjectFaviconPickerDialog: () => null,
}));
vi.mock("/src/components/settings/ProjectIconPickerDialog.tsx", () => ({
  ProjectIconPickerDialog: () => null,
}));
vi.mock("/src/components/ProjectFavicon.tsx", () => ({ ProjectFavicon: () => null }));
vi.mock("/src/components/ui/toast.tsx", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));

vi.mock("/src/components/settings/settingsLayout.tsx", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({
    children,
    headerAction,
  }: {
    children: ReactNode;
    headerAction?: ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({ control, resetAction }: { control?: ReactNode; resetAction?: ReactNode }) => (
    <div>
      {resetAction}
      {control}
    </div>
  ),
  SettingResetButton: ({
    label,
    ...props
  }: {
    label: string;
    disabled?: boolean;
    onClick: () => void;
  }) => <button {...props} aria-label={`Reset ${label} to default`} />,
}));

import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
function setup() {
  vi.clearAllMocks();
  state.denied = new Set();
  state.roots = new Map();
  state.projects = [primaryId, remoteId].map((environmentId) => ({
    id: ProjectId.make(`project-${environmentId}`),
    environmentId,
    title: "Shared repo",
    workspaceRoot: `/work/${environmentId}`,
    repositoryIdentity: {
      canonicalKey: "github.com/example/shared-repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/shared-repo.git",
      },
    },
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  }));
  state.update.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.remove.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.confirm.mockReset().mockResolvedValue(true);
}
function groupKey(projects = state.projects) {
  return buildSidebarProjectSnapshots({
    projects,
    settings: DEFAULT_CLIENT_SETTINGS,
    primaryEnvironmentId: primaryId,
    resolveEnvironmentLabel: (id) => id,
  })[0]!.projectKey;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

it("preflights every member before enabling shared edits or group removal", async () => {
  setup();
  state.denied.add(remoteId);
  await using screen = await render(<ProjectSettingsPanel projectKey={groupKey()} />);
  await expect.element(screen.getByRole("textbox", { name: "Project name" })).toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Remove all entries", exact: true }))
    .toBeDisabled();
  expect(state.update).not.toHaveBeenCalled();
});
it("renames every writable member through the project operation", async () => {
  setup();
  await using screen = await render(<ProjectSettingsPanel projectKey={groupKey()} />);
  await screen.getByRole("textbox", { name: "Project name" }).fill("Renamed");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(state.update.mock.calls.map(([request]) => request.environmentId)).toEqual([
      primaryId,
      remoteId,
    ]),
  );
  expect(state.update.mock.calls.map(([request]) => request.input.title)).toEqual([
    "Renamed",
    "Renamed",
  ]);
});
it("stops before a member revoked during an earlier update", async () => {
  setup();
  const first = deferred<AsyncResult.Success<void>>();
  state.update.mockReturnValueOnce(first.promise);
  await using screen = await render(<ProjectSettingsPanel projectKey={groupKey()} />);
  await screen.getByRole("textbox", { name: "Project name" }).fill("Renamed");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  state.denied.add(remoteId);
  await act(async () => {
    first.resolve(AsyncResult.success(undefined));
    await first.promise;
  });
  expect(state.update).toHaveBeenCalledOnce();
});
it("allows a writable checkout while denying removal of the mixed group", async () => {
  setup();
  state.denied.add(remoteId);
  await using screen = await render(<ProjectSettingsPanel projectKey={groupKey()} />);
  await expect
    .element(screen.getByRole("button", { name: "Remove checkout /work/remote" }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Remove all entries", exact: true }))
    .toBeDisabled();
  await screen.getByRole("button", { name: "Remove checkout /work/primary" }).click();
  await vi.waitFor(() =>
    expect(state.remove).toHaveBeenCalledExactlyOnceWith({
      environmentId: primaryId,
      input: { projectId: state.projects[0]!.id, force: true },
    }),
  );
  await vi.waitFor(() => expect(state.release).toHaveBeenCalledOnce());
  expect(state.clear).toHaveBeenCalledOnce();
});
it("rechecks all removal targets after confirmation before deleting or clearing drafts", async () => {
  setup();
  const confirmed = deferred<boolean>();
  state.confirm.mockReturnValueOnce(confirmed.promise);
  await using screen = await render(<ProjectSettingsPanel projectKey={groupKey()} />);
  await screen.getByRole("button", { name: "Remove all entries", exact: true }).click();
  expect(state.confirm).toHaveBeenCalledOnce();
  state.denied.add(remoteId);
  await act(async () => {
    confirmed.resolve(true);
    await confirmed.promise;
  });
  expect(state.remove).not.toHaveBeenCalled();
  expect(state.release).not.toHaveBeenCalled();
  expect(state.clear).not.toHaveBeenCalled();
});
it("reacts to revoked and restored access before saving", async () => {
  setup();
  const key = groupKey();
  await using screen = await render(<ProjectSettingsPanel projectKey={key} />);
  state.denied.add(remoteId);
  await screen.rerender(<ProjectSettingsPanel projectKey={key} />);
  await expect.element(screen.getByRole("textbox", { name: "Project name" })).toBeDisabled();
  state.denied.clear();
  await screen.rerender(<ProjectSettingsPanel projectKey={key} />);
  await expect.element(screen.getByRole("textbox", { name: "Project name" })).toBeEnabled();
  await screen.getByRole("textbox", { name: "Project name" }).fill("Restored");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
});
it("does not offer removal for a managed project opened by a direct settings link", async () => {
  setup();
  const managedRoot = "/work/primary/native-agents";
  const managed = {
    ...state.projects[0]!,
    title: "AI Agents",
    workspaceRoot: managedRoot,
    repositoryIdentity: null,
  };
  state.projects = [managed, { ...state.projects[1]!, repositoryIdentity: null }];
  state.roots.set(primaryId, { nativeAgentWorkspaceRoot: managedRoot });
  await using screen = await render(<ProjectSettingsPanel projectKey={groupKey([managed])} />);
  await expect.element(screen.getByText("This project is no longer available.")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Remove project", exact: true }))
    .not.toBeInTheDocument();
  expect(state.remove).not.toHaveBeenCalled();
});
it("keeps an ordinary project sharing the managed title removable", async () => {
  setup();
  state.projects = [
    { ...state.projects[0]!, title: "AI Agents", workspaceRoot: "/work/ai-agents" },
  ];
  state.roots.set(primaryId, { nativeAgentWorkspaceRoot: "/work/primary/native-agents" });
  await using screen = await render(<ProjectSettingsPanel projectKey={groupKey()} />);
  await expect
    .element(screen.getByRole("button", { name: "Remove project", exact: true }))
    .toBeEnabled();
});
