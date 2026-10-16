import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { Project } from "../../types";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  serverConfigs: new Map<EnvironmentId, { nativeAgentWorkspaceRoot?: string }>(),
}));

vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector(DEFAULT_CLIENT_SETTINGS),
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments }),
  usePrimaryEnvironmentId: () => primaryId,
}));
vi.mock("~/state/entities", () => ({
  useProjects: () => state.projects,
  useServerConfigs: () => state.serverConfigs,
}));

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("remote");
const environments = [
  { environmentId: primaryId, label: "This machine" },
  { environmentId: remoteId, label: "Remote" },
];

function project(
  environmentId: EnvironmentId,
  id: string,
  title: string,
  workspaceRoot: string,
): Project {
  return {
    id: ProjectId.make(id),
    environmentId,
    title,
    workspaceRoot,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

let renderer: ReactTestRenderer | null = null;
let observed: ReadonlyArray<SidebarProjectSnapshot>[] = [];

function Probe() {
  observed.push(useSettingsProjectGroups());
  return null;
}

async function visibleProjectIds(): Promise<string[]> {
  await act(() => {
    renderer = create(<Probe />);
  });
  return (observed.at(-1) ?? [])
    .flatMap((group) => group.memberProjects.map((member) => member.id))
    .sort((a, b) => a.localeCompare(b));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observed = [];
  state.projects = [];
  state.serverConfigs = new Map();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("useSettingsProjectGroups native agent project", () => {
  it("hides the managed project at each environment's own root", async () => {
    state.projects = [
      project(primaryId, "managed-primary", "AI Agents", "/work/primary/native-agents"),
      project(remoteId, "managed-remote", "AI Agents", "/srv/t3/native-agents"),
      project(primaryId, "repo", "Repo", "/work/repo"),
    ];
    state.serverConfigs = new Map([
      [primaryId, { nativeAgentWorkspaceRoot: "/work/primary/native-agents" }],
      [remoteId, { nativeAgentWorkspaceRoot: "/srv/t3/native-agents" }],
    ]);

    expect(await visibleProjectIds()).toEqual(["repo"]);
  });

  it("keeps ordinary projects that share the managed title, basename, or another machine's root", async () => {
    state.projects = [
      project(primaryId, "managed", "AI Agents", "/work/primary/native-agents"),
      project(primaryId, "same-title", "AI Agents", "/work/ai-agents"),
      project(primaryId, "same-basename", "native-agents", "/home/me/native-agents"),
      project(remoteId, "remote-same-path", "Remote repo", "/work/primary/native-agents"),
    ];
    state.serverConfigs = new Map([
      [primaryId, { nativeAgentWorkspaceRoot: "/work/primary/native-agents" }],
      [remoteId, { nativeAgentWorkspaceRoot: "/srv/t3/native-agents" }],
    ]);

    expect(await visibleProjectIds()).toEqual(["remote-same-path", "same-basename", "same-title"]);
  });

  it("keeps every project when an environment does not publish a managed root", async () => {
    state.projects = [project(primaryId, "older", "AI Agents", "/work/primary/native-agents")];
    state.serverConfigs = new Map([[primaryId, {}]]);

    expect(await visibleProjectIds()).toEqual(["older"]);
  });
});
