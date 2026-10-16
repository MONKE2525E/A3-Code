import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import {
  MuseAgentSectionPage,
  type MuseAgentSectionId,
} from "../components/agents/MuseAgentFeaturesDialog";
import { MuseChatLoading } from "../components/agents/MuseAgentRouteConnection";
import { useSelectedGrokBotEnvironmentId } from "../components/grokBot/useGrokBotEnvironment";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { museAgentStatusQuery } from "../state/museAgent";
import { useEnvironmentQuery } from "../state/query";

const MUSE_SECTIONS = [
  "activity",
  "approvals",
  "chat",
  "routines",
  "subagents",
] as const satisfies ReadonlyArray<MuseAgentSectionId>;

function isMuseSection(value: string): value is MuseAgentSectionId {
  return MUSE_SECTIONS.some((entry) => entry === value);
}

function disconnected() {
  return (
    <Empty size="hero">
      <EmptyHeader>
        <EmptyTitle>Muse isn't connected</EmptyTitle>
        <EmptyDescription>Connect Muse in AI Agents to open this page.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
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
  if (environmentId === null) return disconnected();
  const providerInstanceId =
    status.data?.ready && status.data.provider ? status.data.provider.instanceId : null;
  // Retained ready data wins over isPending so a status refresh cannot unmount /muse/chat.
  if (providerInstanceId !== null) {
    return (
      <MuseAgentSectionPage
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        section={section}
      />
    );
  }
  if (status.isPending) {
    return section === "chat" ? (
      <div className="flex h-full min-h-0 flex-col">
        <MuseChatLoading />
      </div>
    ) : (
      <p
        role="status"
        className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground"
      >
        Loading Muse…
      </p>
    );
  }
  return disconnected();
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
