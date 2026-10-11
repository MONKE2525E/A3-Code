import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  compareGrokBots,
  grokBotLegacySettingsRedirect,
  environmentChangeSearch,
  grokBotSettingsDestinationSearch,
  providerSelectionSearch,
  grokBotSurfaceKey,
  isGrokBotProviderSelected,
  settingsSearchResultSearch,
  partitionGrokBotRoster,
  resolveGrokBotAvatarColor,
  resolveGrokBotAvatarKind,
  resolveGrokBotSelectedEnvironment,
  resolveGrokBotSettingsEnvironment,
  retainGrokBotSettingsBotIdSearch,
  sortGrokBotsForEditor,
  validateGrokBotConversationSearch,
  validateGrokBotSettingsSearch,
} from "./grokBotPresentation";
import { GROK_BOT_PICKER_SHAPES, GROK_BOT_UNKNOWN_SHAPE_KINDS } from "./grokBotAvatarShapes";

function bot(partial: {
  id: string;
  name: string;
  featured?: boolean;
  hidden?: boolean;
  pinned?: boolean;
}) {
  return {
    id: partial.id,
    name: partial.name,
    label: "",
    description: "",
    avatarShape: "blob",
    avatarColor: "#22c55e",
    notificationEnabled: false,
    hidden: partial.hidden ?? false,
    pinned: partial.pinned ?? false,
    featured: partial.featured ?? false,
    pullRequests: [],
  };
}

describe("partitionGrokBotRoster", () => {
  it("puts pinned bots in tiles, the main bot first, and keeps hidden bots out", () => {
    const roster = partitionGrokBotRoster([
      bot({ id: "a", name: "Alpha", pinned: true }),
      bot({ id: "b", name: "Beta" }),
      bot({ id: "c", name: "Hidden", hidden: true, pinned: true }),
      bot({ id: "d", name: "Main", pinned: true, featured: true }),
    ]);
    expect(roster.pinned.map((entry) => entry.id)).toEqual(["d", "a"]);
    expect(roster.rows.map((entry) => entry.id)).toEqual(["b"]);
  });
});

