// @vitest-environment jsdom

import type { EnvironmentId, GrokBotSetupStatus } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ copy: vi.fn() }));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard: mocks.copy }));
vi.mock("~/state/grokBots", () => ({
  grokBotsOrchestratorSetup: { label: "setup", permissionAtom: () => null },
}));
vi.mock("~/state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./GrokBotSetupAuthorize", () => ({ GrokBotSetupAuthorize: () => null }));

import { GrokBotSkillSetupPanel } from "./GrokBotSkillSetupPanel";

const environmentId = "env-1" as EnvironmentId;
const prompt = "Install the shared skill.";

const status = (complete: boolean): GrokBotSetupStatus => ({
  phase: complete ? "complete" : "needs_setup",
  complete,
  primaryBot: { id: "bot-1", name: "Primary" },
  mcpUrl: null,
  terminalCommand: null,
  authorizationUrl: null,
  error: null,
  updatedAtMs: 0,
});

const panel = (complete: boolean) => (
  <GrokBotSkillSetupPanel
    environmentId={environmentId}
    prompt={prompt}
    setupStatus={status(complete)}
    refresh={() => {}}
    refreshing={false}
  />
);

function textOf(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

const buttons = (renderer: ReactTestRenderer) =>
  renderer.root.findAllByType("button").map((button) => textOf(button));

function press(renderer: ReactTestRenderer, name: string) {
  const button = renderer.root
    .findAllByType("button")
    .find((candidate) => textOf(candidate).includes(name));
  if (!button) throw new Error(`No button named ${name}`);
  return act(async () => button.props.onClick());
}

describe("GrokBotSkillSetupPanel manual install", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.copy.mockReset();
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("reveals the prompt from a button and keeps a selectable copy when copying fails", async () => {
    mocks.copy.mockResolvedValue(false);
    await act(async () => {
      renderer = create(panel(false));
    });
    expect(renderer!.root.findAllByType("details")).toHaveLength(0);
    expect(renderer!.root.findAllByType("textarea")).toHaveLength(0);

    await press(renderer!, "Install skill manually");
    expect(buttons(renderer!)).toContain("Hide manual install");

    await press(renderer!, "Copy shared skill prompt");
    const field = renderer!.root.findByType("textarea");
    expect(field.props.value).toBe(prompt);
    expect(field.props.readOnly).toBe(true);
  });

  it("closes the manual prompt once the install completes and offers it again as a reinstall", async () => {
    await act(async () => {
      renderer = create(panel(false));
    });
    await press(renderer!, "Install skill manually");
    expect(buttons(renderer!)).toContain("Copy shared skill prompt");

    await act(async () => renderer!.update(panel(true)));
    expect(buttons(renderer!)).not.toContain("Copy shared skill prompt");
    expect(buttons(renderer!)).toContain("Reinstall skill manually");

    await press(renderer!, "Reinstall skill manually");
    expect(buttons(renderer!)).toContain("Copy shared skill prompt");
  });
});
