import {
  collectComposerInlineTokens,
  SKILL_MENTION_PATTERN,
  type ComposerInlineToken,
} from "./composerInlineTokens.ts";

export type GrokBotComposerRichTextSkill = {
  readonly id: string;
  readonly name: string;
  readonly chipName?: string;
};

export type GrokBotComposerRichTextBot = {
  readonly id: string;
  readonly name: string;
};

export type GrokBotComposerRichTextConnector = {
  readonly pluginId: string;
  readonly name: string;
  readonly displayName?: string;
};

export type GrokBotComposerRichTextCatalog = {
  readonly skills: readonly GrokBotComposerRichTextSkill[];
  readonly bots: readonly GrokBotComposerRichTextBot[];
  readonly connectors: readonly GrokBotComposerRichTextConnector[];
};

export type GrokBotNativeInlineNode =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "mention"; readonly attrs: { readonly id: string; readonly label: string } }
  | {
      readonly type: "workflowReference";
      readonly attrs: {
        readonly id: string;
        readonly label: string;
        readonly iconId: string | null;
        readonly iconUrl: string | null;
      };
    };

export type GrokBotNativeParagraph = {
  readonly type: "paragraph";
  readonly content?: readonly GrokBotNativeInlineNode[];
};

export type GrokBotNativeRichTextDoc = {
  readonly type: "doc";
  readonly content: readonly GrokBotNativeParagraph[];
};

export type GrokBotComposerRichTextResult = {
  readonly doc: GrokBotNativeRichTextDoc;
  readonly richText: string;
  readonly nativeText: string;
  readonly unresolved: readonly string[];
};

const WORKFLOW_REFERENCE_ATTRS = { iconId: null, iconUrl: null } as const;

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function chipSafeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function grokBotSkillChipName(skill: GrokBotComposerRichTextSkill): string {
  if (skill.chipName && skill.chipName.length > 0) return skill.chipName;
  if (/^[a-zA-Z][a-zA-Z0-9:_-]*$/.test(skill.name)) return skill.name;
  const fromName = chipSafeName(skill.name);
  if (/^[a-zA-Z][a-zA-Z0-9:_-]*$/.test(fromName)) return fromName;
  if (skill.id.startsWith("sand-workflow:")) {
    const fromId = skill.id.slice("sand-workflow:".length);
    if (/^[a-zA-Z][a-zA-Z0-9:_-]*$/.test(fromId)) return fromId;
  }
  return skill.name;
}

export function grokBotConnectorLabel(connector: GrokBotComposerRichTextConnector): string {
  const display = connector.displayName?.trim();
  return display && display.length > 0 ? display : connector.name;
}

