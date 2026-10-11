import { GROK_BOT_AVATAR_COLORS, GROK_BOT_PICKER_SHAPES } from "./grokBotAvatarShapes";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";

import { GrokBotAvatar } from "./GrokBotAvatar";

/**
 * The avatar as a button: opens the shape and color pickers, like the Grok Bot
 * app's character editor. The caller applies each choice and spins the bot.
 * A bot whose shape is not in the picker keeps it on the trigger but no cell is selected.
 */
export function GrokBotAppearancePicker({
  botId,
  shape,
  color,
  name,
  appearanceSignal,
  celebrating = false,
  disabled = false,
  shapes = GROK_BOT_PICKER_SHAPES,
  onSelectShape,
  onSelectColor,
}: {
  readonly botId: string;
  readonly shape: string;
  readonly color: string;
  readonly name: string;
  readonly appearanceSignal: number;
  readonly celebrating?: boolean;
  readonly disabled?: boolean;
  /** Defaults to the editor's shapes; create passes the subset the CLI accepts. */
  readonly shapes?: readonly string[];
  readonly onSelectShape: (shape: string) => void;
  readonly onSelectColor: (color: string) => void;
}) {
  const currentColor = color.trim().toLowerCase();
  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        aria-label={`Change ${name}'s look`}
        render={
          <button
            type="button"
            className="cursor-pointer rounded-2xl p-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-64"
          />
        }
      >
        <GrokBotAvatar
          bot={{ id: botId, name, avatarShape: shape, avatarColor: color }}
          size="xl"
          fillPx={64}
          appearanceSignal={appearanceSignal}
          state={celebrating ? "happy" : undefined}
        />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80">
        <div className="flex flex-col gap-3 p-1">
          <div role="group" aria-label="Shape" className="grid grid-cols-5 gap-1">
            {shapes.map((kind) => (
              <button
                key={kind}
                type="button"
                aria-label={kind}
                aria-pressed={kind === shape}
                className={cn(
                  "flex size-12 items-center justify-center rounded-lg outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  kind === shape && "bg-accent ring-2 ring-inset ring-foreground/70",
                )}
                onClick={() => onSelectShape(kind)}
              >
                <GrokBotAvatar
                  bot={{ id: kind, name: kind, avatarShape: kind, avatarColor: color }}
                  size="lg"
                  fillPx={36}
                />
              </button>
            ))}
          </div>
          <div role="group" aria-label="Color" className="flex flex-wrap gap-2">
            {Object.entries(GROK_BOT_AVATAR_COLORS).map(([id, hex]) => (
              <button
                key={id}
                type="button"
                aria-label={id}
                aria-pressed={id === currentColor}
                className={cn(
                  "size-8 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  id === currentColor && "ring-2 ring-inset ring-foreground/70",
                )}
                style={{ backgroundColor: id === "black" ? "var(--foreground)" : hex }}
                onClick={() => onSelectColor(id)}
              />
            ))}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
