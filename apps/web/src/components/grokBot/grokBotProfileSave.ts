import type { GrokBot } from "@t3tools/contracts";

import { grokBotErrorReason } from "./grokBotConversation";

export const UNCERTAIN_SAVE_MESSAGE =
  "Couldn't confirm this change was saved. Refresh to check Grok Bot.";

/**
 * Reasons that prove the bot profile was not written, so an optimistic change can roll back.
 * Any other failure, including an interrupted request, may already have reached Grok Bot.
 */
const REJECTED_PROFILE_SAVE_REASONS: ReadonlySet<string> = new Set([
  "cli_unavailable",
  "signed_out",
  "native_unavailable",
  "permission_denied",
  "bot_not_found",
  "invalid_avatar",
]);

export function isGrokBotProfileSaveRejected(error: unknown, interrupted: boolean): boolean {
  if (interrupted) return false;
  const reason = grokBotErrorReason(error);
  return reason !== null && REJECTED_PROFILE_SAVE_REASONS.has(reason);
}

export type ProfilePatch = Partial<
  Pick<
    GrokBot,
    | "name"
    | "label"
    | "description"
    | "notificationEnabled"
    | "hidden"
    | "pinned"
    | "avatarShape"
    | "avatarColor"
  >
>;

export interface SaveIssue {
  readonly message: string;
  /** The fields whose save outcome is unknown. Null when the failure proved nothing was written. */
  readonly uncertain: ProfilePatch | null;
}

/** An optimistic look. `acceptedAt` is null while the save request is in flight. */
export interface PendingLook {
  readonly shape: string;
  readonly color: string;
  readonly acceptedAt: number | null;
}

export interface ProfileSaveState {
  readonly look: PendingLook | null;
  readonly issue: SaveIssue | null;
}

/** True when the roster already shows every field the patch sets. */
export function profilePatchShown(patch: ProfilePatch, bot: GrokBot): boolean {
  return (Object.keys(patch) as (keyof ProfilePatch)[]).every(
    (field) => patch[field] === bot[field],
  );
}

/**
 * Settles the held look and the save issue against one roster snapshot, so every rule reads the
 * same state. Returns the same object when nothing changes, which keeps it safe to call in render.
 *
 * Only a roster that shows the patch proves a save. A roster that still shows the old value proves
 * nothing, because a failed native read can fall back to a CLI roster. A newer roster read after an
 * accepted look leaves that look unconfirmed, which is not a rejection.
 */
export function reconcileProfileSave(
  state: ProfileSaveState,
  bot: GrokBot,
  rosterUpdatedAt: number,
): ProfileSaveState {
  const { look, issue } = state;
  const lookShown =
    look !== null && look.shape === bot.avatarShape && look.color === bot.avatarColor;
  const nextLook = lookShown ? null : look;
  const issueShown = issue?.uncertain != null && profilePatchShown(issue.uncertain, bot);
  let nextIssue = issueShown ? null : issue;
  if (
    nextLook?.acceptedAt != null &&
    rosterUpdatedAt > nextLook.acceptedAt &&
    nextIssue?.uncertain == null
  ) {
    nextIssue = {
      message: UNCERTAIN_SAVE_MESSAGE,
      uncertain: { avatarShape: nextLook.shape, avatarColor: nextLook.color },
    };
  }
  return nextLook === look && nextIssue === issue ? state : { look: nextLook, issue: nextIssue };
}