export function formatGrokBotComposerAtToken(label: string): string {
  if (/[\s@"]/.test(label)) return `@"${label.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `@${label}`;
}

function workflowReference(id: string, label: string): GrokBotNativeInlineNode {
  return { type: "workflowReference", attrs: { id, label, ...WORKFLOW_REFERENCE_ATTRS } };
}

function mention(id: string, label: string): GrokBotNativeInlineNode {
  return { type: "mention", attrs: { id, label } };
}

function findSkill(
  catalog: GrokBotComposerRichTextCatalog,
  token: string,
): GrokBotComposerRichTextSkill | undefined {
  const key = normalizeKey(token);
  return catalog.skills.find((skill) => {
    if (normalizeKey(skill.id) === key || normalizeKey(skill.name) === key) return true;
    if (normalizeKey(grokBotSkillChipName(skill)) === key) return true;
    if (
      skill.id.startsWith("sand-workflow:") &&
      normalizeKey(skill.id.slice("sand-workflow:".length)) === key
    )
      return true;
    return false;
  });
}

function findBot(
  catalog: GrokBotComposerRichTextCatalog,
  token: string,
): GrokBotComposerRichTextBot | undefined {
  const key = normalizeKey(token);
  return catalog.bots.find((bot) => normalizeKey(bot.id) === key || normalizeKey(bot.name) === key);
}

function findConnector(
  catalog: GrokBotComposerRichTextCatalog,
  token: string,
): GrokBotComposerRichTextConnector | undefined {
  const key = normalizeKey(token);
  const pluginKey = key.startsWith("plugin:") ? key.slice("plugin:".length) : key;
  return catalog.connectors.find((connector) => {
    if (connector.pluginId === pluginKey || normalizeKey(connector.pluginId) === pluginKey)
      return true;
    if (normalizeKey(connector.name) === key) return true;
    if (connector.displayName && normalizeKey(connector.displayName) === key) return true;
    return false;
  });
}

function collectSendTokens(prompt: string): readonly ComposerInlineToken[] {
  const tokens = [...collectComposerInlineTokens(prompt)];
  for (const match of prompt.matchAll(SKILL_MENTION_PATTERN)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const value = match[2] ?? "";
    if (!value) continue;
    const start = (match.index ?? 0) + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    if (
      tokens.some((token) => token.type === "skill" && token.start === start && token.end === end)
    ) {
      continue;
    }
    tokens.push({
      type: "skill",
      value,
      source: prompt.slice(start, end),
      start,
      end,
    });
  }
  return tokens.sort((left, right) => left.start - right.start);
}

function splitParagraphs(text: string): string[] {
  return text.split("\n");
}

function pushText(nodes: GrokBotNativeInlineNode[], text: string): void {
  if (!text) return;
  const last = nodes[nodes.length - 1];
  if (last?.type === "text") {
    nodes[nodes.length - 1] = { type: "text", text: last.text + text };
    return;
  }
  nodes.push({ type: "text", text });
}

function nativeVisibleText(node: GrokBotNativeInlineNode): string {
  if (node.type === "text") return node.text;
  return `@${node.attrs.label}`;
}

/**
 * Proven native 0.68.1 TipTap payload: mentions are `{type:"mention", attrs:{id,label}}`;
 * skills and plugins are `{type:"workflowReference", ...}` with plugin ids `plugin:${pluginId}`.
 * T3 `$`/`@` tokens stay in the composer and convert at send time.
 */
export function serializeGrokBotComposerRichText(
  prompt: string,
  catalog: GrokBotComposerRichTextCatalog,
): GrokBotComposerRichTextResult {
  const unresolved: string[] = [];
  const paragraphs: GrokBotNativeParagraph[] = [];
  let nativeText = "";

  const emitLine = (line: string, lineStart: number) => {
    const nodes: GrokBotNativeInlineNode[] = [];
    const tokens = collectSendTokens(prompt).filter(
      (token) => token.start >= lineStart && token.end <= lineStart + line.length,
    );
    let cursor = 0;
    const lineEnd = line.length;
    for (const token of tokens) {
      const localStart = token.start - lineStart;
      const localEnd = token.end - lineStart;
      if (localStart < cursor || localEnd > lineEnd) continue;
      pushText(nodes, line.slice(cursor, localStart));
      if (token.type === "skill") {
        const skill = findSkill(catalog, token.value);
        if (skill) {
          nodes.push(workflowReference(skill.id, skill.name));
        } else {
          unresolved.push(token.source);
          pushText(nodes, token.source);
        }
      } else {
        const bot = findBot(catalog, token.value);
        if (bot) {
          nodes.push(mention(bot.id, bot.name));
        } else {
          const connector = findConnector(catalog, token.value);
          if (connector) {
            nodes.push(
              workflowReference(`plugin:${connector.pluginId}`, grokBotConnectorLabel(connector)),
            );
          } else {
            unresolved.push(token.source);
            pushText(nodes, token.source);
          }
        }
      }
      cursor = localEnd;
    }
    pushText(nodes, line.slice(cursor));
    paragraphs.push(
      nodes.length === 0 ? { type: "paragraph" } : { type: "paragraph", content: nodes },
    );
    nativeText += (nativeText.length === 0 ? "" : "\n") + nodes.map(nativeVisibleText).join("");
  };

  let offset = 0;
  const lines = splitParagraphs(prompt);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    emitLine(line, offset);
    offset += line.length + 1;
  }

  const doc: GrokBotNativeRichTextDoc = { type: "doc", content: paragraphs };
  return {
    doc,
    richText: JSON.stringify(doc),
    nativeText,
    unresolved,
  };
}
