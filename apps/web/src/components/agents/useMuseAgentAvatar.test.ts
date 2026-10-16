import { EnvironmentId } from "@t3tools/contracts";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { museAgentAvatarQuery } from "~/state/museAgentAvatar";

import type { MuseAvatarState } from "./aiAgents";
import {
  instanceFromDescriptor,
  type MuseAgentAvatarProfile,
  pickVideoVariant,
  useMuseAgentAvatar,
} from "./useMuseAgentAvatar";

vi.mock("~/state/museAgentAvatar", () => ({
  museAgentAvatarQuery: vi.fn((input: unknown) => input),
}));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));

describe("instanceFromDescriptor", () => {
  it("reads the encoded provider instance from the server's descriptor path", () => {
    const url = `/api/ai-agents/muse/${encodeURIComponent("muse:work")}/avatar/image?revision=${"a".repeat(64)}`;
    expect(instanceFromDescriptor(url)).toBe("muse:work");
  });

  it("returns null for missing or foreign URLs", () => {
    expect(instanceFromDescriptor(undefined)).toBeNull();
    expect(instanceFromDescriptor("https://example.com/a.png")).toBeNull();
    expect(instanceFromDescriptor("/api/ai-agents/muse/%E0%A4%A/avatar/image")).toBeNull();
  });
});

describe("pickVideoVariant", () => {
  it("returns the variant key whose clip the avatar would play, preferring idle", () => {
    expect(pickVideoVariant({ talking: "/t", idle: "/i" })).toBe("idle");
    expect(pickVideoVariant({ talking: "/t" })).toBe("talking");
    expect(pickVideoVariant({})).toBeNull();
    expect(pickVideoVariant(undefined)).toBeNull();
  });
});

const ENVIRONMENT_ID = EnvironmentId.make("environment:work");
const REVISION = "a".repeat(64);
const WAITING_CLIP_URL = `/api/ai-agents/muse/${encodeURIComponent("muse:work")}/avatar/waiting-for-subagents?revision=${REVISION}`;

let renderer: ReactTestRenderer | undefined;

function Probe({ profile, state }: { profile: MuseAgentAvatarProfile; state: MuseAvatarState }) {
  useMuseAgentAvatar(ENVIRONMENT_ID, profile, { state });
  return null;
}

function renderAvatar(profile: MuseAgentAvatarProfile, state: MuseAvatarState) {
  act(() => {
    renderer = create(createElement(Probe, { profile, state }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.mocked(museAgentAvatarQuery).mockClear();
  vi.unstubAllGlobals();
});

describe("useMuseAgentAvatar variant requests", () => {
  it("requests the hyphenated waiting clip from the destination environment", () => {
    renderAvatar(
      { avatarRevision: REVISION, avatarVideoUrls: { "waiting-for-subagents": WAITING_CLIP_URL } },
      "waiting",
    );

    expect(museAgentAvatarQuery).toHaveBeenCalledTimes(1);
    expect(museAgentAvatarQuery).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: {
        providerInstanceId: "muse:work",
        variant: "waiting-for-subagents",
        revision: REVISION,
      },
    });
  });

  it.each(["Waiting-For-Subagents", "../idle", "waiting for subagents", "a".repeat(65), ""])(
    "does not request malformed variant %j",
    (variant) => {
      renderAvatar(
        { avatarRevision: REVISION, avatarVideoUrls: { [variant]: WAITING_CLIP_URL } },
        "waiting",
      );

      expect(museAgentAvatarQuery).not.toHaveBeenCalled();
    },
  );
});
