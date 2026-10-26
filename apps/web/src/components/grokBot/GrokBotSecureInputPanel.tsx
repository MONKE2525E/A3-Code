import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  SECRET_REQUEST_DEFAULT_PLACEHOLDER,
  secretRequestPrivacyNote,
} from "@t3tools/client-runtime/secret-request";
import type { EnvironmentId } from "@t3tools/contracts";
import { ShieldCheckIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { grokBotsSecretDismiss, grokBotsSecretSubmit } from "~/state/grokBots";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  forgetRespondedGrokBotSecretRequests,
  grokBotPendingSecretRequests,
  grokBotSecretFailureEndsRequest,
  grokBotSecretFailureMessage,
  grokBotSecretRequestKey,
  grokBotSecretSubmitInput,
  hideGrokBotSecretRequest,
  isGrokBotSecretRequestSettled,
  markGrokBotSecretRequestSettled,
  useHiddenGrokBotSecretRequests,
  type GrokBotSecretRequestItem,
} from "./grokBotSecretRequest";

/**
 * Secure inputs a Grok Bot is waiting on. The value lives only in each field's DOM node: it is never
 * React state, a store, a log, or an error, and every settle or unmount clears the field. A request
 * leaves the panel once native accepts its answer, or reports it no longer asked. A request this
 * device dismissed stays out of the list across reloads, independently of native acknowledgment.
 */
export function GrokBotSecureInputPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly requests: ReadonlyArray<GrokBotSecretRequestItem>;
}) {
  const { environmentId, botId, requests } = props;
  const target = { environmentId, botId };
  // oxlint-disable-next-line t3code/react-effect-budget -- Reconcile hidden requests with server snapshots after responses.
  useEffect(
    () => forgetRespondedGrokBotSecretRequests({ environmentId, botId }, requests),
    [environmentId, botId, requests],
  );
  const hiddenKeys = useHiddenGrokBotSecretRequests((state) => state.keys);
  const unsettled = grokBotPendingSecretRequests(requests).filter(
    (request) => !isGrokBotSecretRequestSettled(grokBotSecretRequestKey(target, request)),
  );
  const pending = unsettled.filter(
    (request) => !hiddenKeys.includes(grokBotSecretRequestKey(target, request)),
  );
  if (pending.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-col gap-3 px-4 pb-3">
      {pending.map((request) => (
        <GrokBotSecureInputForm
          key={grokBotSecretRequestKey(target, request)}
          environmentId={environmentId}
          botId={botId}
          request={request}
        />
      ))}
    </div>
  );
}

function GrokBotSecureInputForm(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly request: GrokBotSecretRequestItem;
}) {
  const { environmentId, botId, request } = props;
  const target = { environmentId, botId };
  const inputId = useId();
  const errorId = useId();
  const privacyId = useId();
  const canSubmit = useAtomValue(grokBotsSecretSubmit.permissionAtom(environmentId));
  const canDismiss = useAtomValue(grokBotsSecretDismiss.permissionAtom(environmentId));
  const submitSecret = useAtomCommand(grokBotsSecretSubmit, {
    label: "answer grok bot secure input",
    // The failure cause can carry the submitted payload; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const dismissSecret = useAtomCommand(grokBotsSecretDismiss, {
    label: "dismiss grok bot secure input",
    reportFailure: false,
    reportDefect: false,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  // Only whether the field has text, so Save can enable; the text itself stays in the DOM.
  const [filled, setFilled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<{
    readonly kind: "save";
    readonly message: string;
  } | null>(null);

  // oxlint-disable-next-line t3code/react-effect-budget -- Clear secret input bytes when the panel unmounts.
  useEffect(() => {
    const input = inputRef.current;
    return () => {
      if (input !== null) input.value = "";
    };
  }, []);

  // Closing marks the key settled, so a snapshot that still lists the request cannot reopen it.
  const close = () => {
    markGrokBotSecretRequestSettled(grokBotSecretRequestKey(target, request));
    setClosed(true);
  };

  const clearField = () => {
    if (inputRef.current !== null) inputRef.current.value = "";
    setFilled(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = inputRef.current;
    if (input === null || inFlight.current) return;
    const payload = grokBotSecretSubmitInput(request, botId, input.value);
    if (payload === null) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      // Success is only what native returned as accepted; nothing is assumed from the request.
      const result = await submitSecret({ environmentId, input: payload });
      if (result._tag === "Success") {
        close();
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        if (grokBotSecretFailureEndsRequest(failure)) close();
        else setError({ kind: "save", message: grokBotSecretFailureMessage(failure) });
      }
    } catch {
      setError({ kind: "save", message: grokBotSecretFailureMessage(undefined) });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
      // Cleared on every outcome, including a thrown rejection, so a failed value never sits in
      // the field for a retry or a resend.
      clearField();
    }
  };

  const dismiss = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    // Hide and clear before contacting native: acknowledgment never controls local visibility.
    clearField();
    hideGrokBotSecretRequest(grokBotSecretRequestKey(target, request));
    if (!canDismiss) return;
    try {
      await dismissSecret({
        environmentId,
        input: { botId, sessionId: request.sessionId, entryId: request.entryId },
      });
    } catch {
      // Native dismissal is best effort. A rejection must not restore the card or leave a notice.
    }
  };

  if (closed) return null;

  return (
    <form
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
      autoComplete="off"
      onSubmit={submit}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={inputId} className="text-sm font-medium text-foreground">
          {request.title}
        </label>
        {request.description?.trim() ? (
          <p className="text-sm text-muted-foreground">{request.description}</p>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            ref={inputRef}
            id={inputId}
            // A real password field, so every browser masks it. CSS text-security is not enough:
            // Firefox ignores it and shows the value. The autofill and password-manager hints below
            // stop managers from offering to save or fill it.
            type="password"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            // Password managers otherwise offer to save or fill this field.
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            placeholder={SECRET_REQUEST_DEFAULT_PLACEHOLDER}
            disabled={submitting || !canSubmit}
            aria-invalid={error?.kind === "save" || undefined}
            aria-describedby={error !== null ? `${privacyId} ${errorId}` : privacyId}
            onChange={(event) => setFilled(event.currentTarget.value.trim().length > 0)}
          />
        </div>
        <Button type="submit" disabled={submitting || !canSubmit || !filled}>
          Save securely
        </Button>
      </div>
      {error !== null ? (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <p id={errorId} role="alert" className="min-w-0 text-xs text-destructive">
            {error.message}
          </p>
        </div>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p
          id={privacyId}
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
          {secretRequestPrivacyNote({})}
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={submitting}
          onClick={() => void dismiss()}
        >
          Dismiss
        </Button>
      </div>
    </form>
  );
}
