import { EnvironmentId, type GrokBotSetupStatus } from "@t3tools/contracts";
import { act, fakeTimers, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ copy: vi.fn(), send: vi.fn() }));

vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("/src/hooks/useCopyToClipboard.ts", () => ({ writeTextToClipboard: mocks.copy }));
vi.mock("/src/state/grokBots.ts", () => ({
  grokBotsOrchestratorSetup: { label: "setup", permissionAtom: () => null },
}));
vi.mock("/src/state/session.ts", () => ({ useEnvironmentScope: () => true }));
vi.mock("/src/state/use-atom-command.ts", () => ({ useAtomCommand: () => mocks.send }));
vi.mock("/src/components/grokBot/GrokBotSetupAuthorize.tsx", () => ({
  GrokBotSetupAuthorize: () => null,
}));

import { GrokBotSkillSetupPanel } from "./GrokBotSkillSetupPanel";

const environmentId = EnvironmentId.make("env-1");
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

function setup() {
  mocks.copy.mockReset();
  mocks.send.mockReset();
}

describe("GrokBotSkillSetupPanel manual install", () => {
  it("rechecks a failed status read without resending and stops checking after recovery", async () => {
    setup();
    // The polling effect reads timers at mount, so install the clock first.
    using _timers = fakeTimers();
    const refresh = vi.fn();
    const props = { environmentId, prompt, refresh, refreshing: false };
    await using screen = await render(
      <GrokBotSkillSetupPanel
        {...props}
        setupStatus={{ ...status(false), phase: "failed", retryable: true }}
      />,
    );
    await act(() => vi.advanceTimersByTime(10_000));
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(mocks.send).not.toHaveBeenCalled();
    await screen.rerender(<GrokBotSkillSetupPanel {...props} setupStatus={status(true)} />);
    await act(() => vi.advanceTimersByTime(10_000));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("reveals the prompt from a button and keeps a selectable copy when copying fails", async () => {
    setup();
    mocks.copy.mockResolvedValue(false);
    await using screen = await render(panel(false));
    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Install skill manually" }).click();
    await expect.element(screen.getByRole("button", { name: "Hide manual install" })).toBeVisible();
    await screen.getByRole("button", { name: "Copy shared skill prompt" }).click();
    await expect.element(screen.getByRole("textbox")).toHaveValue(prompt);
    await expect.element(screen.getByRole("textbox")).toHaveAttribute("readonly");
  });

  it("closes the manual prompt once the install completes and offers it again as a reinstall", async () => {
    setup();
    await using screen = await render(panel(false));
    await screen.getByRole("button", { name: "Install skill manually" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Copy shared skill prompt" }))
      .toBeVisible();
    await screen.rerender(panel(true));
    await expect
      .element(screen.getByRole("button", { name: "Copy shared skill prompt" }))
      .not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Reinstall skill manually" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Copy shared skill prompt" }))
      .toBeVisible();
  });
});
