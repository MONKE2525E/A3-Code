import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { MuseAgentSectionPage } from "../components/agents/MuseAgentFeaturesDialog";
import { useSelectedGrokBotEnvironmentId } from "../components/grokBot/useGrokBotEnvironment";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { museAgentStatusQuery } from "../state/museAgent";
import { useEnvironmentQuery } from "../state/query";

const MUSE_SECTIONS = ["activity", "approvals"] as const;
type MuseSection = (typeof MUSE_SECTIONS)[number];

function isMuseSection(value: string): value is MuseSection {
  return MUSE_SECTIONS.some((entry) => entry === value);
}

function MuseSectionRoute() {
  const { section } = Route.useParams();
  const environmentId = useSelectedGrokBotEnvironmentId();
  const status = useEnvironmentQuery(
    environmentId === null ? null : museAgentStatusQuery({ environmentId, input: {} }),
  );
  if (!isMuseSection(section)) {
    return (
      <Empty size="hero">
        <EmptyHeader>
          <EmptyTitle>Not a Muse page</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  const providerInstanceId =
    status.data?.ready && status.data.provider ? status.data.provider.instanceId : null;
  if (environmentId === null || providerInstanceId === null) {
    return (
      <Empty size="hero">
        <EmptyHeader>
          <EmptyTitle>Muse isn't connected</EmptyTitle>
          <EmptyDescription>Connect Muse in AI Agents to open this page.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <MuseAgentSectionPage
      environmentId={environmentId}
      providerInstanceId={providerInstanceId}
      section={section}
    />
  );
}

function validateMuseSectionSearch(raw: Record<string, unknown>): {
  readonly environmentId?: EnvironmentId;
} {
  return typeof raw.environmentId === "string" && raw.environmentId.trim().length > 0
    ? { environmentId: EnvironmentId.make(raw.environmentId) }
    : {};
}

export const Route = createFileRoute("/_chat/muse/$section")({
  validateSearch: validateMuseSectionSearch,
  component: MuseSectionRoute,
});
