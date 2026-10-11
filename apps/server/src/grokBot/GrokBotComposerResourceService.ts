import {
  GROK_BOT_MANAGED_COMPOSER_SKILL_NAME,
  GrokBotComposerResourcesError,
  type GrokBotComposerBot,
  type GrokBotComposerConnector,
  type GrokBotComposerResources,
  type GrokBotComposerResourcesInput,
  type GrokBotComposerSkill,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Native from "./GrokBotNativeService.ts";
import { grokBotSkillChipName } from "@t3tools/shared/grokBotComposerRichText";

// Native payloads are decoded per entry: one malformed skill, bot, or plugin must not hide the rest.
type Rec = Readonly<Record<string, unknown>>;
const LooseRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodeRecord = Schema.decodeUnknownOption(LooseRecord);
const decodeRecords = (list: unknown): readonly Rec[] =>
  Array.isArray(list) ? list.flatMap((entry) => Option.toArray(decodeRecord(entry))) : [];
const recordsAt = (value: Rec, key: string) => decodeRecords(value[key]);
const text = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
};

const isManagedSkill = (name: string, id: string) =>
  name === GROK_BOT_MANAGED_COMPOSER_SKILL_NAME ||
  id === GROK_BOT_MANAGED_COMPOSER_SKILL_NAME ||
  id.endsWith(`/${GROK_BOT_MANAGED_COMPOSER_SKILL_NAME}`) ||
  id === `sand-workflow:${GROK_BOT_MANAGED_COMPOSER_SKILL_NAME}`;

export const parseComposerSkills = (
  entries: readonly unknown[],
): readonly GrokBotComposerSkill[] => {
  const skills: GrokBotComposerSkill[] = [];
  const seen = new Set<string>();
  for (const entry of decodeRecords(entries)) {
    const id = text(entry.id)?.trim() ?? "";
    const name = text(entry.name)?.trim() ?? "";
    if (id.length === 0 || name.length === 0 || isManagedSkill(name, id) || seen.has(id)) continue;
    seen.add(id);
    const origin = text(entry.source) === "workflow" ? "user" : "agent";
    const description = text(entry.description)?.trim();
    skills.push({
      id,
      name,
      origin,
      ...(description ? { description } : {}),
    });
  }
  return skills;
};

// Marketplace skill descriptors have names and source paths, not workflow IDs.
// Only explicit native IDs can be serialized as individual workflow references.
const pluginSkillEntries = (plugin: Rec): readonly Rec[] => recordsAt(plugin, "skills");

export const parseComposerBots = (
  currentBotId: string,
  agents: readonly unknown[],
): readonly GrokBotComposerBot[] =>
  decodeRecords(agents).flatMap((agent) => {
    const agentId = text(agent.agentId)?.trim() ?? "";
    if (agentId.length === 0 || agentId === currentBotId) return [];
    const client = Option.getOrUndefined(decodeRecord(agent.client));
    if (agent.hiddenFromSidebar === true || client?.hiddenFromSidebar === true) return [];
    const name = (text(agent.name) ?? text(agent.title) ?? agentId).trim();
    if (name.length === 0) return [];
    const avatarShape = text(agent.avatarShape);
    const avatarColor = text(agent.avatarColor);
    return [
      {
        id: agentId as GrokBotComposerBot["id"],
        name,
        ...(avatarShape ? { avatarShape } : {}),
        ...(avatarColor ? { avatarColor } : {}),
      },
    ];
  });

const PLUGIN_ID = /^\d{1,20}$/;

const connectorType = (value: unknown): GrokBotComposerConnector["connectorType"] => {
  const raw =
    typeof value === "number"
      ? value
      : (text(value) ?? "")
          .toLowerCase()
          .replace(/^grokbotconnectortype\./, "")
          .replace(/^connector_type_/, "");
  if (raw === 1 || raw === "1" || raw === "user") return "user";
  if (raw === 2 || raw === "2" || raw === "team") return "team";
  return "unspecified";
};

export const parseComposerConnectors = (
  entries: readonly unknown[],
): readonly GrokBotComposerConnector[] => {
  const connectors: GrokBotComposerConnector[] = [];
  const seen = new Set<string>();
  for (const entry of decodeRecords(entries)) {
    const pluginId = text(entry.pluginId)?.trim() ?? "";
    const name = (text(entry.name) ?? text(entry.displayName) ?? "").trim();
    if (!PLUGIN_ID.test(pluginId) || name.length === 0 || seen.has(pluginId)) continue;
    seen.add(pluginId);
    const displayName = text(entry.displayName)?.trim();
    const description = text(entry.description)?.trim();
    connectors.push({
      pluginId,
      name,
      connectorType: connectorType(entry.connectorType),
      ...(displayName && displayName.length > 0 && displayName !== name ? { displayName } : {}),
      ...(description && description.length > 0 ? { description } : {}),
    });
  }
  return connectors;
};

export class GrokBotComposerResourceService extends Context.Service<
  GrokBotComposerResourceService,
  {
    readonly list: (
      input: GrokBotComposerResourcesInput,
    ) => Effect.Effect<GrokBotComposerResources, GrokBotComposerResourcesError>;
  }
>()("t3/grokBot/GrokBotComposerResourceService") {}

