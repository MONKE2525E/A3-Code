import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as RpcClientError from "effect/rpc/RpcClientError";

import { act, render as renderScreen } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ open: vi.fn(), allowed: true }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => mocks.allowed,
}));
vi.mock("/src/state/museAgent.ts", () => ({ museAgentOpenThread: { permissionAtom: () => ({}) } }));
vi.mock("/src/state/use-atom-command.ts", () => ({
  useAtomCommand:
    () =>
    (...args: unknown[]) =>
      mocks.open(...args),
}));
import {
  guardMuseAgentTurnDispatch,
  museAgentAttachScopeIdentity,
  resolveMuseAgentComposerSendBlockedReason,
  MuseAgentRouteConnection,
} from "./MuseAgentRouteConnection";

type AttachGate = { sendAllowed: boolean; sendBlockedReason: string | null };

const environmentId = EnvironmentId.make("remote-env");
const providerInstanceId = ProviderInstanceId.make("historical-muse-provider");
const main = ThreadId.make(`muse-agent:${"a".repeat(64)}`);
const side = ThreadId.make(`${main}:${encodeURIComponent("side:one")}`);

function routeProps(
  overrides: Partial<{
    threadId: ThreadId;
    connected: boolean;
    hasMessages: boolean;
    environmentId: EnvironmentId;
    providerInstanceId: ProviderInstanceId;
  }> = {},
) {
  return {
    environmentId,
    providerInstanceId,
    threadId: main,
    connected: true,
    hasMessages: true,
    ...overrides,
  };
}

it("leaves ordinary-thread send unblocked until a Muse route reports", () => {
  setup();

  expect(resolveMuseAgentComposerSendBlockedReason(false, undefined)).toBeNull();
  expect(resolveMuseAgentComposerSendBlockedReason(false, "Connecting Muse history…")).toBeNull();
  expect(resolveMuseAgentComposerSendBlockedReason(true, undefined)).toBe(
    "Connecting Muse history…",
  );
  expect(resolveMuseAgentComposerSendBlockedReason(true, null)).toBeNull();
  expect(resolveMuseAgentComposerSendBlockedReason(true, "Retry Muse connection to send")).toBe(
    "Retry Muse connection to send",
  );
});

