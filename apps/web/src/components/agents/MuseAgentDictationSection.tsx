import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { VoiceAudioError } from "~/components/grokBot/grokBotVoiceAudio";
import { museAgentDictationCommand, museAgentFeatureReadQuery } from "~/state/museAgent";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  createPcmRecorder,
  dictationCaptureSupport,
  type DictationBlock,
} from "./museAgentDictationAudio";
import { openDictationCapture, type DictationCapture } from "./museAgentDictationCapture";

type Phase = "idle" | "starting" | "recording" | "transcribing" | "review";

export type MuseChatDraft = {
  readonly start: (prompt: string) => Promise<void>;
  readonly canOpen: boolean;
  readonly error: string | null;
};

const EMPTY_PCM = new Uint8Array(0);

function captureBlock(): DictationBlock {
  return dictationCaptureSupport({
    isSecureContext: typeof window !== "undefined" && window.isSecureContext,
    hasMediaDevices: typeof navigator !== "undefined" && navigator.mediaDevices !== undefined,
    hasAudioContext: typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined",
  });
}

function recordingErrorMessage(error: unknown): string {
  if (!(error instanceof VoiceAudioError)) return "Recording could not start. Try again.";
  switch (error.reason) {
    case "permission_denied":
      return "Microphone access was blocked. Allow it for this site, then try again.";
    case "no_microphone":
      return "No microphone was found.";
    case "insecure_context":
      return "Microphone access needs HTTPS or localhost.";
    case "unsupported":
      return "This browser can't record audio here.";
    case "failed":
      return "Recording could not start. Try again.";
  }
}

/** Declared request errors carry their own static message; anything else stays generic. */
function transcriptionErrorMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "MuseAgentDictationRequestError" &&
    failure instanceof Error
  ) {
    return failure.message;
  }
  return "Dictation could not be completed. Check the connection and try again.";
}

function unavailableMessage(status: {
  readonly engineDetected: boolean;
  readonly modelDetected: boolean;
  readonly reason: string;
}): string {
  if (status.reason === "unsupported_host") {
    return "Local dictation isn't supported on the machine running Muse.";
  }
  if (status.engineDetected && !status.modelDetected) {
    return "Speech helper detected. Prepare the local speech model in Muse for Linux to turn dictation on.";
  }
  return "Prepare Muse for Linux's speech helper and model to turn dictation on.";
}

/**
 * Local push-to-record dictation. Nothing records until the user presses Record, audio goes only
 * to this environment's server for on-device transcription, and the transcript is edited here
 * before the user chooses to put it in the Muse chat. It is never sent automatically.
 */