describe("sortGrokBotsForEditor", () => {
  it("orders the main bot first, then name", () => {
    const sorted = sortGrokBotsForEditor([
      bot({ id: "c", name: "Charlie" }),
      bot({ id: "a", name: "Alpha" }),
      bot({ id: "b", name: "Bravo", featured: true }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["b", "a", "c"]);
  });
});

describe("compareGrokBots", () => {
  it("puts the main bot first", () => {
    expect(
      compareGrokBots(bot({ id: "a", name: "A" }), bot({ id: "b", name: "B", featured: true })),
    ).toBe(1);
  });
});

describe("grokBotSettingsDestinationSearch", () => {
  it("writes the clicked environment onto the settings machine axis", () => {
    expect(
      grokBotSettingsDestinationSearch({
        environmentId: EnvironmentId.make("env-bot"),
        botId: "dr-chicken",
      }),
    ).toEqual({
      provider: "grok-bot",
      machine: "env-bot",
      botId: "dr-chicken",
    });
  });

  it("omits a machine when the destination has no environment", () => {
    expect(grokBotSettingsDestinationSearch({ botId: "dr-chicken" })).toEqual({
      provider: "grok-bot",
      botId: "dr-chicken",
    });
  });

  it("writes the persistent intent even without a bot", () => {
    expect(grokBotSettingsDestinationSearch({})).toEqual({ provider: "grok-bot" });
  });
});

describe("retainGrokBotSettingsBotIdSearch", () => {
  it("keeps the selected bot when the settings scope changes", () => {
    expect(retainGrokBotSettingsBotIdSearch({ botId: "dr-chicken" }, {})).toEqual({
      botId: "dr-chicken",
    });
  });

  it("lets an explicit bot destination replace the previous bot", () => {
    expect(
      retainGrokBotSettingsBotIdSearch({ botId: "dr-chicken" }, { botId: "other-bot" }),
    ).toEqual({ botId: "other-bot" });
  });
});

describe("resolveGrokBotSettingsEnvironment", () => {
  const connected = ["env-a", "env-b"];

  it("uses the scoped environment when it is connected", () => {
    expect(
      resolveGrokBotSettingsEnvironment({
        scopeKind: "environment",
        scopeEnvironmentId: "env-b",
        connectedEnvironmentIds: connected,
      }),
    ).toEqual({ kind: "environment", environmentId: "env-b" });
  });

  it("honors a disconnected destination instead of another connected account", () => {
    expect(
      resolveGrokBotSettingsEnvironment({
        scopeKind: "environment",
        scopeEnvironmentId: "env-offline",
        connectedEnvironmentIds: connected,
      }),
    ).toEqual({ kind: "disconnected", environmentId: "env-offline" });
  });

  it("does not pick the first connected account for All environments", () => {
    expect(
      resolveGrokBotSettingsEnvironment({
        scopeKind: "all",
        connectedEnvironmentIds: connected,
      }),
    ).toEqual({ kind: "choose-environment" });
  });

  it("asks to connect when no environment is available", () => {
    expect(
      resolveGrokBotSettingsEnvironment({
        scopeKind: "all",
        connectedEnvironmentIds: [],
      }),
    ).toEqual({ kind: "no-environment" });
  });
});

describe("resolveGrokBotSelectedEnvironment", () => {
  const connected = ["env-a", "env-b"];

  it("uses the selected environment when it is connected", () => {
    expect(
      resolveGrokBotSelectedEnvironment({
        selectedEnvironmentId: EnvironmentId.make("env-b"),
        connectedEnvironmentIds: connected,
      }),
    ).toEqual({ kind: "environment", environmentId: "env-b" });
  });

  it("keeps an explicit disconnected destination instead of another connected account", () => {
    expect(
      resolveGrokBotSelectedEnvironment({
        selectedEnvironmentId: EnvironmentId.make("missing-environment"),
        connectedEnvironmentIds: connected,
      }),
    ).toEqual({ kind: "disconnected", environmentId: "missing-environment" });
  });

  it("does not pick a connected account when no environment is selected", () => {
    expect(
      resolveGrokBotSelectedEnvironment({
        selectedEnvironmentId: null,
        connectedEnvironmentIds: connected,
      }),
    ).toEqual({ kind: "no-environment" });
  });
});

describe("grokBotSurfaceKey", () => {
  it("distinguishes the same bot id on two environments", () => {
    expect(grokBotSurfaceKey("env-a", "shared-bot")).not.toEqual(
      grokBotSurfaceKey("env-b", "shared-bot"),
    );
  });
});

describe("avatar look resolution", () => {
  it("keeps shape and color names the Grok Bot app draws", () => {
    expect(resolveGrokBotAvatarKind("sparkle", "dr-chicken")).toBe("sparkle");
    expect(resolveGrokBotAvatarColor("violet", "dr-chicken")).toBe("violet");
  });

  it("does not map legacy names onto other shapes", () => {
    expect(resolveGrokBotAvatarKind("triangle", "bot-a")).toBe("tablet");
    expect(resolveGrokBotAvatarColor("purple", "bot-a")).toBe("orange");
  });

  it("chooses an unknown shape from the bot id, matching the Grok Bot app", () => {
    expect(resolveGrokBotAvatarKind("not-a-shape", "dr-chicken")).toBe("teardrop");
    expect(resolveGrokBotAvatarKind("not-a-shape", "bot-a")).toBe("tablet");
    expect(GROK_BOT_UNKNOWN_SHAPE_KINDS).toContain(resolveGrokBotAvatarKind("x", "anything"));
  });

  it("chooses an unknown color from the bot id, never black", () => {
    expect(resolveGrokBotAvatarColor("not-a-color", "dr-chicken")).toBe("red");
    expect(resolveGrokBotAvatarColor("not-a-color", "bot-a")).toBe("orange");
    expect(resolveGrokBotAvatarColor("not-a-color", "sol")).not.toBe("black");
  });
});

describe("avatar picker", () => {
  it("offers the thirteen shapes of the Grok Bot character editor", () => {
    expect(GROK_BOT_PICKER_SHAPES).toHaveLength(13);
    expect(GROK_BOT_PICKER_SHAPES).toContain("house");
    expect(GROK_BOT_PICKER_SHAPES).toContain("hex");
  });
});

describe("validateGrokBotConversationSearch", () => {
  it("keeps a selected environment identity", () => {
    expect(validateGrokBotConversationSearch({ environmentId: "env-1" })).toEqual({
      environmentId: EnvironmentId.make("env-1"),
    });
    expect(validateGrokBotConversationSearch({})).toEqual({});
  });
});

describe("validateGrokBotSettingsSearch", () => {
  it("keeps a selected bot", () => {
    expect(validateGrokBotSettingsSearch({ botId: "dr-chicken" })).toEqual({
      provider: "grok-bot",
      botId: "dr-chicken",
    });
    expect(validateGrokBotSettingsSearch({ provider: "grok-bot" })).toEqual({
      provider: "grok-bot",
    });
    expect(validateGrokBotSettingsSearch({ provider: "codex" })).toEqual({});
    expect(validateGrokBotSettingsSearch({})).toEqual({});
  });
});

describe("isGrokBotProviderSelected", () => {
  const base = {
    instanceId: undefined,
    instanceDriver: undefined,
    botId: undefined,
    provider: undefined,
    searchTargetId: null,
    grokBotDriver: "grok-bot",
  };
  it("selects Grok Bot for a bot link or search target without an instance", () => {
    expect(isGrokBotProviderSelected({ ...base, botId: "b1" })).toBe(true);
    expect(isGrokBotProviderSelected({ ...base, searchTargetId: "grok-bots-editor" })).toBe(true);
    expect(isGrokBotProviderSelected(base)).toBe(false);
  });
  it("selects Grok Bot from the persistent intent after the target hash is cleared", () => {
    expect(isGrokBotProviderSelected({ ...base, provider: "grok-bot" })).toBe(true);
  });
  it("lets a standard provider win over a stale intent", () => {
    expect(
      isGrokBotProviderSelected({
        ...base,
        provider: "grok-bot",
        instanceId: "codex",
        instanceDriver: "codex",
      }),
    ).toBe(false);
  });
  it("lets an explicit instance win over a bot id", () => {
    expect(
      isGrokBotProviderSelected({
        ...base,
        instanceId: "codex",
        instanceDriver: "codex",
        botId: "b1",
        searchTargetId: "grok-bots-editor",
      }),
    ).toBe(false);
    expect(
      isGrokBotProviderSelected({ ...base, instanceId: "grok-bot", instanceDriver: "grok-bot" }),
    ).toBe(true);
  });
});

describe("account-bound Grok Bot instance", () => {
  it("is selected by its real instance id once its driver is known", () => {
    expect(
      isGrokBotProviderSelected({
        instanceId: "grok-bot-86778c829250337927602dbb67889af4",
        instanceDriver: "grok-bot",
        botId: undefined,
        provider: undefined,
        searchTargetId: null,
        grokBotDriver: "grok-bot",
      }),
    ).toBe(true);
  });
});

describe("grokBotLegacySettingsRedirect", () => {
  it("drops a stale Codex instance and keeps machine and bot, defaulting the hash", () => {
    expect(
      grokBotLegacySettingsRedirect({
        previousSearch: { instanceId: "codex", machine: "env-1" },
        search: { botId: "b1" },
        hash: "",
      }),
    ).toEqual({
      search: { machine: "env-1", botId: "b1", provider: "grok-bot" },
      hash: "grok-bots-editor",
    });
  });
  it("drops an instance carried by the incoming search too", () => {
    expect(
      grokBotLegacySettingsRedirect({
        previousSearch: {},
        search: { botId: "b1", instanceId: "codex" } as never,
        hash: "",
      }).search,
    ).toEqual({ botId: "b1", provider: "grok-bot" });
  });
  it("keeps an explicit hash", () => {
    expect(
      grokBotLegacySettingsRedirect({ previousSearch: {}, search: {}, hash: "grok-bots-pinned" })
        .hash,
    ).toBe("grok-bots-pinned");
  });
});

describe("providerSelectionSearch", () => {
  it("clears the intent and stale bot when a standard provider is picked", () => {
    expect(
      providerSelectionSearch(
        { machine: "env-1", provider: "grok-bot", botId: "b1" },
        { instanceId: "codex", isGrokBot: false },
      ),
    ).toEqual({ machine: "env-1", instanceId: "codex" });
  });
  it("keeps the intent and bot when the Grok Bot instance is picked", () => {
    expect(
      providerSelectionSearch(
        { machine: "env-1", botId: "b1" },
        { instanceId: "grok-bot-abc", isGrokBot: true },
      ),
    ).toEqual({ machine: "env-1", botId: "b1", provider: "grok-bot", instanceId: "grok-bot-abc" });
  });
});

describe("environmentChangeSearch", () => {
  it("keeps only the intent when Grok Bot is selected", () => {
    expect(
      environmentChangeSearch({ machine: "env-2" }, { provider: "grok-bot", botId: "b1" }),
    ).toEqual({ machine: "env-2", provider: "grok-bot" });
  });
  it("adds nothing for a standard provider", () => {
    expect(environmentChangeSearch({ machine: "env-2" }, {})).toEqual({ machine: "env-2" });
  });
  it("keeps the intent for a selected Grok Bot instance without a provider query", () => {
    expect(
      environmentChangeSearch(
        { machine: "env-2" },
        { instanceId: "grok-bot-abc", instanceDriver: "grok-bot" },
      ),
    ).toEqual({ machine: "env-2", provider: "grok-bot" });
  });
  it("keeps the intent when the source machine is absent and the query names only the intent", () => {
    // No resolved environment means no driver is known, so only the query can carry the selection.
    expect(environmentChangeSearch({ machine: "env-2" }, { provider: "grok-bot" })).toEqual({
      machine: "env-2",
      provider: "grok-bot",
    });
  });
  it("drops an unresolvable instance when the source machine is absent", () => {
    expect(environmentChangeSearch({ machine: "env-2" }, { instanceId: "grok-bot-abc" })).toEqual({
      machine: "env-2",
    });
  });
  it("lets an explicit Codex instance beat a stale intent", () => {
    expect(
      environmentChangeSearch(
        { machine: "env-2" },
        { provider: "grok-bot", instanceId: "codex", instanceDriver: "codex" },
      ),
    ).toEqual({ machine: "env-2" });
  });
});

describe("settingsSearchResultSearch", () => {
  it.each(["grok-bots", "grok-bots-bridge", "grok-bots-editor", "grok-bots-computer"])(
    "selects Grok Bot and drops a stale instance for %s",
    (id) => {
      expect(
        settingsSearchResultSearch(id, { machine: "env-1", instanceId: "codex", botId: "b1" }),
      ).toEqual({ machine: "env-1", botId: "b1", provider: "grok-bot" });
    },
  );
  it("leaves other results untouched", () => {
    const previous = { machine: "env-1", instanceId: "codex" };
    expect(settingsSearchResultSearch("providers", previous)).toBe(previous);
  });
});
