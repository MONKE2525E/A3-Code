// @effect-diagnostics nodeBuiltinImport:off - inspects the route files on disk.
import * as NodeFS from "node:fs";
import { expect, it } from "vite-plus/test";

// Settings pages read SettingsScopeProvider, which only the _chat.settings layout supplies.
const STANDALONE_SETTINGS_REDIRECTS = new Set(["settings.grok-bots.tsx"]);

it("renders every settings page inside the settings layout", () => {
  const standalone = NodeFS.readdirSync(import.meta.dirname).filter(
    (file) =>
      file.startsWith("settings.") &&
      file.endsWith(".tsx") &&
      !STANDALONE_SETTINGS_REDIRECTS.has(file),
  );
  expect(standalone, `rename to _chat.${standalone[0] ?? "settings.<page>.tsx"}`).toEqual([]);
});
