import { findProjectByPath } from "@t3tools/client-runtime/state/projects";

import { useClientSettings } from "../../hooks/useSettings";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useServerConfigs } from "../../state/entities";

export function useSettingsProjectGroups() {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const genericProjects = projects.filter((project) => {
    const root = serverConfigs.get(project.environmentId)?.nativeAgentWorkspaceRoot;
    return root === undefined || findProjectByPath([project], root) === undefined;
  });
  // Read the grouping fields one by one: a selector that builds an object hands back a new
  // identity on every client settings write, which rebuilds every group and, through the
  // settings scope, re-renders every settings row.
  const sidebarProjectGroupingMode = useClientSettings(
    (settings) => settings.sidebarProjectGroupingMode,
  );
  const sidebarProjectGroupingOverrides = useClientSettings(
    (settings) => settings.sidebarProjectGroupingOverrides,
  );
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label]));
  return buildSidebarProjectSnapshots({
    projects: genericProjects,
    settings: { sidebarProjectGroupingMode, sidebarProjectGroupingOverrides },
    primaryEnvironmentId,
    resolveEnvironmentLabel: (id) => labels.get(id) ?? null,
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));
}
