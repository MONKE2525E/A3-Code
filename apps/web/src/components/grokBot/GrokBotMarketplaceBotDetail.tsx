import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, GrokBotMarketplaceTemplate } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { cn, randomUUID } from "~/lib/utils";
import {
  grokBotsImportMarketplaceTemplate,
  grokBotsMarketplaceTemplateQuery,
} from "~/state/grokBots";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { CreatorAvatar, ListingAvatar } from "./GrokBotMarketplaceAvatar";
import type { MarketplaceListing } from "./grokBotMarketplaceCatalog";
import { grokBotFailureMessage } from "./grokBotPresentation";

const TABS = ["instructions", "memories", "skills", "routines", "integrations"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, { readonly title: string; readonly hint: string }> = {
  instructions: { title: "Instructions", hint: "How this Bot should work" },
  memories: { title: "Memories", hint: "Facts it already knows" },
  skills: { title: "Skills", hint: "Playbooks it can run" },
  routines: { title: "Routines", hint: "Jobs that run on their own" },
  integrations: { title: "Integrations", hint: "Tools it can use" },
};

/** One bot template: its recipe preview and the import that creates the bot. */
export function MarketplaceBotDetail({
  environmentId,
  shareId,
  listing,
  onBack,
}: {
  readonly environmentId: EnvironmentId;
  readonly shareId: string;
  readonly listing?: MarketplaceListing;
  readonly onBack: () => void;
}) {
  const [tab, setTab] = useState<Tab>("instructions");
  const template = useEnvironmentQuery(
    grokBotsMarketplaceTemplateQuery({ environmentId, input: { shareId } }),
  );
  const recipe = template.data;
  const importing = useImportTemplate(environmentId, shareId, () => template.refresh());
  const creator = recipe?.creatorDisplayName || listing?.creatorName || "";
  const displayListing: MarketplaceListing = listing ?? {
    shareId,
    slug: shareId,
    name: recipe?.profile.name || "Shared Bot",
    description: "",
    category: "",
    categories: [],
    imageUrl: null,
    creatorName: creator,
    creatorPhotoUrl: null,
  };
  const counts: Record<Tab, number | null> = {
    instructions: null,
    memories: recipe?.memories.length ?? null,
    skills: recipe?.skills.length ?? null,
    routines: recipe?.routines.length ?? null,
    integrations: recipe?.plugins.length ?? null,
  };

  return (
    <div className="space-y-5">
      <Button size="sm" variant="ghost-muted" onClick={onBack}>
        <ArrowLeftIcon />
        Marketplace
      </Button>

      <header className="flex min-w-0 flex-wrap items-start gap-4">
        <ListingAvatar
          environmentId={environmentId}
          listing={
            // The import creates the bot with the recipe's look, so the preview follows it once loaded.
            recipe === null
              ? displayListing
              : {
                  ...displayListing,
                  ...(recipe.profile.avatarShape
                    ? { avatarShape: recipe.profile.avatarShape }
                    : {}),
                  ...(recipe.profile.avatarColor
                    ? { avatarColor: recipe.profile.avatarColor }
                    : {}),
                }
          }
          size="hero"
        />
        <div className="min-w-0 flex-1 space-y-1 pt-1">
          <h3 className="truncate text-lg font-medium text-foreground">
            {recipe?.profile.name || displayListing.name}
          </h3>
          <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
            <CreatorAvatar
              environmentId={environmentId}
              name={creator}
              photoUrl={displayListing.creatorPhotoUrl}
            />
            <span className="truncate">{creator ? `By ${creator}` : "Unknown creator"}</span>
          </p>
        </div>
        <Button
          className="shrink-0"
          disabled={recipe === null || !importing.allowed || importing.pending}
          onClick={() => recipe && void importing.run(recipe.expectedActiveVersion)}
        >
          {importing.pending ? <Spinner size="xs" /> : null}
          Import Bot
        </Button>
      </header>

      {displayListing.description ? (
        <p className="text-sm leading-6 text-foreground">{displayListing.description}</p>
      ) : null}
      {importing.error ? <p className="text-sm text-destructive">{importing.error}</p> : null}
      {recipe !== null && recipe.plugins.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Import creates the bot. Its integrations are not installed from here.
        </p>
      ) : null}

      <div className="grid gap-4 border-t pt-4 sm:grid-cols-[13rem_minmax(0,1fr)]">
        <div
          className="flex gap-1 overflow-x-auto sm:flex-col"
          role="group"
          aria-label="Template contents"
        >
          {TABS.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={tab === name}
              onClick={() => setTab(name)}
              className={cn(
                "shrink-0 rounded-lg px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none",
                tab === name ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
              )}
            >
              <span className="block text-sm font-medium">
                {TAB_LABELS[name].title}
                {counts[name] === null ? "" : ` (${counts[name]})`}
              </span>
              <span className="block text-xs text-muted-foreground">{TAB_LABELS[name].hint}</span>
            </button>
          ))}
        </div>

        <div className="min-h-40 min-w-0 rounded-xl border bg-card/40 p-4">
          {template.error ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">{template.error}</span>
              <Button size="sm" variant="outline" onClick={() => template.refresh()}>
                Retry
              </Button>
            </div>
          ) : recipe === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size="xs" />
              Loading template
            </div>
          ) : (
            <TabPanel tab={tab} recipe={recipe} />
          )}
        </div>
      </div>
    </div>
  );
}

