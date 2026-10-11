import type { GrokBot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type ProfileSaveState,
  isGrokBotProfileSaveRejected,
  reconcileProfileSave,
  UNCERTAIN_SAVE_MESSAGE,
} from "./grokBotProfileSave";

const grokBotError = (reason: string) => ({ _tag: "GrokBotError", reason });

const bot = (partial: Partial<GrokBot> = {}): GrokBot =>
  ({
    id: "dr-chicken",
    name: "Dr. Chicken",
    label: "",
    description: "",
    avatarShape: "blob",
    avatarColor: "red",
    notificationEnabled: true,
    hidden: false,
    pinned: false,
    featured: false,
    pullRequests: [],
    ...partial,
  }) as GrokBot;

const NEW_LOOK = { avatarShape: "house", avatarColor: "violet" };
const acceptedLook = (acceptedAt: number | null) => ({
  shape: "house",
  color: "violet",
  acceptedAt,
});
const uncertainLook: ProfileSaveState = {
  look: acceptedLook(100),
  issue: { message: UNCERTAIN_SAVE_MESSAGE, uncertain: NEW_LOOK },
};

describe("isGrokBotProfileSaveRejected", () => {
  it("rolls back only for reasons that prove the profile was not written", () => {
    expect(isGrokBotProfileSaveRejected(grokBotError("native_unavailable"), false)).toBe(true);
    expect(isGrokBotProfileSaveRejected(grokBotError("permission_denied"), false)).toBe(true);
    expect(isGrokBotProfileSaveRejected(grokBotError("invalid_avatar"), false)).toBe(true);
  });

  it("treats an uncertain save as unknown, not as a rejection", () => {
    expect(isGrokBotProfileSaveRejected(grokBotError("profile_save_uncertain"), false)).toBe(false);
    expect(isGrokBotProfileSaveRejected(grokBotError("gateway_failed"), false)).toBe(false);
  });

  it("does not trust errors it cannot identify as Grok Bot errors", () => {
    expect(isGrokBotProfileSaveRejected(new Error("permission_denied"), false)).toBe(false);
    expect(
      isGrokBotProfileSaveRejected({ _tag: "OtherError", reason: "native_unavailable" }, false),
    ).toBe(false);
    expect(isGrokBotProfileSaveRejected(undefined, false)).toBe(false);
  });

  it("keeps an interrupted request uncertain even when its error names a rejection", () => {
    expect(isGrokBotProfileSaveRejected(grokBotError("native_unavailable"), true)).toBe(false);
  });
});

describe("reconcileProfileSave", () => {
  it("clears the held look and its uncertainty together when the roster shows the look", () => {
    // The roster shows the look after the uncertain save. A later roster read must not re-flag it.
    expect(reconcileProfileSave(uncertainLook, bot(NEW_LOOK), 200)).toEqual({
      look: null,
      issue: null,
    });
  });

  it("does not claim the save is unconfirmed while the roster has not been read since acceptance", () => {
    const state: ProfileSaveState = { look: acceptedLook(100), issue: null };
    expect(reconcileProfileSave(state, bot(), 100)).toBe(state);
  });

  it("marks an accepted look unconfirmed, not rejected, when a newer roster still shows the old look", () => {
    const state: ProfileSaveState = { look: acceptedLook(100), issue: null };
    expect(reconcileProfileSave(state, bot(), 200)).toEqual({
      look: acceptedLook(100),
      issue: { message: UNCERTAIN_SAVE_MESSAGE, uncertain: NEW_LOOK },
    });
  });

  it("keeps the uncertainty when an explicit refresh still shows the old look", () => {
    // A refresh can fall back to a CLI roster, so disagreeing with it proves nothing.
    expect(reconcileProfileSave(uncertainLook, bot(), 300)).toBe(uncertainLook);
  });

  it("does not settle a look while its save is still in flight", () => {
    const state: ProfileSaveState = { look: acceptedLook(null), issue: null };
    expect(reconcileProfileSave(state, bot(), 300)).toBe(state);
  });

  it("clears an uncertain field save only once the roster shows that field", () => {
    const nameIssue: ProfileSaveState = {
      look: null,
      issue: { message: UNCERTAIN_SAVE_MESSAGE, uncertain: { name: "Dr. Hen" } },
    };
    expect(reconcileProfileSave(nameIssue, bot(), 300)).toBe(nameIssue);
    expect(reconcileProfileSave(nameIssue, bot({ name: "Dr. Hen" }), 300)).toEqual({
      look: null,
      issue: null,
    });
  });

  it("returns the same state once settled, so render-phase reconciliation cannot loop", () => {
    const settled = reconcileProfileSave(uncertainLook, bot(), 300);
    expect(reconcileProfileSave(settled, bot(), 300)).toBe(settled);
  });
});
