import {
  GrokBotOrchestratorConfig,
  GrokBotStatus,
  type ServerProviderAuth,
} from "@t3tools/contracts";

type Bridge = Pick<
  typeof GrokBotStatus.Type,
  "installed" | "managed" | "sessionPresent" | "nativeAvailable"
>;
type Endpoint = (typeof GrokBotOrchestratorConfig.Type)["publicEndpointReadiness"];

export type GrokBotConnectionCopy = {
  readonly title: string;
  readonly description: string;
};

/**
 * Native reads and actions need only the Grok Bot desktop sign-in. Servers that predate
 * `nativeAvailable` report only the CLI session, so the CLI check stays the signal for them.
 */
export function grokBotNativeReady(bridge: Bridge | null | undefined): boolean {
  if (bridge === null || bridge === undefined) return false;
  return bridge.nativeAvailable ?? (bridge.installed && bridge.sessionPresent);
}

/** The native sign-in is the account of record when the server reports it. */
export function grokBotNativeSignedIn(bridge: Bridge | null | undefined): boolean {
  return bridge?.nativeAvailable ?? bridge?.sessionPresent === true;
}

export function grokBotCliCopy(bridge: Bridge | null | undefined): GrokBotConnectionCopy {
  if (bridge?.installed !== true && bridge?.nativeAvailable === true) {
    return {
      title: "CLI bridge",
      description:
        "Optional. Bots and the computer work without it. Creating and deleting bots need the bridge.",
    };
  }
  if (bridge?.installed !== true) {
    return {
      title: "CLI bridge",
      description: "Install the Grok Bot community bridge for this environment, then sign in.",
    };
  }
  return {
    title: "CLI bridge",
    description: bridge.managed ? "Installed for this environment." : "Installed on this computer.",
  };
}

export function grokBotAccountCopy(input: {
  readonly sessionPresent?: boolean | undefined;
  readonly email?: string | undefined;
  readonly plan?: string | undefined;
}): GrokBotConnectionCopy {
  if (input.sessionPresent !== true) {
    return {
      title: "Native account",
      description: "Open Grok Bot and sign in, then check again.",
    };
  }
  const email = input.email?.trim();
  const plan = input.plan?.trim();
  if (email && plan) {
    return { title: "Native account", description: `${email} · ${plan}` };
  }
  if (email) return { title: "Native account", description: email };
  if (plan) return { title: "Native account", description: `Signed in · ${plan}` };
  return { title: "Native account", description: "Signed in." };
}

/** Plan and email come from native GetMe / GetSandUsageStatus via provider auth. */
export function grokBotProviderAuthFields(auth: ServerProviderAuth | undefined): {
  readonly email?: string;
  readonly plan?: string;
} {
  if (auth?.status !== "authenticated") return {};
  const email = auth.email?.trim();
  const plan = auth.label?.trim();
  return {
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
  };
}

export function grokBotMcpCopy(endpoint: Endpoint | null | undefined): GrokBotConnectionCopy {
  if (endpoint?.ready === true) {
    return {
      title: "MCP endpoint",
      description: "Bots can reach this T3 Code server.",
    };
  }
  return {
    title: "MCP endpoint",
    description:
      endpoint?.reason ??
      "Bots cannot reach this T3 Code server yet. Pair or expose it under Settings → Connections.",
  };
}

export function grokBotSkillCopy(hasPrompt: boolean): GrokBotConnectionCopy {
  return hasPrompt
    ? {
        title: "Shared skill",
        // GrokBotSkillSetupPanel owns the install and MCP copy.
        description: "",
      }
    : {
        title: "Shared skill",
        description: "This server did not return a skill setup prompt.",
      };
}