export function MuseAgentDictationSection({
  environmentId,
  providerInstanceId,
  chat,
  onActiveChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly chat: MuseChatDraft;
  /** True while capture, transcription, or an unsent transcript would be lost by leaving. */
  readonly onActiveChange: (active: boolean) => void;
}) {
  const statusRead = useEnvironmentQuery(
    museAgentFeatureReadQuery({
      environmentId,
      input: { operation: "dictation", providerInstanceId },
    }),
  );
  const status = statusRead.data?.operation === "dictation" ? statusRead.data.data : null;
  const permissionInput = useMemo(
    () => ({ providerInstanceId, pcm: EMPTY_PCM }),
    [providerInstanceId],
  );
  const canTranscribe = useAtomValue(
    museAgentDictationCommand.permissionAtom(environmentId, permissionInput),
  );
  const transcribe = useAtomCommand(museAgentDictationCommand, { reportFailure: false });

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [seconds, setSeconds] = useState(0);
  // Bumped whenever the recording is stopped, discarded, or abandoned; late async results from an
  // older generation are dropped and their microphone released instead of updating the screen.
  const generation = useRef(0);
  const capture = useRef<DictationCapture | null>(null);
  const recorder = useRef(createPcmRecorder());

  const release = useCallback(() => {
    capture.current?.stop();
    capture.current = null;
  }, []);

  // Leaving unmounts this section: stop the microphone and ignore any in-flight transcription.
  useEffect(
    () => () => {
      generation.current += 1;
      release();
      onActiveChange(false);
    },
    [release, onActiveChange],
  );

  const active = phase === "review" ? transcript.trim().length > 0 : phase !== "idle";
  useEffect(() => {
    onActiveChange(active);
  }, [active, onActiveChange]);

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = window.setInterval(() => setSeconds(Math.floor(recorder.current.seconds())), 500);
    return () => window.clearInterval(timer);
  }, [phase]);

  const finish = useCallback(
    async (gen: number) => {
      if (generation.current !== gen) return;
      // Stop and the 60-second limit can both land here; only the first one proceeds.
      gen = generation.current += 1;
      release();
      const pcm = recorder.current.finish();
      if (pcm === null) {
        setError("No audio was captured. Hold on for a moment after pressing Record.");
        setPhase("idle");
        return;
      }
      setPhase("transcribing");
      const result = await transcribe({ environmentId, input: { providerInstanceId, pcm } });
      if (generation.current !== gen) return;
      if (result._tag === "Success") {
        setTranscript(result.value.text);
        setPhase("review");
        return;
      }
      setPhase("idle");
      if (!isAtomCommandInterrupted(result)) {
        setError(transcriptionErrorMessage(squashAtomCommandFailure(result)));
      }
    },
    [environmentId, providerInstanceId, release, transcribe],
  );

  const start = async () => {
    const gen = (generation.current += 1);
    recorder.current = createPcmRecorder();
    setError(null);
    setSeconds(0);
    setPhase("starting");
    try {
      const opened = await openDictationCapture({
        isStale: () => generation.current !== gen,
        onPcm: (pcm) => {
          if (generation.current === gen && recorder.current.push(pcm).full) void finish(gen);
        },
      });
      if (opened === null) return;
      capture.current = opened;
      setPhase("recording");
    } catch (failure) {
      if (generation.current !== gen) return;
      setError(recordingErrorMessage(failure));
      setPhase("idle");
    }
  };

  const discard = () => {
    generation.current += 1;
    release();
    recorder.current = createPcmRecorder();
    setTranscript("");
    setError(null);
    setPhase("idle");
  };

  if (status === null) {
    if (statusRead.error === null) {
      return (
        <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Spinner className="size-4" /> Checking local dictation…
        </div>
      );
    }
    return (
      <div role="alert" className="grid gap-2 py-6 text-sm">
        <p className="text-foreground">Dictation status could not be loaded.</p>
        <p className="text-xs text-muted-foreground">{statusRead.error}</p>
        <Button size="sm" variant="outline" className="w-fit" onClick={statusRead.refresh}>
          <RefreshIcon /> Try again
        </Button>
      </div>
    );
  }

  const blocked = captureBlock();
  const unavailable = !status.available
    ? unavailableMessage(status)
    : !canTranscribe || !chat.canOpen
      ? "This connection doesn't have permission to use dictation."
      : blocked === "insecure"
        ? "Microphone access needs HTTPS or localhost. Open T3 Code over a secure connection."
        : blocked === "unsupported"
          ? "This browser can't record audio here."
          : null;
  const busy = phase === "starting" || phase === "recording" || phase === "transcribing";

  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        Speak, review the text, then add it to your Muse chat. Audio is transcribed on the machine
        running Muse and is not kept. Nothing is sent until you send it.
      </p>
      {unavailable !== null ? (
        <div role="status" className="grid gap-2 text-sm text-muted-foreground">
          <p>{unavailable}</p>
          <Button size="sm" variant="outline" className="w-fit" onClick={statusRead.refresh}>
            <RefreshIcon /> Check again
          </Button>
        </div>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {phase === "review" ? (
        <div className="grid gap-2">
          <Textarea
            aria-label="Dictation transcript"
            value={transcript}
            onChange={(event) => setTranscript(event.target.value)}
          />
          {chat.error ? (
            <p role="alert" className="text-xs text-destructive">
              {chat.error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!chat.canOpen || transcript.trim().length === 0}
              onClick={() => void chat.start(transcript.trim())}
            >
              Use in chat
            </Button>
            <Button variant="outline" onClick={discard}>
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {phase === "recording" ? (
            <Button onClick={() => void finish(generation.current)}>Stop and transcribe</Button>
          ) : (
            <Button disabled={unavailable !== null || busy} onClick={() => void start()}>
              {phase === "starting" ? "Opening microphone…" : "Record"}
            </Button>
          )}
          {busy ? (
            <Button variant="outline" onClick={discard}>
              {phase === "transcribing" ? "Discard" : "Cancel"}
            </Button>
          ) : null}
          {phase === "recording" ? (
            <span role="status" className="text-xs text-muted-foreground">
              Recording · {seconds}s of {status.maxAudioSeconds}s
            </span>
          ) : null}
          {phase === "transcribing" ? (
            <span role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" /> Transcribing on this machine…
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
