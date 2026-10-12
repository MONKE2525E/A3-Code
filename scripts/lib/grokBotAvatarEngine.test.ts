import { describe, expect, it } from "vite-plus/test";
import { createGrokBotAvatarModule, extractGrokBotAvatarRenderer } from "./grokBotAvatarEngine.ts";

const source = `// Locally extracted source
import * as k from "react";
import * as M from "react/jsx-runtime";
const renderer = (props) => M.jsx("span", { children: k.version + props.label });
const fill = "green";
const appearance = (value) => value;
export { appearance as bodyForShape, renderer as BotRenderer, fill as DEFAULT_FILL, appearance as createAppearance, appearance as inkForColor, appearance as inkForTheme, appearance as recipeByName };
`;

describe("local Grok Bot module adapter", () => {
  it("uses the caller's React and JSX runtime and preserves named exports", async () => {
    const moduleSource = createGrokBotAvatarModule(source);
    const module = await import(`data:text/javascript,${encodeURIComponent(moduleSource)}`);
    const jsxRuntime = { jsx: (name: string, props: { children: string }) => ({ name, props }) };
    const engine = module.createEngine({ version: "host-react" }, jsxRuntime);
    expect(engine.BotRenderer({ label: "-avatar" })).toEqual({
      name: "span",
      props: { children: "host-react-avatar" },
    });
    expect(engine.DEFAULT_FILL).toBe("green");
    expect(engine.createAppearance("blob")).toBe("blob");
    expect(moduleSource).not.toContain('from "react"');
    expect(moduleSource).not.toContain("Locally extracted source");
  });

  it("rejects unexpected module imports and incomplete renderer exports", () => {
    expect(() =>
      createGrokBotAvatarModule(
        source.replace("const fill", "import other from 'other';\nconst fill"),
      ),
    ).toThrow("self-contained");
    expect(() =>
      createGrokBotAvatarModule(source.replace("appearance as bodyForShape,", "")),
    ).toThrow("required avatar exports");
  });

  it("extracts the avatar closure without unrelated app code or property-name dependencies", async () => {
    const bundle = `
      import {j as M, r as k} from './common.js';
      import {up} from './vendor.js';
      const unrelated = () => up();
      const ao = 'green';
      function q_(value) { return {up: value}; }
      function NM(value) { return q_(value); }
      function N_(value) { return value; }
      function F_(value) { return value; }
      function Nw(value) { return value; }
      function z_(props) { return M.jsx('span', {children: k.version + props.label}); }
      export {z_ as M};
    `;
    const extracted = extractGrokBotAvatarRenderer(bundle, "0.68.1");
    expect(extracted).not.toContain("unrelated");
    expect(extracted).not.toContain("vendor.js");
    const adapted = createGrokBotAvatarModule(extracted);
    const module = await import(`data:text/javascript,${encodeURIComponent(adapted)}`);
    expect(module.createEngine({}, {}).createAppearance("blob")).toEqual({ up: "blob" });
    expect(() => extractGrokBotAvatarRenderer(bundle, "0.69.0")).toThrow("0.68.1 only");
  });
});
