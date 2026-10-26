import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchComposerThreadItems } from "./composerThreadItems.ts";

const env = EnvironmentId.make("env-1");
const otherEnv = EnvironmentId.make("env-2");
const shell = (
  id: string,
  title: string,
  overrides: Partial<Parameters<typeof matchComposerThreadItems>[0]["shells"][number]> = {},
) => ({
  environmentId: env,
  id: ThreadId.make(id),
  title,
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  branch: null,
  latestUserMessageAt: null,
  latestUserAuthoredMessageAt: null,
  opens: null,
  archivedAt: null,
  lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
  ...overrides,
});

describe("matchComposerThreadItems", () => {
  it("offers nothing for a bare @ so the picker stays a file picker", () => {
    expect(
      matchComposerThreadItems({
        shells: [shell("t1", "Fix login")],
        environmentId: env,
        excludeThreadId: null,
        now: Date.parse("2026-02-02T00:00:00.000Z"),
        query: "  ",
      }),
    ).toEqual([]);
  });

  it.each(["grok-bot", "muse-agent"])(
    "never offers a %s backing thread, but still offers ordinary agent threads",
    (source) => {
      const items = matchComposerThreadItems({
        shells: [shell(`${source}:9f2c`, "Login native agent"), shell("agent", "Login agent")],
        environmentId: env,
        excludeThreadId: null,
        now: Date.parse("2026-02-02T00:00:00.000Z"),
        query: "login",
      });
      expect(items.map((item) => item.thread.threadId)).toEqual(["agent"]);
    },
  );

  it("matches titles within the environment by recent user activity, skipping self and archived", () => {
    const items = matchComposerThreadItems({
      shells: [
        shell("old", "Login flow", { updatedAt: "2026-01-01T00:00:00.000Z" }),
        shell("new", "Login redesign", { latestUserAuthoredMessageAt: "2026-02-01T00:00:00.000Z" }),
        shell("self", "Login self"),
        shell("gone", "Login archived", { archivedAt: "2026-01-02T00:00:00.000Z" }),
        shell("foreign", "Login elsewhere", { environmentId: otherEnv }),
        shell("nope", "Unrelated"),
      ],
      environmentId: env,
      excludeThreadId: ThreadId.make("self"),
      now: Date.parse("2026-02-02T00:00:00.000Z"),
      query: "LOGIN",
    });
    expect(items.map((item) => item.thread.threadId)).toEqual(["new", "old"]);
    expect(items[0]).toMatchObject({ type: "thread", label: "Login redesign" });
  });
});

it("ranks thread mentions like the palette and leaves out subagent threads", () => {
  const items = matchComposerThreadItems({
    shells: [
      shell("newer-mid-word", "Remodel the settings page", {
        updatedAt: "2026-10-20T00:00:00.000Z",
      }),
      shell("word", "Fix model picker"),
      shell("subagent", "Model review", {
        lineage: {
          rootThreadId: ThreadId.make("word"),
          parentThreadId: ThreadId.make("word"),
          relationshipToParent: "subagent",
        },
      }),
      shell("other-environment", "Model docs", { environmentId: EnvironmentId.make("env-other") }),
    ],
    environmentId: env,
    excludeThreadId: null,
    query: "model",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map((item) => item.thread.threadId)).toEqual(["word", "newer-mid-word"]);
});
