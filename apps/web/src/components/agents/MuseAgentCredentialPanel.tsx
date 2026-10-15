import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderInstanceId, MuseCredentialRequest } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { museAgentCredentialRequestsQuery, museAgentFeatureUpdate } from "~/state/museAgent";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { museSessionForThread } from "./aiAgents";

type Request = typeof MuseCredentialRequest.Type;

/** Values remain in DOM fields and go directly to Muse's vault, outside the conversation. */
export function MuseAgentCredentialPanel({
  environmentId,
  providerInstanceId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadId: string;
}) {
  const sessionId = museSessionForThread(threadId);
  const view = useEnvironmentQuery(
    museAgentCredentialRequestsQuery({
      environmentId,
      input: {
        operation: "credential_requests",
        providerInstanceId,
        ...(sessionId === undefined ? {} : { sessionId }),
      },
    }),
  );
  const canWrite = useAtomValue(museAgentFeatureUpdate.permissionAtom(environmentId));
  const data = view.data?.operation === "credential_requests" ? view.data.data : null;
  if (!data?.requests.length) return null;
  return (
    <div className="grid gap-3 px-4 pb-3">
      {data.requests.map((request) => (
        <CredentialForm
          key={`${environmentId}:${providerInstanceId}:${request.sessionId}:${request.requestId}`}
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          request={request}
          canWrite={canWrite}
          onSaved={view.refresh}
        />
      ))}
    </div>
  );
}

function CredentialForm({
  environmentId,
  providerInstanceId,
  request,
  canWrite,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly request: Request;
  readonly canWrite: boolean;
  readonly onSaved: () => void;
}) {
  const username = useRef<HTMLInputElement>(null),
    password = useRef<HTMLInputElement>(null),
    code = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const submit = useAtomCommand(museAgentFeatureUpdate, {
    reportFailure: false,
    reportDefect: false,
  });
  const clear = useCallback(() => {
    for (const field of [username, password, code]) if (field.current) field.current.value = "";
  }, []);
  useEffect(() => () => clear(), [clear]);
  return (
    <form
      className="grid gap-3 rounded-lg border p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending || !canWrite) return;
        setPending(true);
        setError(null);
        const fields =
          request.capture === "verification_code"
            ? { verificationCode: code.current?.value ?? "" }
            : { username: username.current?.value ?? "", password: password.current?.value ?? "" };
        clear();
        const result = await submit({
          environmentId,
          input: {
            operation: "credential_submit",
            providerInstanceId,
            sessionId: request.sessionId,
            requestId: request.requestId,
            ...fields,
          },
        });
        setPending(false);
        if (result._tag === "Success") onSaved();
        else
          setError("Muse could not confirm storage. Refresh the conversation before trying again.");
      }}
    >
      <div>
        <p className="text-sm font-medium">{request.title || "Muse needs a credential"}</p>
        <p className="text-xs text-muted-foreground">{request.pageUrl}</p>
      </div>
      {request.capture === "verification_code" ? (
        <label className="grid gap-1 text-sm">
          {request.codeLabel}
          <Input ref={code} type="password" autoComplete="one-time-code" required maxLength={256} />
        </label>
      ) : (
        <>
          <label className="grid gap-1 text-sm">
            {request.usernameLabel}
            <Input ref={username} autoComplete="off" required maxLength={256} />
          </label>
          <label className="grid gap-1 text-sm">
            {request.passwordLabel}
            <Input ref={password} type="password" autoComplete="off" required maxLength={1024} />
          </label>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        Sent directly to Muse's secure store. Values bypass the conversation and model context.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={!canWrite || pending || error !== null}>
          {pending
            ? "Saving…"
            : request.capture === "verification_code"
              ? "Submit code"
              : "Save securely"}
        </Button>
      </div>
    </form>
  );
}
