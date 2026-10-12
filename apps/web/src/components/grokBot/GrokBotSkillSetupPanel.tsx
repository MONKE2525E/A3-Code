import { CopyIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";

/** One-time install or repair of the shared native workflow skill. */
export function GrokBotSkillSetupPanel({ prompt }: { readonly prompt: string }) {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [revealPrompt, setRevealPrompt] = useState(false);

  const copyPrompt = async () => {
    try {
      if ((await writeTextToClipboard(prompt, "setup prompt")) === true) {
        setCopied(true);
        setCopyError(null);
        return;
      }
    } catch {
      // Reveal the selectable prompt so copy can still happen by hand.
    }
    setCopied(false);
    setCopyError("Could not copy the setup prompt. Select it below and copy it yourself.");
    setRevealPrompt(true);
  };

  useLayoutEffect(() => {
    if (!revealPrompt) return;
    const node = promptRef.current;
    if (node === null) return;
    node.focus();
    node.select();
  }, [revealPrompt]);

  return (
    <div className="grid gap-2">
      <p className="text-xs leading-5 text-muted-foreground">
        Send this prompt to one GrokBot to install the shared skill. Approve if asked. All bots
        share it. T3 injects MCP automatically each turn; do not save credentials or connectors.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" type="button" onClick={() => void copyPrompt()}>
          <CopyIcon />
          {copied ? "Copied" : "Copy setup prompt"}
        </Button>
        <Button
          size="sm"
          variant="ghost-muted"
          type="button"
          onClick={() => setRevealPrompt((open) => !open)}
        >
          {revealPrompt ? "Hide setup prompt" : "Show setup prompt"}
        </Button>
      </div>
      {copyError ? (
        <p role="alert" className="text-xs text-destructive">
          {copyError}
        </p>
      ) : null}
      {revealPrompt ? (
        <textarea
          ref={promptRef}
          readOnly
          value={prompt}
          aria-label="Setup prompt"
          onFocus={(event) => event.currentTarget.select()}
          className="max-h-40 min-h-24 w-full resize-y rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs leading-relaxed text-foreground select-text"
        />
      ) : null}
    </div>
  );
}
