// @vitest-environment jsdom
import { describe, expect, it } from "vite-plus/test";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { resolveShortcutCommand } from "./keybindings";

describe("remote computer keyboard ownership", () => {
  it("lets remote browser shortcuts reach noVNC while preserving app shortcuts elsewhere", () => {
    const panel = document.createElement("div");
    panel.setAttribute("data-grok-bot-computer", "");
    const canvas = document.createElement("canvas");
    panel.append(canvas);
    document.body.append(panel);
    const input = { key: "t", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
    const options = { platform: "Linux", context: { terminalOpen: true } };
    const bindings = compileResolvedKeybindingsConfig([{ key: "mod+t", command: "terminal.new" }]);
    expect(resolveShortcutCommand({ ...input, target: canvas }, bindings, options)).toBeNull();
    expect(
      resolveShortcutCommand({ ...input, target: document.body }, bindings, options),
    ).not.toBeNull();
    panel.remove();
  });
});
