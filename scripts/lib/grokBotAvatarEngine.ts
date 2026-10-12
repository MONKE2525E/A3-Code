import { parseAst } from "vite-plus";

const expectedExports = [
  "bodyForShape",
  "BotRenderer",
  "DEFAULT_FILL",
  "createAppearance",
  "inkForColor",
  "inkForTheme",
  "recipeByName",
];

/** Wrap a locally extracted renderer without bundling a second React instance. */
export function createGrokBotAvatarModule(source: string): string {
  const react = /^import \* as (\w+) from ["']react["'];?\s*$/m.exec(source);
  const jsx = /^import \* as (\w+) from ["']react\/jsx-runtime["'];?\s*$/m.exec(source);
  const exports = /\bexport\s*\{([^}]+)\};?\s*$/.exec(source);
  if (!react || !jsx || !exports)
    throw new Error(
      "Expected a standalone Grok Bot renderer with React imports and named exports.",
    );
  const entries = exports[1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\w+)\s+as\s+(\w+)$/.exec(entry);
      if (!match) throw new Error("Unsupported renderer export.");
      return { local: match[1]!, name: match[2]! };
    });
  if (
    entries.length !== expectedExports.length ||
    expectedExports.some((name) => !entries.some((entry) => entry.name === name))
  ) {
    throw new Error("The renderer does not provide the required avatar exports.");
  }
  const body = source
    .slice(0, exports.index)
    .replace(react[0], "")
    .replace(jsx[0], "")
    .replace(/^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*)+/, "");
  if (/^\s*(?:import|export)\b/m.test(body) || /\bimport\s*\(/.test(body)) {
    throw new Error("The renderer must be self-contained.");
  }
  return `export function createEngine(${react[1]}, ${jsx[1]}) {\n${body}\nreturn {\n${entries.map(({ local, name }) => `  ${name}: ${local}`).join(",\n")}\n};\n}\n`;
}

/** Select the avatar dependency closure from Grok Bot 0.68.1's platform bundle. */
export function extractGrokBotAvatarRenderer(bundle: string, version: string): string {
  if (version !== "0.68.1")
    throw new Error("Bundle extraction currently supports Grok Bot 0.68.1 only.");
  const roots = {
    bodyForShape: "q_",
    BotRenderer: "z_",
    DEFAULT_FILL: "ao",
    createAppearance: "NM",
    inkForColor: "N_",
    inkForTheme: "F_",
    recipeByName: "Nw",
  };
  const ast = parseAst(bundle);
  const units: { names: Set<string>; references: Set<string>; text: string; start: number }[] = [];
  const imports = new Set<string>();
  const identifiers = (value: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) {
      for (const child of value) identifiers(child, out);
    } else if (value !== null && typeof value === "object") {
      const tree = value as Record<string, unknown>;
      if (tree.type === "Identifier" && typeof tree.name === "string") out.add(tree.name);
      for (const [key, child] of Object.entries(tree)) {
        // Property names are not references to same-named top-level bindings.
        if (
          !tree.computed &&
          ((key === "property" && tree.type === "MemberExpression") ||
            (key === "key" && (tree.type === "Property" || tree.type === "MethodDefinition")))
        )
          continue;
        if (typeof child === "object") identifiers(child, out);
      }
    }
    return out;
  };
  for (const statement of ast.body) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) imports.add(specifier.local.name);
    } else if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations)
        units.push({
          names: identifiers(declaration.id),
          references: identifiers(declaration.init),
          text: `${statement.kind} ${bundle.slice(declaration.start, declaration.end)};`,
          start: declaration.start,
        });
    } else if (
      (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") &&
      statement.id
    ) {
      units.push({
        names: new Set([statement.id.name]),
        references: identifiers(statement),
        text: bundle.slice(statement.start, statement.end),
        start: statement.start,
      });
    }
  }
  const byName = new Map(
    units.flatMap((unit) => [...unit.names].map((name) => [name, unit] as const)),
  );
  if (Object.values(roots).some((root) => !byName.has(root)))
    throw new Error("Unrecognized Grok Bot platform bundle.");
  const keep = new Set<(typeof units)[number]>();
  const neededImports = new Set<string>();
  const pending = Object.values(roots);
  while (pending.length) {
    const name = pending.pop()!;
    if (imports.has(name)) {
      neededImports.add(name);
      continue;
    }
    const unit = byName.get(name);
    if (unit && !keep.has(unit)) {
      keep.add(unit);
      pending.push(...unit.references);
    }
  }
  if ([...neededImports].some((name) => name !== "k" && name !== "M")) {
    throw new Error("Avatar renderer depends on unsupported external modules.");
  }
  return `import * as k from "react";\nimport * as M from "react/jsx-runtime";\n${[...keep]
    .sort((a, b) => a.start - b.start)
    .map((unit) => unit.text)
    .join("\n")}\nexport {${Object.entries(roots)
    .map(([name, local]) => `${local} as ${name}`)
    .join(",")}};\n`;
}
