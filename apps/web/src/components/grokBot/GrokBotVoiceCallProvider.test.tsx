import { EnvironmentId } from "@t3tools/contracts";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Fake media and socket: the real controller and call session run, but no microphone or network opens.
const fake = vi.hoisted(() => {
  const state = {
    starts: [] as Array<{ environmentId: string; botId: string }>,
    ends: [] as Array<{ environmentId: string; callId: string }>,
    audioCloses: 0,
    mintedCount: 0,
  };
  const started = (callId: string) => ({
    callId,
    credential: {
      clientSecret: "sek",
      expiresAtUnixSeconds: 0,
      model: "grok-voice",
      websocketUrl: "wss://api.x.ai/v1/realtime",
    },
    session: {
      instructions: "be brief",
      tools: [],
      hasOverheard: false,
      greeting: { direction: "", withLandedWork: "" },
    },
  });
  const commands: Record<
    string,
    (args: { environmentId: string; input: unknown }) => Promise<unknown>
  > = {
    start: async ({ environmentId, input }) => {
      state.starts.push({ environmentId, botId: (input as { botId: string }).botId });
      state.mintedCount += 1;
      return { _tag: "Success", value: started(`call-${state.mintedCount}`) };
    },
    refresh: async () => ({ _tag: "Success", value: started("refresh").credential }),
    tool: async () => ({ _tag: "Success", value: { kind: "served", output: {} } }),
    end: async ({ environmentId, input }) => {
      state.ends.push({ environmentId, callId: (input as { callId: string }).callId });
      return { _tag: "Success", value: {} };
    },
  };
  const socket = () => {
    let open = true;
    return {
      send: () => {},
      close: () => {
        open = false;
      },
      get isOpen() {
        return open;
      },
      onOpen: () => {},
      onMessage: () => {},
      onClose: () => {},
    };
  };
  return { state, commands, socket };
});

vi.mock("~/state/grokBotVoice", () => ({
  grokBotsVoiceStart: { tag: "start" },
  grokBotsVoiceRefresh: { tag: "refresh" },
  grokBotsVoiceTool: { tag: "tool" },
  grokBotsVoiceConnected: { tag: "connected" },
  grokBotsVoiceEnd: { tag: "end" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { tag: string }) => fake.commands[command.tag],
}));
vi.mock("./grokBotVoiceAudio", () => ({
  VoiceAudioError: class VoiceAudioError extends Error {},
  openVoiceAudio: async () => ({
    enqueue: () => {},
    clear: () => {},
    close: () => {
      fake.state.audioCloses += 1;
    },
  }),
}));
vi.mock("./grokBotVoiceSocket", () => ({
  openBrowserVoiceSocket: () => fake.socket(),
}));

import { GrokBotVoiceCallProvider } from "./GrokBotVoiceCallProvider";
import { useGrokBotVoiceCall, type GrokBotVoiceCallValue } from "./useGrokBotVoiceCall";

let api: GrokBotVoiceCallValue | null = null;
let renderer: ReactTestRenderer | null = null;

function voice(): GrokBotVoiceCallValue {
  if (api === null) throw new Error("the voice call probe is not mounted");
  return api;
}

// Publishes the latest context value after each commit, so tests read what a mounted consumer sees.
function Probe() {
  const value = useGrokBotVoiceCall();
  useEffect(() => {
    api = value;
  });
  return null;
}

// Each route mounts its own page, so a navigation remounts everything below the provider.
function Shell(props: { readonly route: "thread-a" | "thread-b" | "settings" }) {
  return (
    <GrokBotVoiceCallProvider>
      {props.route === "settings" ? <Probe key="settings" /> : <Probe key={props.route} />}
    </GrokBotVoiceCallProvider>
  );
}

const flush = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

async function mount(route: "thread-a" | "thread-b" | "settings") {
  await act(async () => {
    renderer = create(<Shell route={route} />);
  });
}

async function show(route: "thread-a" | "thread-b" | "settings") {
  await act(async () => {
    renderer!.update(<Shell route={route} />);
  });
}

async function startCall(botId: string, botName: string) {
  await act(async () => {
    voice().start({ environmentId: EnvironmentId.make("env-1"), botId, botName });
    await flush();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fake.state.starts.length = 0;
  fake.state.ends.length = 0;
  fake.state.audioCloses = 0;
  fake.state.mintedCount = 0;
  api = null;
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("grok bot voice call provider", () => {
  it("keeps a live call pinned to its bot and environment across thread and settings navigation", async () => {
    await mount("thread-a");
    await startCall("bot-a", "Ada");
    expect(voice().call?.state.phase).toBe("connecting");

    await show("settings");
    await show("thread-b");

    expect(voice().call).toMatchObject({ botId: "bot-a", botName: "Ada", environmentId: "env-1" });
    expect(voice().call?.state.phase).toBe("connecting");
    expect(fake.state.ends).toEqual([]);
    expect(fake.state.audioCloses).toBe(0);
  });

  it("refuses to start another bot while a call is live, without replacing or ending it", async () => {
    await mount("thread-a");
    await startCall("bot-a", "Ada");
    await startCall("bot-b", "Bo");

    expect(fake.state.starts).toEqual([{ environmentId: "env-1", botId: "bot-a" }]);
    expect(voice().call).toMatchObject({ botId: "bot-a", botName: "Ada" });
    expect(fake.state.ends).toEqual([]);
  });

  it("ends the live call on explicit hang-up and releases its microphone and server call", async () => {
    await mount("thread-a");
    await startCall("bot-a", "Ada");
    await act(async () => {
      voice().hangUp();
      await flush();
    });

    expect(voice().call?.state).toEqual({ phase: "idle", muted: false, notice: null });
    expect(fake.state.ends).toEqual([{ environmentId: "env-1", callId: "call-1" }]);
    expect(fake.state.audioCloses).toBe(1);
  });

  it("mutes and unmutes the live call from anywhere the provider is mounted", async () => {
    await mount("thread-a");
    await startCall("bot-a", "Ada");
    await show("settings");

    await act(async () => voice().setMuted(true));
    expect(voice().call?.state.muted).toBe(true);
    await act(async () => voice().setMuted(false));
    expect(voice().call?.state.muted).toBe(false);
    expect(voice().call?.state.phase).toBe("connecting");
  });

  it("can start a new call for another bot once the previous one has ended", async () => {
    await mount("thread-a");
    await startCall("bot-a", "Ada");
    await act(async () => voice().hangUp());
    await startCall("bot-b", "Bo");

    expect(fake.state.starts.map((start) => start.botId)).toEqual(["bot-a", "bot-b"]);
    expect(voice().call).toMatchObject({ botId: "bot-b", botName: "Bo" });
  });

  it("ends a live call when the app shell unmounts, such as on sign-out", async () => {
    await mount("thread-a");
    await startCall("bot-a", "Ada");
    await act(async () => renderer?.unmount());
    renderer = null;
    await flush();

    expect(fake.state.ends).toEqual([{ environmentId: "env-1", callId: "call-1" }]);
    expect(fake.state.audioCloses).toBe(1);
  });
});
