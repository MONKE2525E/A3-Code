import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { grokBotsCreate } from "~/state/grokBots";
import { useAtomCommand } from "~/state/use-atom-command";

import { GrokBotAppearancePicker } from "./GrokBotAppearancePicker";
import { GROK_BOT_CREATE_SHAPES } from "./grokBotAvatarShapes";
import { grokBotFailureMessage, GROK_BOT_PROVIDER_INTENT } from "./grokBotPresentation";

const DRAFT_BOT_ID = "grok-bot-draft";
const DEFAULT_SHAPE = "blob";
const DEFAULT_COLOR = "blue";

/**
 * One bot being drafted in the Providers page. Nothing is created until Create bot; Cancel
 * drops the draft. Groups will need their own draft once group creation exists.
 */
export function GrokBotCreateDraft({
  environmentId,
  onCancel,
}: {
  readonly environmentId: EnvironmentId;
  readonly onCancel: () => void;
}) {
  const navigate = useNavigate();
  const canCreate = useAtomValue(grokBotsCreate.permissionAtom(environmentId));
  const create = useAtomCommand(grokBotsCreate, { reportFailure: false });
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [shape, setShape] = useState(DEFAULT_SHAPE);
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [nameAttempted, setNameAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedName = name.trim();
  const nameMissing = trimmedName.length === 0;

  const submit = async () => {
    if (pending) return;
    setNameAttempted(true);
    if (nameMissing) return;
    setPending(true);
    setError(null);
    const result = await create({
      environmentId,
      input: {
        name: trimmedName,
        description: instructions.trim(),
        avatarShape: shape,
        avatarColor: color,
      },
    });
    setPending(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      setError(grokBotFailureMessage(squashAtomCommandFailure(result)));
      return;
    }
    // Select the new bot on the same route; the editor falls back to the first bot until the roster lands.
    void navigate({
      to: "/settings/providers",
      search: (previous) => ({
        ...previous,
        botId: result.value.id,
        provider: GROK_BOT_PROVIDER_INTENT,
      }),
      replace: true,
      resetScroll: false,
    });
  };

  return (
    <form
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-3">
        <GrokBotAppearancePicker
          botId={DRAFT_BOT_ID}
          shape={shape}
          color={color}
          name={trimmedName || "New bot"}
          appearanceSignal={0}
          disabled={!canCreate || pending}
          shapes={GROK_BOT_CREATE_SHAPES}
          onSelectShape={setShape}
          onSelectColor={setColor}
        />
        <p className="text-xs text-muted-foreground">Click the bot to choose its look.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="grok-bot-create-name">Name</Label>
        <Input
          id="grok-bot-create-name"
          size="sm"
          maxLength={200}
          value={name}
          aria-invalid={nameAttempted && nameMissing}
          disabled={!canCreate || pending}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        {nameAttempted && nameMissing ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            Give the bot a name.
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="grok-bot-create-instructions">Instructions</Label>
        <Textarea
          id="grok-bot-create-instructions"
          size="sm"
          className="overflow-hidden [&_textarea]:resize-none"
          maxLength={16000}
          value={instructions}
          disabled={!canCreate || pending}
          onChange={(event) => setInstructions(event.currentTarget.value)}
        />
        <p className="text-xs text-muted-foreground">
          What this bot does and how it should behave. Optional.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={!canCreate || pending}>
          {pending ? <Spinner size="xs" /> : null}
          Create bot
        </Button>
        <Button type="button" size="sm" variant="ghost-muted" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        {!canCreate ? (
          <span className="text-xs text-muted-foreground">Needs settings write access.</span>
        ) : null}
      </div>
    </form>
  );
}
