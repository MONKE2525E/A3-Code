import { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

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

vi.mock("/src/state/grokBotVoice.ts", () => ({
  grokBotsVoiceStart: { tag: "start" },
  grokBotsVoiceRefresh: { tag: "refresh" },
  grokBotsVoiceTool: { tag: "tool" },
  grokBotsVoiceConnected: { tag: "connected" },
  grokBotsVoiceEnd: { tag: "end" },
}));
vi.mock("/src/state/use-atom-command.ts", () => ({
  useAtomCommand: (command: { tag: string }) => fake.commands[command.tag],
}));
vi.mock("/src/connection/catalog.ts", () => ({
  environmentCatalog: { stateAtom: () => "connection" },
}));
vi.mock("/src/rpc/atomRegistry.ts", () => ({
  appAtomRegistry: { get: () => ({ _tag: "Initial" }), subscribe: () => () => {} },
}));
vi.mock("/src/components/grokBot/grokBotVoiceAudio.ts", () => ({
  VoiceAudioError: class VoiceAudioError extends Error {},
  openVoiceAudio: async () => ({
    enqueue: () => {},
    clear: () => {},
    close: () => {
      fake.state.audioCloses += 1;
    },
  }),
}));
vi.mock("/src/components/grokBot/grokBotVoiceSocket.ts", () => ({
  openBrowserVoiceSocket: () => fake.socket(),
}));

import { GrokBotVoiceCallProvider } from "./GrokBotVoiceCallProvider";
import { useGrokBotVoiceCall, type GrokBotVoiceCallValue } from "./useGrokBotVoiceCall";

function setup() {
  fake.state.starts.length = 0;
  fake.state.ends.length = 0;
  fake.state.audioCloses = 0;
  fake.state.mintedCount = 0;
  let api: GrokBotVoiceCallValue | null = null;
  function voice(): GrokBotVoiceCallValue {
    if (api === null) throw new Error("the voice call probe is not mounted");
    return api;
  }
  function Probe() {
    const value = useGrokBotVoiceCall();
    useEffect(() => {
      api = value;
    });
    return <output>{value.call?.state.phase ?? "idle"}</output>;
  }
  function Shell(props: { readonly route: "thread-a" | "thread-b" | "settings" }) {
    return (
      <GrokBotVoiceCallProvider>
        <Probe key={props.route} />
      </GrokBotVoiceCallProvider>
    );
  }
  async function startCall(botId: string, botName: string) {
    await act(() => voice().start({ environmentId: EnvironmentId.make("env-1"), botId, botName }));
    await vi.waitFor(() => expect(voice().call?.state.phase).toBe("connecting"));
  }
  return { Shell, voice, startCall };
}

describe("grok bot voice call provider", () => {
  it("keeps a live call pinned to its bot and environment across thread and settings navigation", async () => {
    const { Shell, voice, startCall } = setup();
    await using screen = await render(<Shell route="thread-a" />);
    await startCall("bot-a", "Ada");
    expect(voice().call?.state.phase).toBe("connecting");

    await screen.rerender(<Shell route="settings" />);
    await screen.rerender(<Shell route="thread-b" />);

    expect(voice().call).toMatchObject({ botId: "bot-a", botName: "Ada", environmentId: "env-1" });
    expect(voice().call?.state.phase).toBe("connecting");
    expect(fake.state.ends).toEqual([]);
    expect(fake.state.audioCloses).toBe(0);
  });

  it("refuses to start another bot while a call is live, without replacing or ending it", async () => {
    const { Shell, voice, startCall } = setup();
    await using _screen = await render(<Shell route="thread-a" />);
    await startCall("bot-a", "Ada");
    await startCall("bot-b", "Bo");

    expect(fake.state.starts).toEqual([{ environmentId: "env-1", botId: "bot-a" }]);
    expect(voice().call).toMatchObject({ botId: "bot-a", botName: "Ada" });
    expect(fake.state.ends).toEqual([]);
  });

  it("ends the live call on explicit hang-up and releases its microphone and server call", async () => {
    const { Shell, voice, startCall } = setup();
    await using _screen = await render(<Shell route="thread-a" />);
    await startCall("bot-a", "Ada");
    await act(async () => {
      voice().hangUp();
    });

    expect(voice().call?.state).toEqual({ phase: "idle", muted: false, notice: null });
    await vi.waitFor(() =>
      expect(fake.state.ends).toEqual([{ environmentId: "env-1", callId: "call-1" }]),
    );
    expect(fake.state.audioCloses).toBe(1);
  });

  it("mutes and unmutes the live call from anywhere the provider is mounted", async () => {
    const { Shell, voice, startCall } = setup();
    await using screen = await render(<Shell route="thread-a" />);
    await startCall("bot-a", "Ada");
    await screen.rerender(<Shell route="settings" />);

    await act(async () => voice().setMuted(true));
    expect(voice().call?.state.muted).toBe(true);
    await act(async () => voice().setMuted(false));
    expect(voice().call?.state.muted).toBe(false);
    expect(voice().call?.state.phase).toBe("connecting");
  });

  it("can start a new call for another bot once the previous one has ended", async () => {
    const { Shell, voice, startCall } = setup();
    await using _screen = await render(<Shell route="thread-a" />);
    await startCall("bot-a", "Ada");
    await act(async () => voice().hangUp());
    await startCall("bot-b", "Bo");

    expect(fake.state.starts.map((start) => start.botId)).toEqual(["bot-a", "bot-b"]);
    expect(voice().call).toMatchObject({ botId: "bot-b", botName: "Bo" });
  });

  it("ends a live call when the app shell unmounts, such as on sign-out", async () => {
    const { Shell, startCall } = setup();
    await using screen = await render(<Shell route="thread-a" />);
    await startCall("bot-a", "Ada");
    await screen.unmount();

    await vi.waitFor(() =>
      expect(fake.state.ends).toEqual([{ environmentId: "env-1", callId: "call-1" }]),
    );
    expect(fake.state.audioCloses).toBe(1);
  });
});
