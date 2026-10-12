import type { EnvironmentId, PullRequestRef, PullRequestReviewVerdict } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { pullRequestEnvironment } from "../../state/pull-requests";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * The comment or review being written. It lives with the detail pane rather than the Timeline
 * tab, so switching tabs or folding the phone never costs the draft, and a failed submission
 * leaves it exactly as typed.
 */
export function usePullRequestComposer(input: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  onPosted: () => void;
}) {
  const [body, setBody] = useState("");
  const [verdict, setVerdict] = useState<PullRequestReviewVerdict>("comment");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const comment = useAtomCommand(pullRequestEnvironment.comment, { reportFailure: false });
  const submitReview = useAtomCommand(pullRequestEnvironment.submitReview, {
    reportFailure: false,
  });
  const { environmentId, reference, onPosted } = input;
  const send = async (selectedVerdict: PullRequestReviewVerdict = verdict) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        selectedVerdict === "comment"
          ? await comment({ environmentId, input: { ...reference, body } })
          : await submitReview({
              environmentId,
              input: { ...reference, body, verdict: selectedVerdict, comments: [] },
            });
      if (result._tag === "Success") {
        setBody("");
        onPosted();
      } else {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? failure.message
            : "Could not submit. Your draft is kept; try again.",
        );
      }
    } finally {
      setBusy(false);
    }
  };
  return {
    body,
    setBody,
    verdict,
    setVerdict,
    busy,
    error,
    clearError: () => setError(null),
    send,
  };
}

export type PullRequestComposerState = ReturnType<typeof usePullRequestComposer>;