// Survives leaving the detail view, so retrying an uncertain import targets the same bot instead of creating a second one.
const pendingAgentIds = new Map<string, string>();

function useImportTemplate(
  environmentId: EnvironmentId,
  shareId: string,
  refreshTemplate: () => void,
) {
  const navigate = useNavigate();
  const allowed = useAtomValue(grokBotsImportMarketplaceTemplate.permissionAtom(environmentId));
  const importTemplate = useAtomCommand(grokBotsImportMarketplaceTemplate, {
    reportFailure: false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (expectedActiveVersion: number) => {
    if (pending) return;
    const key = `${environmentId}:${shareId}`;
    const agentId = pendingAgentIds.get(key) ?? randomUUID();
    pendingAgentIds.set(key, agentId);
    setPending(true);
    setError(null);
    const result = await importTemplate({
      environmentId,
      input: { shareId, agentId, expectedActiveVersion },
    });
    setPending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      setError(grokBotFailureMessage(squashAtomCommandFailure(result)));
      // The template may have been republished, so the next attempt reads its current version.
      refreshTemplate();
      return;
    }
    pendingAgentIds.delete(key);
    // The new bot opens as a conversation, where any setup it still needs continues.
    void navigate({
      to: "/grok-bots/$botId",
      params: { botId: result.value.agentId },
      search: { environmentId },
    });
  };
  return { allowed, pending, error, run };
}

type Recipe = typeof GrokBotMarketplaceTemplate.Type;

function TabPanel({ tab, recipe }: { readonly tab: Tab; readonly recipe: Recipe }) {
  switch (tab) {
    case "instructions":
      return recipe.profile.description ? (
        <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
          {recipe.profile.description}
        </p>
      ) : (
        <EmptyNote text="This template has no instructions." />
      );
    case "memories":
      return recipe.memories.length === 0 ? (
        <EmptyNote text="No memories in this template." />
      ) : (
        <ul className="space-y-3">
          {recipe.memories.map((memory, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- Static recipe list with no stable id.
            <li key={index} className="space-y-1">
              <span className="text-xs text-muted-foreground">
                {memory.kind}
                {memory.createdAt ? ` · ${memory.createdAt}` : ""}
              </span>
              <p className="whitespace-pre-wrap text-sm leading-6">{memory.content}</p>
            </li>
          ))}
        </ul>
      );
    case "skills":
      return recipe.skills.length === 0 ? (
        <EmptyNote text="No skills in this template." />
      ) : (
        <ExpandableList
          items={recipe.skills.map((skill) => ({
            key: skill.name,
            title: skill.name,
            description: skill.description,
            content: skill.content,
          }))}
        />
      );
    case "routines":
      return recipe.routines.length === 0 ? (
        <EmptyNote text="No routines in this template." />
      ) : (
        <ExpandableList
          items={recipe.routines.map((routine) => ({
            key: routine.slug,
            title: routine.name,
            description: routine.description,
            content: routine.content,
          }))}
        />
      );
    case "integrations":
      return recipe.plugins.length === 0 ? (
        <EmptyNote text="No integrations in this template." />
      ) : (
        <ul className="space-y-2">
          {recipe.plugins.map((plugin) => (
            <li key={plugin.pluginId} className="space-y-0.5">
              <span className="block text-sm font-medium">{plugin.name}</span>
              {plugin.description ? (
                <span className="block text-xs leading-5 text-muted-foreground">
                  {plugin.description}
                </span>
              ) : null}
              <span className="block font-mono text-2xs text-muted-foreground">
                {plugin.pluginId}
              </span>
            </li>
          ))}
        </ul>
      );
  }
}

function ExpandableList({
  items,
}: {
  readonly items: readonly {
    readonly key: string;
    readonly title: string;
    readonly description: string;
    readonly content: string;
  }[];
}) {
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Static list; keys can repeat.
        <li key={`${item.key}-${index}`} className="rounded-lg border">
          <details className="group">
            <summary className="cursor-pointer list-none px-3 py-2.5">
              <span className="block text-sm font-medium">{item.title}</span>
              {item.description ? (
                <span className="block text-xs leading-5 text-muted-foreground">
                  {item.description}
                </span>
              ) : null}
            </summary>
            {item.content ? (
              <pre className="max-h-96 overflow-auto border-t px-3 py-2.5 font-mono text-xs leading-5 whitespace-pre-wrap break-words text-muted-foreground">
                {item.content}
              </pre>
            ) : null}
          </details>
        </li>
      ))}
    </ul>
  );
}

function EmptyNote({ text }: { readonly text: string }) {
  return <p className="text-sm text-muted-foreground">{text}</p>;
}
