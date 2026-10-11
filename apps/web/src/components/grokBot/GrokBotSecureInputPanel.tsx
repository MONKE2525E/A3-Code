import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  SECRET_REQUEST_DEFAULT_PLACEHOLDER,
  SECRET_REQUEST_PRIVACY_NOTE,
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
  grokBotHiddenSecretRequestsPersist,
  grokBotPendingSecretRequests,
  grokBotSecretDismissFailureMessage,
  grokBotSecretDismissIsUnsupported,
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
 * device hid stays out of the list, and the row below restores it.
 */
export function GrokBotSecureInputPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly requests: ReadonlyArray<GrokBotSecretRequestItem>;
}) {
  const { environmentId, botId, requests } = props;
  const target = { environmentId, botId };
  // The request just hidden, so Undo can restore it. Only this session; a reload shows the row.
  const [justHiddenKey, setJustHiddenKey] = useState<string | null>(null);
  // Set when Undo or Show restores a card, so its field takes focus once it mounts again.
  const [restoredKey, setRestoredKey] = useState<string | null>(null);
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
  // Only hidden requests the bot still lists count; a responded entry is forgotten above.
  const hidden = unsettled.filter((request) =>
    hiddenKeys.includes(grokBotSecretRequestKey(target, request)),
  );
  if (pending.length === 0 && hidden.length === 0) return null;

  const hiddenKeysForTarget = hidden.map((request) => grokBotSecretRequestKey(target, request));
  const restore = (keys: ReadonlyArray<string>) => {
    useHiddenGrokBotSecretRequests.getState().forget(keys);
    setJustHiddenKey(null);
    setRestoredKey(keys[0] ?? null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-3 px-4 pb-3">
      {pending.map((request) => {
        const key = grokBotSecretRequestKey(target, request);
        return (
          <GrokBotSecureInputForm
            key={`${request.sessionId}:${request.entryId}`}
            environmentId={environmentId}
            botId={botId}
            request={request}
            focusOnMount={restoredKey === key}
            onHidden={() => {
              setJustHiddenKey(key);
              setRestoredKey(null);
            }}
          />
        );
      })}
      {hidden.length > 0 ? (
        <GrokBotHiddenSecretRequests
          count={hidden.length}
          undoKey={justHiddenKey}
          persists={grokBotHiddenSecretRequestsPersist}
          onUndo={(key) => restore([key])}
          onShow={() => restore(hiddenKeysForTarget)}
        />
      ) : null}
    </div>
  );
}

/**
 * Compact row for requests this device hid. Right after a hide it offers Undo for that request; on
 * any later visit it is only the count and Show. Focus moves to Undo when a hide happens, since the
 * hidden card just unmounted and would otherwise leave focus on the page body.
 */
function GrokBotHiddenSecretRequests(props: {
  readonly count: number;
  readonly undoKey: string | null;
  readonly persists: boolean;
  readonly onUndo: (key: string) => void;
  readonly onShow: () => void;
}) {
  const { count, undoKey, persists, onUndo, onShow } = props;
  const undoRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (undoKey !== null) undoRef.current?.focus();
  }, [undoKey]);
  const durability = persists ? "" : " Hidden until reload.";
  const message =
    undoKey !== null
      ? `Hidden on this device. The bot may still be waiting.${durability}`
      : `${count === 1 ? "1 secure input" : `${count} secure inputs`} hidden on this device. The bot may still be waiting.${durability}`;
  return (
    <div
      role="status"
      className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2"
    >
      <p className="min-w-0 text-xs text-muted-foreground">{message}</p>
      <div className="flex shrink-0 items-center gap-1">
        {undoKey !== null ? (
          <Button
            ref={undoRef}
            type="button"
            size="xs"
            variant="ghost-muted"
            onClick={() => onUndo(undoKey)}
          >
            Undo
          </Button>
        ) : null}
        <Button type="button" size="xs" variant="ghost-muted" onClick={onShow}>
          Show requests
        </Button>
      </div>
    </div>
  );
}

function GrokBotSecureInputForm(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  readonly request: GrokBotSecretRequestItem;
  readonly focusOnMount: boolean;
  readonly onHidden: () => void;
}) {
  const { environmentId, botId, request, focusOnMount, onHidden } = props;
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
  // One error at a time, tagged by the action that produced it, so a save message never sits under
  // a failed dismissal and the other action clears it.
  const [error, setError] = useState<{
    readonly kind: "save" | "dismiss";
    readonly message: string;
  } | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    return () => {
      if (input !== null) input.value = "";
    };
  }, []);

  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus();
  }, [focusOnMount]);

  // Closing marks the key settled, so a snapshot that still lists the request cannot reopen it.
  const close = () => {
    markGrokBotSecretRequestSettled(grokBotSecretRequestKey(target, request));
    setClosed(true);
  };

  const clearField = () => {
    if (inputRef.current !== null) inputRef.current.value = "";
    setFilled(false);
  };

  // Local only: the bot is not told and the request is not deleted. The field is cleared before the
  // card unmounts, and the panel's row offers Undo for it.
  const hideLocally = () => {
    clearField();
    hideGrokBotSecretRequest(grokBotSecretRequestKey(target, request));
    onHidden();
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
    setSubmitting(true);
    setError(null);
    try {
      // Native's own dismissal, so the bot stops waiting. A refusal stays visible and retryable.
      const result = await dismissSecret({
        environmentId,
        input: { botId, sessionId: request.sessionId, entryId: request.entryId },
      });
      if (result._tag === "Success") {
        close();
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        if (grokBotSecretFailureEndsRequest(failure)) {
          close();
        } else if (grokBotSecretDismissIsUnsupported(failure)) {
          // Native cannot cancel a secure input, so the card hides on this device in one action.
          // The bot is still waiting, which the row says; nothing is claimed as dismissed.
          hideLocally();
        } else {
          setError({ kind: "dismiss", message: grokBotSecretDismissFailureMessage() });
        }
      }
    } catch {
      setError({ kind: "dismiss", message: grokBotSecretDismissFailureMessage() });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
      clearField();
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
          {error.kind === "dismiss" ? (
            // The way out when native refused or could not be reached for a dismissal.
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              disabled={submitting}
              onClick={hideLocally}
            >
              Hide on this device
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p
          id={privacyId}
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
          {SECRET_REQUEST_PRIVACY_NOTE}
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={submitting || !canDismiss}
          onClick={() => void dismiss()}
        >
          Dismiss
        </Button>
      </div>
    </form>
  );
}