const make = Effect.gen(function* () {
  const native = yield* Native.GrokBotNativeService;
  const account = native.accountBinding.pipe(
    Effect.mapError(() => new GrokBotComposerResourcesError({ reason: "provider_not_ready" })),
  );
  const request = (
    binding: string,
    method: Native.NativeRuntimeMethod,
    input: object,
  ): Effect.Effect<unknown, GrokBotComposerResourcesError> =>
    native
      .runtimeRequest(binding, method, input)
      .pipe(Effect.mapError(() => new GrokBotComposerResourcesError({ reason: "unavailable" })));
  const decoded = <A>(value: Option.Option<A>) =>
    Effect.fromOption(value).pipe(
      Effect.mapError(() => new GrokBotComposerResourcesError({ reason: "unavailable" })),
    );
  const sameAccount = (binding: string) =>
    account.pipe(
      Effect.flatMap((current) =>
        current === binding
          ? Effect.void
          : Effect.fail(new GrokBotComposerResourcesError({ reason: "account_changed" })),
      ),
    );

  const requestRecord = (binding: string, method: Native.NativeRuntimeMethod, input: object) =>
    request(binding, method, input).pipe(Effect.flatMap((value) => decoded(decodeRecord(value))));

  const listBotSkills = (binding: string, botId: string) =>
    request(binding, "ListGrokBotAgentSkills", { agentId: botId }).pipe(
      Effect.flatMap((value) => decoded(decodeRecord(value))),
      Effect.map((result) => parseComposerSkills(recordsAt(result, "skills"))),
    );

  const list = Effect.fn("GrokBotComposerResourceService.list")(function* (
    input: GrokBotComposerResourcesInput,
  ) {
    const binding = yield* account;
    const roster = yield* requestRecord(binding, "ListGrokBotAgents", {});
    const agents = recordsAt(roster, "agents");
    // These catalogs are independent; a failed section must not hide the others.
    const [current, library, plugins, installed] = yield* Effect.all(
      [
        listBotSkills(binding, input.botId).pipe(Effect.option),
        native.gatewaySkills(binding, input.botId).pipe(
          Effect.map((value) =>
            parseComposerSkills(
              Array.isArray(value)
                ? value
                : recordsAt(
                    Option.getOrElse(decodeRecord(value), () => ({})),
                    "workflows",
                  ),
            ),
          ),
          Effect.option,
        ),
        requestRecord(binding, "GetGrokBotAgentPlugins", {
          agentId: input.botId,
          includeMcpConfig: false,
        }).pipe(Effect.option),
        native
          .marketplaceRequest(binding, {
            method: "GetEffectiveUserPlugins",
            input: { excludeConfiguredVariables: true },
          })
          .pipe(
            Effect.flatMap((value) => decoded(decodeRecord(value))),
            Effect.option,
          ),
      ],
      { concurrency: 4 },
    );
    if (
      Option.isNone(current) &&
      Option.isNone(library) &&
      Option.isNone(plugins) &&
      Option.isNone(installed)
    ) {
      return yield* new GrokBotComposerResourcesError({ reason: "unavailable" });
    }
    const installedRecords = Option.isSome(installed)
      ? recordsAt(installed.value, "plugins").flatMap((entry) => {
          const plugin = Option.getOrUndefined(decodeRecord(entry.plugin));
          return plugin && entry.isEnabled !== false && plugin.isDeprecated !== true
            ? [
                {
                  ...plugin,
                  pluginId: plugin.id,
                  connectorType:
                    entry.installMode === "EFFECTIVE_PLUGIN_INSTALL_MODE_TEAM" ? "team" : "user",
                },
              ]
            : [];
        })
      : [];
    const pluginRecords = [
      ...(Option.isSome(plugins) ? recordsAt(plugins.value, "plugins") : []),
      ...installedRecords,
    ];
    const skills = [...Option.getOrElse(library, () => [])];
    const seen = new Set(skills.map((skill) => skill.id));
    for (const skill of Option.getOrElse(current, () => [])) {
      if (seen.has(skill.id)) continue;
      seen.add(skill.id);
      skills.push(skill);
    }
    for (const plugin of pluginRecords) {
      for (const skill of parseComposerSkills(pluginSkillEntries(plugin))) {
        if (seen.has(skill.id)) continue;
        seen.add(skill.id);
        skills.push(skill);
      }
    }
    const others = yield* Effect.forEach(
      agents.flatMap((agent) => {
        const id = text(agent.agentId)?.trim() ?? "";
        return id && id !== input.botId ? [id] : [];
      }),
      (id) => listBotSkills(binding, id).pipe(Effect.option),
      { concurrency: 4 },
    );
    for (const other of others) {
      if (Option.isNone(other)) continue;
      for (const skill of other.value) {
        if (skill.origin !== "user" || seen.has(skill.id)) continue;
        seen.add(skill.id);
        skills.push(skill);
      }
    }
    yield* sameAccount(binding);
    const usedChipNames = new Set<string>();
    const mentionableSkills = skills.map((skill) => {
      const base = grokBotSkillChipName(skill);
      let chipName = base;
      let suffix = 2;
      while (usedChipNames.has(chipName.toLowerCase())) chipName = `${base}-${suffix++}`;
      usedChipNames.add(chipName.toLowerCase());
      return chipName === base ? skill : { ...skill, chipName };
    });
    return {
      skills: mentionableSkills,
      bots: parseComposerBots(input.botId, agents),
      connectors: parseComposerConnectors(pluginRecords),
    };
  });

  return GrokBotComposerResourceService.of({ list });
});

export const layer = Layer.effect(GrokBotComposerResourceService, make);
