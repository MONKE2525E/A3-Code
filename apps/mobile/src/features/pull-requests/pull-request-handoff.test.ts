import { ComposerContextId } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import {
  buildAskAboutPullRequestHandoff,
  buildExplainPullRequestHandoff,
} from "@t3tools/shared/pullRequestHandoff";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestHandoffDraft } from "./pull-request-handoff";

const pr = {
  number: 42,
  title: "Fix it",
  url: "https://github.com/o/r/pull/42",
  headBranch: "fix",
  baseBranch: "main",
  state: "open" as const,
  isDraft: false,
};

describe("pullRequestHandoffDraft", () => {
  it("leaves the pull request chip and the task in the composer, unsent", () => {
    const next = pullRequestHandoffDraft(
      { text: "" },
      buildExplainPullRequestHandoff(pr),
      undefined,
    );
    expect(next?.context.records).toHaveLength(1);
    expect(next?.context.records[0]).toMatchObject({ kind: "review-comment", label: "#42" });
    expect(next?.text.endsWith("Explain this pull request.")).toBe(true);
  });

  it("replaces an earlier hand-off but keeps what the reader wrote and attached", () => {
    const own = {
      version: 1 as const,
      kind: "thread" as const,
      contextId: ComposerContextId.make("thread_1"),
      label: "Other",
      environmentId: "e" as never,
      threadId: "t" as never,
      title: "Other",
    };
    const first = pullRequestHandoffDraft(
      {
        text: `${formatComposerContextReference(own)} why?`,
        context: { version: 1, records: [own] },
      },
      buildExplainPullRequestHandoff(pr),
      undefined,
    )!;
    const second = pullRequestHandoffDraft(
      first,
      buildAskAboutPullRequestHandoff(pr),
      "Explain this pull request.",
    )!;
    expect(second.context.records.map((record) => record.kind)).toEqual([
      "thread",
      "review-comment",
    ]);
    expect(second.text).not.toContain("Explain this pull request.");
    expect(second.text).toContain("why?");
  });
});
