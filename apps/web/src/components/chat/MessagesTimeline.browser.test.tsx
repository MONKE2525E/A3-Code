import { EnvironmentId, MessageId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { createRef, type ComponentProps, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, render } from "../../../test/render";
import { MessagesTimeline, remarkThoughtPreview } from "./MessagesTimeline";
import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";

const pullRequestQuery = vi.hoisted(() => ({ error: "Pull request not found" }));
vi.mock("/src/state/query.ts", async (original) => ({
  ...(await original<typeof import("../../state/query")>()),
  useEnvironmentQuery: (() => ({
    data: null,
    dataUpdatedAt: 0,
    error: pullRequestQuery.error,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

// The timeline remembers scroll position and open disclosures per thread key,
// so every render gets a fresh thread.
function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function message(
  text: string,
  overrides: Partial<Extract<Entry, { kind: "message" }>["message"]> = {},
  id = "message-1",
): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
      ...overrides,
    },
  };
}

async function renderElement(element: ReactElement) {
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(element, { container });
  const buttons = (name: string | RegExp) =>
    [...container.querySelectorAll<HTMLElement>("button, [role=button]")].filter((button) => {
      const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof name === "string" ? label === name : name.test(label);
    });
  return Object.assign(screen, {
    text: () => container.textContent ?? "",
    buttons,
    button: (name: string | RegExp) => {
      const [match] = buttons(name);
      if (!match) throw new Error(`Missing button: ${String(name)}`);
      return match;
    },
  });
}

function renderTimeline(entries: ReadonlyArray<Entry>, props: Partial<TimelineProps> = {}) {
  return renderElement(
    <MessagesTimeline {...baseProps()} timelineEntries={entries as Entry[]} {...props} />,
  );
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

describe("MessagesTimeline messages", () => {
  it("preserves XML-like tags and comparisons in user messages as text", async () => {
    const source = [
      'Without reading a file, do you have <global-agent-instructions scope="workspace">',
      'Before <nested data-value="a&b">inside</nested> after',
      "</global-agent-instructions> in your context?",
      "Comparison: 2 < 3 and 5 > 4.",
    ];
    await using screen = await renderTimeline([message(source.join("\n"))]);
    for (const line of source) expect(screen.text()).toContain(line);
    expect(screen.container.querySelector("global-agent-instructions, nested")).toBeNull();
  });

  it("renders unsafe user HTML as inert source text", async () => {
    const source =
      '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">';
    await using screen = await renderTimeline([message(source)]);
    expect(screen.text()).toContain(source);
    expect(screen.container.querySelector("script, img")).toBeNull();
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });

  it("renders sanitized raw HTML in assistant messages", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<details onclick="globalThis.__t3Xss = 1">',
          "<summary>Safe details</summary>",
          "<script>globalThis.__t3Xss = 2</script>",
          '<img src="x" onerror="globalThis.__t3Xss = 3">',
          '<a href="javascript:globalThis.__t3Xss = 4">Unsafe link</a>',
          "</details>",
        ].join(""),
        { role: "assistant" },
      ),
    ]);
    expect(screen.container.querySelector("[data-markdown-details]")?.textContent).toContain(
      "Safe details",
    );
    expect(screen.text()).not.toContain("<details");
    expect(screen.container.querySelector("script, [onclick], [onerror]")).toBeNull();
    expect(screen.container.innerHTML).not.toContain("javascript:");
    await click(screen.button("Safe details"));
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });
});

describe("compact reasoning math", () => {
  it("keeps formulas while flattening compact reasoning previews", () => {
    const tree = parseMarkdownWithMath("## Reasoning\n\nUse **norm** $|x|$ and \\[x^2\\]");
    remarkThoughtPreview("Reasoning")(tree);
    expect(tree.children.map((node) => node.type)).toEqual([
      "text",
      "inlineMath",
      "text",
      "inlineMath",
    ]);
    expect(tree.children.map((node) => ("value" in node ? node.value : null))).toEqual([
      "Reasoning Use norm ",
      "|x|",
      " and ",
      "x^2",
    ]);
  });
});

describe("Grok Bot timeline behavior", () => {
  it("replaces assistant connector links only in a bot thread", async () => {
    const href =
      "https://auth.example.test/authorize?client_id=synthetic&redirect_uri=https%3A%2F%2Fwww.cursor.com%2Fagents%2Fmcp%2Foauth%2Fcallback&state=synthetic.tgd";
    const text = `Sign in with [Linear](${href}) or read [docs](https://example.test/docs).`;
    await using bot = await renderTimeline([message(text, { role: "assistant" })], {
      isGrokBotThread: true,
    });
    await expect.element(bot.getByRole("button", { name: "Connect in Settings" })).toBeVisible();
    await expect
      .element(bot.getByRole("link", { name: "docs", exact: true }))
      .toHaveAttribute("href", "https://example.test/docs");
    await using provider = await renderTimeline([message(text, { role: "assistant" })]);
    await expect
      .element(provider.getByRole("link", { name: "Linear", exact: true }))
      .toHaveAttribute("href", href);
    await using user = await renderTimeline([message(text)], { isGrokBotThread: true });
    await expect
      .element(user.getByRole("link", { name: "Linear", exact: true }))
      .toHaveAttribute("href", href);
  });

  it.each(["grok-bot", "muse-agent"])(
    "downloads assistant attachments in the %s native thread",
    async (source) => {
      const attachment = {
        type: "file" as const,
        id: "attachment-bot-report",
        name: "bot-report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 42,
      };
      const entry = message("", { role: "assistant", attachments: [attachment] });
      const onFileDownload = vi.fn();
      await using other = await renderTimeline([entry], { onFileDownload });
      expect(other.buttons("Download bot-report.pdf")).toHaveLength(0);
      await other.unmount();
      await using bot = await renderTimeline([entry], {
        routeThreadKey: `environment-local:${source}:bot-1`,
        onFileDownload,
      });
      await vi.waitFor(() => expect(bot.buttons("Download bot-report.pdf")).toHaveLength(1));
      await click(bot.button("Download bot-report.pdf"));
      expect(onFileDownload).toHaveBeenCalledWith(attachment);
      expect(bot.text()).not.toContain("(empty response)");
    },
  );

  it("shows voice requests as markers without exposing internal prompts", async () => {
    await using screen = await renderTimeline([
      message("[From a voice call]\nFix the login bug", {
        createdBy: "agent",
        creationSource: "mcp",
        voiceRequest: true,
      }),
    ]);
    await expect.element(screen.getByText("Requested during voice call")).toBeVisible();
    expect(screen.text()).not.toContain("Fix the login bug");
    expect(screen.text()).not.toContain("From a voice call");
    expect(screen.text()).not.toContain("Sent by another agent");
  });
});
