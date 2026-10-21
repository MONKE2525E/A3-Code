import type { ComponentProps } from "react";
import { act, render, type Screen } from "../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
} from "@t3tools/shared/keybindings";

import { RightPanelTabs } from "./RightPanelTabs";

vi.mock("/src/hooks/useTheme.ts", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("/src/browser/browserDefaults.ts", () => ({
  useBrowserDefaults: () => ({ profiles: [] }),
}));

const { addFiles } = vi.hoisted(() => ({ addFiles: vi.fn() }));
const noop = () => undefined;
function setup() {
  addFiles.mockClear();
}

async function renderPanel(
  screen: Screen,
  overrides: Partial<ComponentProps<typeof RightPanelTabs>> = {},
) {
  await act(() =>
    screen.rerender(
      <RightPanelTabs
        mode="inline"
        open
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        getShortcutContext={() => ({
          terminalFocus: false,
          terminalOpen: false,
          previewFocus: false,
          previewOpen: false,
          isWeb: true,
          isDesktop: false,
        })}
        surfaces={[]}
        environmentId={null}
        activeSurfaceId={null}
        pendingSurfaceIds={new Set()}
        previewSessions={{}}
        desktopByTabId={{}}
        terminalLabelsById={new Map()}
        onActivate={noop}
        onCloseSurface={noop}
        onCloseOtherSurfaces={noop}
        onCloseSurfacesToRight={noop}
        onCloseAllSurfaces={noop}
        onCopyFilePath={noop}
        onAddBrowser={noop}
        onAddBrowserInProfile={noop}
        onAddTerminal={noop}
        onAddDiff={noop}
        onAddFiles={addFiles}
        onAddPullRequest={noop}
        onAddPullRequests={noop}
        onAddDevice={noop}
        browserAvailable={false}
        terminalAvailable={false}
        diffAvailable={false}
        filesAvailable
        pullRequestAvailable={false}
        pullRequestsAvailable={false}
        deviceAvailable={false}
        {...overrides}
      >
        content
      </RightPanelTabs>,
    ),
  );
}

async function press(key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  await act(() => (document.activeElement ?? document.body).dispatchEvent(event));
  return event;
}

describe("right panel new-tab shortcut", () => {
  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "opens the menu on %s and chooses a tab",
    async (platform) => {
      setup();
      using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      await using screen = await render(<></>);
      _platform.mockReturnValue(platform);
      await renderPanel(screen);
      const event = await press(
        "t",
        platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true },
      );
      expect(event.defaultPrevented).toBe(true);
      await vi.waitFor(() =>
        expect(document.querySelector('[role="menu"]')?.textContent).toContain(
          "Linked pull requests",
        ),
      );
      await vi.waitFor(() =>
        expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull(),
      );
      expect(
        (
          await press("t", {
            metaKey: platform === "MacIntel",
            ctrlKey: platform !== "MacIntel",
            repeat: true,
          })
        ).defaultPrevented,
      ).toBe(true);
      await press("f");
      expect(addFiles).toHaveBeenCalledOnce();
      await vi.waitFor(() =>
        expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull(),
      );
    },
  );

  it("leaves the shortcut alone while the mounted panel is closed", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using screen = await render(<></>);
    await renderPanel(screen, { open: false });
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    await vi.waitFor(() =>
      expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull(),
    );
  });

  it.each(["Win32", "Linux x86_64"])(
    "leaves Ctrl+T for the focused terminal on %s",
    async (platform) => {
      setup();
      using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      await using screen = await render(<></>);
      const { container } = screen;
      _platform.mockReturnValue(platform);
      await renderPanel(screen, {
        getShortcutContext: () => ({
          terminalFocus: true,
          terminalOpen: true,
          previewFocus: false,
          previewOpen: false,
          isWeb: true,
          isDesktop: false,
        }),
      });
      const terminal = document.createElement("textarea");
      const onKeyDown = vi.fn();
      terminal.addEventListener("keydown", onKeyDown);
      container.append(terminal);
      await act(() => terminal.focus());
      const event = await press("t", { ctrlKey: true });
      expect(event.defaultPrevented).toBe(false);
      expect(onKeyDown).toHaveBeenCalledWith(event);
      await vi.waitFor(() =>
        expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull(),
      );
    },
  );

  it("uses a custom binding from a text field and closes on Escape", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using screen = await render(<></>);
    const { container } = screen;
    const input = document.createElement("input");
    await renderPanel(screen, {
      keybindings: compileResolvedKeybindingsConfig([{ key: "mod+y", command: "rightPanel.new" }]),
    });
    container.append(input);
    input.focus();
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    await press("y", { metaKey: true });
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
    await press("Escape");
    await vi.waitFor(() =>
      expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull(),
    );
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        container.querySelector('[aria-label="Add panel surface"]'),
      ),
    );
    input.remove();
  });

  it("does not open over another popup or during text composition", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using screen = await render(<></>);
    const { container } = screen;
    await renderPanel(screen);
    expect((await press("t", { metaKey: true, isComposing: true })).defaultPrevented).toBe(false);
    const dialog = document.createElement("div");
    dialog.dataset.slot = "dialog-popup";
    dialog.dataset.open = "";
    container.append(dialog);
    expect((await press("t", { metaKey: true })).defaultPrevented).toBe(false);
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  });

  it("supports arrow keys with an existing tab in sheet mode and clears the menu on close", async () => {
    setup();
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using screen = await render(<></>);
    const panel = {
      mode: "sheet" as const,
      surfaces: [{ id: "files" as const, kind: "files" as const }],
    };
    await renderPanel(screen, panel);
    await press("t", { metaKey: true });
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    await vi.waitFor(() => expect(document.activeElement?.textContent).toContain("Files"));
    await press("Enter");
    expect(addFiles).toHaveBeenCalledOnce();
    await press("t", { metaKey: true });
    await renderPanel(screen, { ...panel, open: false });
    await vi.waitFor(() =>
      expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull(),
    );
    await renderPanel(screen, panel);
    await vi.waitFor(() =>
      expect(document.querySelector('[role="menu"]:not([data-closed])')).toBeNull(),
    );
  });
});

it("opens Muse from the native agent surface launcher with its keyboard shortcut", async () => {
  setup();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  await using screen = await render(<></>);
  const { container } = screen;
  const openMuse = vi.fn();
  await renderPanel(screen, { nativeAgentThread: true, onAddMuseFeatures: openMuse });
  await vi.waitFor(() =>
    expect(
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Muse"),
      ),
    ).toBe(true),
  );
  await press("u");
  expect(openMuse).toHaveBeenCalledOnce();
  await renderPanel(screen, { nativeAgentThread: true });
  await press("u");
  expect(openMuse).toHaveBeenCalledOnce();
});
