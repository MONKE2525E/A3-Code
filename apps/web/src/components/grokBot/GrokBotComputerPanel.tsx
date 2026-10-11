import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import {
  grokBotComputerQuery,
  grokBotComputerStart,
  grokBotTeachQuery,
  grokBotTeachStart,
  grokBotTeachStop,
} from "~/state/grokBotComputer";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { GrokBotComputerMaintenance } from "./GrokBotComputerMaintenance";
import { GrokBotComputerScreen } from "./GrokBotComputerScreen";

export function GrokBotComputerPanel({
  environmentId,
  botId,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
}) {
  const canOperate = useAtomValue(grokBotComputerStart.permissionAtom(environmentId));
  const computer = useEnvironmentQuery(
    canOperate ? grokBotComputerQuery({ environmentId, input: { botId } }) : null,
  );
  const start = useAtomCommand(grokBotComputerStart);
  const teaching = useEnvironmentQuery(
    canOperate ? grokBotTeachQuery({ environmentId, input: { botId } }) : null,
  );
  const startTeaching = useAtomCommand(grokBotTeachStart);
  const stopTeaching = useAtomCommand(grokBotTeachStop);
  const [now, setNow] = useState(() => Date.now());
  const recording = teaching.data?.state === "recording";
  const recordingHere = recording && teaching.data?.agentId === botId;
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recording]);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = async () => {
    if (busy || !canOperate) return;
    setBusy(true);
    setError(null);
    const result = await start({ environmentId, input: { botId } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      setError(String(squashAtomCommandFailure(result)));
  };
  const teach = async (save?: boolean) => {
    if (busy || !canOperate) return;
    setBusy(true);
    setError(null);
    const result =
      save === undefined
        ? await startTeaching({
            environmentId,
            input: { botId, entryPoint: "fullscreen_title_bar" },
          })
        : await stopTeaching({ environmentId, input: { botId, save } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(String(squashAtomCommandFailure(result)));
      teaching.refresh();
    }
  };
  const elapsed = Math.max(0, Math.floor((now - (teaching.data?.startedAtMs ?? now)) / 1000));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-sm">Grok Bot computer</span>
        <div className="flex items-center gap-2">
          {recordingHere ? (
            <>
              <span role="status" className="text-sm text-muted-foreground">
                Recording {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
              </span>
              <Button size="sm" disabled={busy} onClick={() => void teach(true)}>
                Stop and save
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void teach(false)}>
                Discard
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={
                !canOperate ||
                busy ||
                !computer.data?.socketUrl ||
                recording ||
                !teaching.data ||
                Boolean(teaching.error)
              }
              onClick={() => void teach()}
            >
              {recording ? "Another bot is recording" : "Teach a task"}
            </Button>
          )}
          <GrokBotComputerMaintenance environmentId={environmentId} />
          <Button
            size="sm"
            variant="outline"
            disabled={!canOperate || busy}
            onClick={() => {
              setConnectionAttempt((attempt) => attempt + 1);
              computer.refresh();
              teaching.refresh();
            }}
          >
            Reconnect
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {teaching.error ? (
        <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
          Teach a task is unavailable. Reconnect to try again.
        </p>
      ) : null}
      {computer.data?.socketUrl && canOperate && !computer.error ? (
        <GrokBotComputerScreen key={connectionAttempt} socketUrl={computer.data.socketUrl} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-center">
          {computer.isPending || busy ? <Spinner /> : null}
          <p className="text-sm text-muted-foreground">
            {!canOperate
              ? "Computer control requires permission to operate this environment."
              : (error ??
                computer.error ??
                (computer.data
                  ? `Computer ${computer.data.state}.`
                  : "Connect to this bot’s cloud computer."))}
          </p>
          {canOperate ? (
            <Button size="sm" disabled={busy || computer.isPending} onClick={() => void connect()}>
              Start computer
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
