import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

import type { Project } from "../../types";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

const state = vi.hoisted(() => ({
  projects: [] as Project[],
  serverConfigs: new Map<EnvironmentId, { nativeAgentWorkspaceRoot?: string }>(),
}));

vi.mock("/src/hooks/useSettings.ts", () => ({
  useClientSettings: (selector: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector(DEFAULT_CLIENT_SETTINGS),
}));
vi.mock("/src/state/environments.ts", () => ({
  useEnvironments: () => ({ environments }),
  usePrimaryEnvironmentId: () => primaryId,
}));
vi.mock("/src/state/entities.ts", () => ({
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

function Probe() {
  const groups = useSettingsProjectGroups();
  return (
    <ul>
      {groups.flatMap((group) =>
        group.memberProjects.map((member) => (
          <li key={`${member.environmentId}:${member.id}`}>{member.id}</li>
        )),
      )}
    </ul>
  );
}
function setup() {
  state.projects = [];
  state.serverConfigs = new Map();
}

describe("useSettingsProjectGroups native agent project", () => {
  it("hides the managed project at each environment's own root", async () => {
    setup();
    state.projects = [
      project(primaryId, "managed-primary", "AI Agents", "/work/primary/native-agents"),
      project(remoteId, "managed-remote", "AI Agents", "/srv/t3/native-agents"),
      project(primaryId, "repo", "Repo", "/work/repo"),
    ];
    state.serverConfigs = new Map([
      [primaryId, { nativeAgentWorkspaceRoot: "/work/primary/native-agents" }],
      [remoteId, { nativeAgentWorkspaceRoot: "/srv/t3/native-agents" }],
    ]);

    await using screen = await render(<Probe />);
    await vi.waitFor(() =>
      expect(
        [...screen.container.querySelectorAll("li")].map((item) => item.textContent).sort(),
      ).toEqual(["repo"]),
    );
  });

  it("keeps ordinary projects that share the managed title, basename, or another machine's root", async () => {
    setup();
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

    await using screen = await render(<Probe />);
    await vi.waitFor(() =>
      expect(
        [...screen.container.querySelectorAll("li")].map((item) => item.textContent).sort(),
      ).toEqual(["remote-same-path", "same-basename", "same-title"]),
    );
  });

  it("keeps every project when an environment does not publish a managed root", async () => {
    setup();
    state.projects = [project(primaryId, "older", "AI Agents", "/work/primary/native-agents")];
    state.serverConfigs = new Map([[primaryId, {}]]);

    await using screen = await render(<Probe />);
    await vi.waitFor(() =>
      expect(
        [...screen.container.querySelectorAll("li")].map((item) => item.textContent).sort(),
      ).toEqual(["older"]),
    );
  });
});