it.each([main, side])(
  "reattaches restored %s after connection and reconnect without reopening on render",
  async (threadId) => {
    setup();

    mocks.open.mockReset().mockResolvedValue({ _tag: "Success", value: { threadId } });
    const container = document.createElement("div");
    await using root = await renderScreen(<></>, { container });
    const render = (connected: boolean) =>
      root.rerender(
        <MuseAgentRouteConnection
          {...{ environmentId, providerInstanceId, threadId, connected, hasMessages: true }}
        />,
      );
    try {
      await act(async () => render(false));
      expect(mocks.open).not.toHaveBeenCalled();
      await act(async () => render(true));
      expect(mocks.open).toHaveBeenCalledTimes(1);
      expect(mocks.open).toHaveBeenLastCalledWith({
        environmentId,
        input: { providerInstanceId, ...(threadId === side ? { sessionId: "side:one" } : {}) },
      });
      expect(container.textContent).toBe("");
      await act(async () => render(true));
      expect(mocks.open).toHaveBeenCalledTimes(1);
      await act(async () => render(false));
      await act(async () => render(true));
      expect(mocks.open).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("surfaces attach errors and retries the restored conversation", async () => {
  setup();

  mocks.open
    .mockReset()
    .mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Wait for the active Muse turn and retry.")),
    })
    .mockResolvedValue({ _tag: "Success", value: { threadId: side } });
  const container = document.createElement("div");
  await using root = await renderScreen(<></>, { container });
  try {
    await act(async () =>
      root.rerender(
        <MuseAgentRouteConnection
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          threadId={side}
          connected
          hasMessages
        />,
      ),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("active Muse turn");
    await act(async () => container.querySelector("button")!.click());
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(mocks.open.mock.calls[1]).toEqual(mocks.open.mock.calls[0]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  [
    "unavailable",
    new EnvironmentRpcUnavailableError({
      environmentId: "env",
      message: "socket timeout token=secret",
    }),
  ],
  [
    "unknown-method",
    new RpcClientError.RpcClientError({
      reason: new RpcClientError.RpcClientDefect({
        message: "method not found",
        cause: new Error("method not found"),
      }),
    }),
  ],
] as const)(
  "shows a retryable error after %s RPC failure instead of silent absence",
  async (_label, failure) => {
    setup();

    mocks.open.mockReset().mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(failure),
    });
    const container = document.createElement("div");
    await using root = await renderScreen(<></>, { container });
    try {
      await act(async () =>
        root.rerender(
          <MuseAgentRouteConnection
            environmentId={environmentId}
            providerInstanceId={providerInstanceId}
            threadId={main}
            connected
            hasMessages
          />,
        ),
      );
      expect(container.textContent).toContain("Could not reconnect this Muse conversation.");
      expect(container.textContent).not.toContain("socket timeout");
      expect(container.textContent).not.toContain("secret");
      expect(container.textContent).not.toContain("method not found");
      expect(container.querySelector("button")?.textContent).toContain("Retry Muse connection");
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("shows a chat loading pane until the first history arrives", async () => {
  setup();

  let finish: (value: unknown) => void = () => {
    throw new Error("not started");
  };
  mocks.open.mockReset().mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const container = document.createElement("div");
  await using root = await renderScreen(<></>, { container });
  try {
    await act(async () =>
      root.rerender(
        <MuseAgentRouteConnection
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          threadId={main}
          connected
          hasMessages={false}
        />,
      ),
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Opening Muse");
    expect(container.textContent).toContain("Loading conversation history.");
    expect(container.textContent).not.toContain("Nothing is sent to Muse");
    expect(container.textContent).not.toContain("Connecting Muse history");
    await act(async () => finish({ _tag: "Success", value: { threadId: main } }));
    expect(container.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
  }
});

it("does not attach without destination permission", async () => {
  setup();

  mocks.allowed = false;
  mocks.open.mockClear();
  const container = document.createElement("div");
  await using root = await renderScreen(<></>, { container });
  try {
    await act(async () =>
      root.rerender(
        <MuseAgentRouteConnection
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          threadId={main}
          connected
          hasMessages
        />,
      ),
    );
    expect(mocks.open).not.toHaveBeenCalled();
    expect(container.textContent).toContain("permission");
  } finally {
    await act(async () => root.unmount());
  }
});

it("blocks send on the first paint of a delayed open with a cached feed", async () => {
  setup();

  let finish: (value: unknown) => void = () => {
    throw new Error("not started");
  };
  mocks.open.mockReset().mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const gate: { current: AttachGate | null } = { current: null };
  const container = document.createElement("div");
  await using root = await renderScreen(<></>, { container });
  try {
    await act(async () =>
      root.rerender(
        <MuseAgentRouteConnection {...routeProps()}>
          {(value) => {
            gate.current = value;
            return <span>{value.sendAllowed ? "allow" : value.sendBlockedReason}</span>;
          }}
        </MuseAgentRouteConnection>,
      ),
    );
    expect(container.textContent).toContain("Connecting Muse history…");
    expect(container.textContent).not.toContain("Opening Muse");
    expect(gate.current?.sendAllowed).toBe(false);
    await act(async () => finish({ _tag: "Success", value: { threadId: main } }));
    expect(container.textContent).toContain("allow");
    expect(gate.current).toEqual({ sendAllowed: true, sendBlockedReason: null });
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps send blocked through error and retry until attach succeeds", async () => {
  setup();

  let finish: (value: unknown) => void = () => {
    throw new Error("not started");
  };
  mocks.open
    .mockReset()
    .mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(new Error("Wait for the active Muse turn and retry.")),
    })
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const gate: { current: AttachGate | null } = { current: null };
  const container = document.createElement("div");
  await using root = await renderScreen(<></>, { container });
  try {
    await act(async () =>
      root.rerender(
        <MuseAgentRouteConnection {...routeProps()}>
          {(value) => {
            gate.current = value;
            return <span>{value.sendAllowed ? "allow" : value.sendBlockedReason}</span>;
          }}
        </MuseAgentRouteConnection>,
      ),
    );
    expect(container.textContent).toContain("Retry Muse connection to send");
    expect(container.textContent).toContain("active Muse turn");
    expect(gate.current?.sendAllowed).toBe(false);
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toContain("Connecting Muse history…");
    expect(gate.current?.sendAllowed).toBe(false);
    expect(mocks.open).toHaveBeenCalledTimes(2);
    await act(async () => finish({ _tag: "Success", value: { threadId: main } }));
    expect(container.textContent).toContain("allow");
    expect(gate.current?.sendAllowed).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

it("shows retry after an interrupted open and unlocks after retry", async () => {
  setup();

  let finish: (value: unknown) => void = () => {
    throw new Error("not started");
  };
  mocks.open
    .mockReset()
    .mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.interrupt(),
    })
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const gate: { current: AttachGate | null } = { current: null };
  const container = document.createElement("div");
  await using root = await renderScreen(<></>, { container });
  try {
    await act(async () =>
      root.rerender(
        <MuseAgentRouteConnection {...routeProps()}>
          {(value) => {
            gate.current = value;
            return <span>{value.sendAllowed ? "allow" : value.sendBlockedReason}</span>;
          }}
        </MuseAgentRouteConnection>,
      ),
    );
    expect(container.textContent).toContain("interrupted");
    expect(container.querySelector("button")?.textContent).toContain("Retry Muse connection");
    expect(gate.current?.sendAllowed).toBe(false);
    await act(async () => container.querySelector("button")!.click());
    expect(gate.current?.sendAllowed).toBe(false);
    await act(async () => finish({ _tag: "Success", value: { threadId: main } }));
    expect(container.textContent).toContain("allow");
    expect(gate.current?.sendAllowed).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

it("re-locks send on reconnect, permission loss, thread, env, and provider change", async () => {
  setup();

  let finish: (value: unknown) => void = () => {
    throw new Error("not started");
  };
  mocks.open.mockReset().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const gate: { current: AttachGate | null } = { current: null };
  const container = document.createElement("div");
  await using root = await renderScreen(<></>, { container });
  const render = (
    props: Partial<{
      threadId: ThreadId;
      connected: boolean;
      environmentId: EnvironmentId;
      providerInstanceId: ProviderInstanceId;
    }> = {},
  ) =>
    root.rerender(
      <MuseAgentRouteConnection {...routeProps(props)}>
        {(value) => {
          gate.current = value;
          return <span>{value.sendAllowed ? "allow" : value.sendBlockedReason}</span>;
        }}
      </MuseAgentRouteConnection>,
    );
  try {
    await act(async () => render());
    expect(gate.current?.sendAllowed).toBe(false);
    await act(async () => finish({ _tag: "Success", value: { threadId: main } }));
    expect(gate.current?.sendAllowed).toBe(true);

    await act(async () => render({ connected: false }));
    expect(gate.current?.sendAllowed).toBe(false);
    expect(container.textContent).toContain("Connecting Muse history…");

    await act(async () => render({ connected: true }));
    expect(gate.current?.sendAllowed).toBe(false);
    await act(async () => finish({ _tag: "Success", value: { threadId: main } }));
    expect(gate.current?.sendAllowed).toBe(true);

    mocks.allowed = false;
    await act(async () => render({ connected: true }));
    expect(gate.current?.sendAllowed).toBe(false);
    expect(container.textContent).toContain("permission");
    mocks.allowed = true;

    await act(async () => render({ threadId: side }));
    expect(gate.current?.sendAllowed).toBe(false);
    await act(async () => finish({ _tag: "Success", value: { threadId: side } }));
    expect(gate.current?.sendAllowed).toBe(true);

    const otherEnv = EnvironmentId.make("other-env");
    await act(async () => render({ threadId: side, environmentId: otherEnv }));
    expect(gate.current?.sendAllowed).toBe(false);
    await act(async () => finish({ _tag: "Success", value: { threadId: side } }));
    expect(gate.current?.sendAllowed).toBe(true);

    const otherProvider = ProviderInstanceId.make("other-muse-provider");
    await act(async () =>
      render({ threadId: side, environmentId: otherEnv, providerInstanceId: otherProvider }),
    );
    expect(gate.current?.sendAllowed).toBe(false);
    await act(async () => finish({ _tag: "Success", value: { threadId: side } }));
    expect(gate.current?.sendAllowed).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

it("does not unlock send when the opened thread id does not match", async () => {
  setup();

  mocks.open.mockReset().mockResolvedValue({ _tag: "Success", value: { threadId: side } });
  const gate: { current: AttachGate | null } = { current: null };
  const container = document.createElement("div");
  await using root = await renderScreen(<></>, { container });
  try {
    await act(async () =>
      root.rerender(
        <MuseAgentRouteConnection {...routeProps()}>
          {(value) => {
            gate.current = value;
            return <span>{value.sendAllowed ? "allow" : value.sendBlockedReason}</span>;
          }}
        </MuseAgentRouteConnection>,
      ),
    );
    expect(container.textContent).toContain("different Muse account");
    expect(gate.current?.sendAllowed).toBe(false);
    expect(gate.current?.sendBlockedReason).toBe("Retry Muse connection to send");
  } finally {
    await act(async () => root.unmount());
  }
});

it("suppresses local state after unmount while the in-flight RPC still settles", async () => {
  setup();

  let finish: (value: unknown) => void = () => {
    throw new Error("not started");
  };
  mocks.open.mockReset().mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const container = document.createElement("div");
  await using root = await renderScreen(<></>, { container });
  await act(async () =>
    root.rerender(
      <MuseAgentRouteConnection
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        threadId={main}
        connected
        hasMessages
      />,
    ),
  );
  expect(mocks.open).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  await act(async () => finish({ _tag: "Success", value: { threadId: main } }));
  expect(mocks.open).toHaveBeenCalledTimes(1);
});

it("does not dispatch after delayed prep when the attach identity relocks, keeps the draft, then sends once after attach", async () => {
  setup();

  const dispatchScope = museAgentAttachScopeIdentity({
    environmentId: environmentId,
    threadId: main,
    providerInstanceId,
    connected: true,
  });
  const gate = {
    isMuseDispatch: true,
    dispatchScope,
    currentAttachScope: dispatchScope,
    currentBlockedReason: null as string | null,
  };
  const draft = { text: "keep the uploaded files", attachments: ["shot.png"] };
  let sends = 0;
  const dispatch = async () => {
    sends += 1;
    draft.text = "";
    draft.attachments = [];
    return "sent";
  };

  await Promise.resolve();
  gate.currentBlockedReason = "Connecting Muse history…";

  const blocked = await guardMuseAgentTurnDispatch(() => gate, dispatch);
  expect(blocked).toEqual({ ok: false, reason: "Connecting Muse history…" });
  expect(sends).toBe(0);
  expect(draft).toEqual({ text: "keep the uploaded files", attachments: ["shot.png"] });

  gate.currentBlockedReason = null;
  const sent = await guardMuseAgentTurnDispatch(() => gate, dispatch);
  expect(sent).toEqual({ ok: true, value: "sent" });
  expect(sends).toBe(1);
});

it("does not let an unrelated attached thread authorize a stale Muse dispatch", async () => {
  setup();

  let sends = 0;
  const result = await guardMuseAgentTurnDispatch(
    () => ({
      isMuseDispatch: true,
      dispatchScope: museAgentAttachScopeIdentity({
        environmentId,
        threadId: main,
        providerInstanceId,
        connected: true,
      }),
      currentAttachScope: museAgentAttachScopeIdentity({
        environmentId,
        threadId: side,
        providerInstanceId,
        connected: true,
      }),
      currentBlockedReason: null,
    }),
    async () => {
      sends += 1;
      return "sent";
    },
  );
  expect(result).toEqual({ ok: false, reason: "Connecting Muse history…" });
  expect(sends).toBe(0);
});

it("lets ordinary-thread dispatch through even when a Muse gate is locked", async () => {
  setup();

  let sends = 0;
  const result = await guardMuseAgentTurnDispatch(
    () => ({
      isMuseDispatch: false,
      dispatchScope: "",
      currentAttachScope: "",
      currentBlockedReason: "Connecting Muse history…",
    }),
    async () => {
      sends += 1;
      return "sent";
    },
  );
  expect(result).toEqual({ ok: true, value: "sent" });
  expect(sends).toBe(1);
});

it("lets a new Muse thread bootstrap dispatch without the viewed attach identity", async () => {
  setup();

  let sends = 0;
  const result = await guardMuseAgentTurnDispatch(
    () => ({
      isMuseDispatch: true,
      dispatchScope: museAgentAttachScopeIdentity({
        environmentId,
        threadId: side,
        providerInstanceId,
        connected: true,
      }),
      currentAttachScope: museAgentAttachScopeIdentity({
        environmentId,
        threadId: main,
        providerInstanceId,
        connected: true,
      }),
      currentBlockedReason: null,
      isNewThreadBootstrap: true,
    }),
    async () => {
      sends += 1;
      return "sent";
    },
  );
  expect(result).toEqual({ ok: true, value: "sent" });
  expect(sends).toBe(1);
});

it("blocks a retired observer until explicit retry without reclaiming it from another tab", async () => {
  setup();

  mocks.open.mockReset().mockResolvedValue({ _tag: "Success", value: { threadId: main } });
  const container = document.createElement("div");
  await using root = await renderScreen(<></>, { container });
  const render = (observerRetirement: string | null) =>
    root.rerender(
      <MuseAgentRouteConnection {...routeProps()} observerRetirement={observerRetirement}>
        {(gate) => <button disabled={!gate.sendAllowed}>Send</button>}
      </MuseAgentRouteConnection>,
    );
  const send = () =>
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Send",
    )!;
  try {
    await act(async () => render("old-session:stopped"));
    expect(send().disabled).toBe(false);
    await act(async () => render(null));
    expect(send().disabled).toBe(false);
    await act(async () => render("new-session:stopped"));
    expect(send().disabled).toBe(true);
    expect(container.textContent).toContain("Muse history disconnected");
    expect(mocks.open).toHaveBeenCalledTimes(1);
    // An unrelated reconnect update cannot reauthorize this route's old attach.
    await act(async () => render(null));
    expect(send().disabled).toBe(true);
    await act(async () => container.querySelector("button")!.click());
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(send().disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});

function setup() {
  mocks.allowed = true;
}
