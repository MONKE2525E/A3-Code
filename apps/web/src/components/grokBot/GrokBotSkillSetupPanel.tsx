import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type GrokBotSetupStatus,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CopyIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { grokBotsOrchestratorSetup } from "~/state/grokBots";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  grokBotSetupPollMs,
  grokBotSetupSendDisabled,
  grokBotSetupShowsTerminal,
  grokBotSetupView,
  grokBotTerminalHint,
} from "./grokBotSetupFlow";
import { grokBotFailureMessage } from "./grokBotPresentation";

function CopyField({ label, value }: { readonly label: string; readonly value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 basis-48 break-all rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs select-text">
          {value}
        </code>
        <Button
          size="sm"
          variant="outline"
          type="button"
          onClick={() =>
            void writeTextToClipboard(value, label).then((ok) => setCopied(ok === true))
          }
        >
          <CopyIcon />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

function isWebUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Server-driven skill setup: one button sends the prompt, progress comes from config.setupStatus. */
export function GrokBotSkillSetupPanel({
  environmentId,
  prompt,
  setupStatus,
  refresh,
  refreshing,
}: {
  readonly environmentId: EnvironmentId;
  readonly prompt: string | undefined;
  readonly setupStatus: GrokBotSetupStatus | undefined;
  readonly refresh: () => void;
  readonly refreshing: boolean;
}) {
  // send_setup_prompt writes provider settings and posts to a bot, so it needs both scopes.
  const canWriteSettings = useAtomValue(grokBotsOrchestratorSetup.permissionAtom(environmentId));
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canSend = canWriteSettings && canOperate;
  const send = useAtomCommand(grokBotsOrchestratorSetup, { reportFailure: false });
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const view = setupStatus ? grokBotSetupView(setupStatus) : null;
  const active = view?.active === true;

  const phase = setupStatus?.phase;
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);
  useEffect(() => {
    if (!active || phase === undefined) return;
    const id = window.setInterval(() => refreshRef.current(), grokBotSetupPollMs(phase));
    return () => window.clearInterval(id);
  }, [active, phase]);

  const sendPrompt = async () => {
    setSending(true);
    setSendError(null);
    const result = await send({ environmentId, input: { action: "send_setup_prompt" } });
    setSending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      setSendError(grokBotFailureMessage(squashAtomCommandFailure(result)));
      return;
    }
    refresh();
  };

  const authUrl = setupStatus?.authorizationUrl;
  return (
    <div className="grid gap-3">
      {view && setupStatus ? (
        <div className="grid gap-2" aria-live="polite">
          <p className="text-sm font-medium text-foreground">{view.title}</p>
          <p
            className={
              view.tone === "error"
                ? "text-xs leading-5 text-destructive"
                : "text-xs leading-5 text-muted-foreground"
            }
          >
            {view.description}
          </p>
          {authUrl && isWebUrl(authUrl) ? (
            <a
              href={authUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="w-fit text-xs text-foreground underline underline-offset-2"
            >
              Open authorization page
            </a>
          ) : null}
          {grokBotSetupShowsTerminal(setupStatus) && setupStatus.terminalCommand ? (
            <>
              <p className="text-xs leading-5 text-muted-foreground">
                {grokBotTerminalHint(setupStatus.terminalCommand)}
              </p>
              <CopyField label="Terminal command" value={setupStatus.terminalCommand} />
            </>
          ) : null}
          {setupStatus.mcpUrl ? <CopyField label="MCP URL" value={setupStatus.mcpUrl} /> : null}
        </div>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          Send the setup prompt to your primary GrokBot to install the shared skill. All bots share
          it.
        </p>
      )}
      {sendError ? (
        <p role="alert" className="text-xs text-destructive">
          {sendError}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {view?.showSend !== false ? (
          <Button
            size="sm"
            type="button"
            disabled={!canSend || sending || grokBotSetupSendDisabled(setupStatus)}
            onClick={() => void sendPrompt()}
          >
            {sending ? <Spinner size="xs" /> : null}
            {view?.sendLabel ?? "Send setup prompt"}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost-muted" type="button" onClick={refresh}>
          {refreshing ? <Spinner size="xs" /> : null}
          Check again
        </Button>
      </div>
      {prompt !== undefined ? <ManualPrompt prompt={prompt} /> : null}
    </div>
  );
}

/** Collapsed fallback for copying the prompt into a bot by hand. */
function ManualPrompt({ prompt }: { readonly prompt: string }) {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [revealPrompt, setRevealPrompt] = useState(false);

  const copyPrompt = async () => {
    try {
      if ((await writeTextToClipboard(prompt, "shared skill prompt")) === true) {
        setCopied(true);
        setCopyError(null);
        return;
      }
    } catch {
      // Reveal the selectable prompt so copy can still happen by hand.
    }
    setCopied(false);
    setCopyError("Could not copy the prompt. Select it below and copy it yourself.");
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
    <details className="group grid gap-2 text-xs">
      <summary className="w-fit cursor-pointer text-muted-foreground select-none hover:text-foreground">
        Install the shared skill manually
      </summary>
      <div className="mt-2 grid gap-2">
        <p className="leading-5 text-muted-foreground">
          This copies only the shared-skill installation prompt, not the full OAuth setup. Paste it
          into one GrokBot and approve if asked; all bots share the skill.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" type="button" onClick={() => void copyPrompt()}>
            <CopyIcon />
            {copied ? "Copied" : "Copy shared skill prompt"}
          </Button>
          <Button
            size="sm"
            variant="ghost-muted"
            type="button"
            onClick={() => setRevealPrompt((open) => !open)}
          >
            {revealPrompt ? "Hide prompt" : "Show prompt"}
          </Button>
        </div>
        {copyError ? (
          <p role="alert" className="text-destructive">
            {copyError}
          </p>
        ) : null}
        {revealPrompt ? (
          <textarea
            ref={promptRef}
            readOnly
            value={prompt}
            aria-label="Shared skill prompt"
            onFocus={(event) => event.currentTarget.select()}
            className="max-h-40 min-h-24 w-full resize-y rounded-lg border border-input bg-background px-2.5 py-1.5 font-mono text-xs leading-relaxed text-foreground select-text"
          />
        ) : null}
      </div>
    </details>
  );
}
