import { findProjectByPath } from "@t3tools/client-runtime/state/projects";
import { useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useServerConfigs } from "../../state/entities";

/**
 * Settings uses the same logical projects as the sidebar, sorted by display name.
 * The managed native-agent project is left out before grouping, so it never joins a group.
 */
export function useSettingsProjectGroups() {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  return useMemo(() => {
    const labels = new Map(environments.map((entry) => [entry.environmentId, entry.label]));
    // Each environment names its own managed root, so match only that exact path on that
    // environment. A project with the same title or basename elsewhere stays visible.
    const genericProjects = projects.filter((project) => {
      const managedRoot = serverConfigs.get(project.environmentId)?.nativeAgentWorkspaceRoot;
      return managedRoot === undefined || findProjectByPath([project], managedRoot) === undefined;
    });
    return buildSidebarProjectSnapshots({
      projects: genericProjects,
      settings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (id) => labels.get(id) ?? null,
    }).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [environments, primaryEnvironmentId, projects, serverConfigs, settings]);
}
