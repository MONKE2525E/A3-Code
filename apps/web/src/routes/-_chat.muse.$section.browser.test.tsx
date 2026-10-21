import type { ReactNode } from "react";
import { act, render as renderScreen } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  section: "activity",
  environmentId: "test-env" as string | null,
  status: {
    data: {
      ready: true,
      provider: { instanceId: "muse-current" },
    } as {
      ready: boolean;
      provider: { instanceId: string } | null;
    } | null,
    error: null as string | null,
    isPending: false,
  },
  open: vi.fn(async (): Promise<{ threadId: string } | null> => null),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: { component: () => ReactNode }) => ({
    options,
    useParams: () => ({ section: state.section }),
  }),
}));
vi.mock("/src/components/grokBot/useGrokBotEnvironment.ts", () => ({
  useSelectedGrokBotEnvironmentId: () => state.environmentId,
}));
vi.mock("/src/state/museAgent.ts", () => ({
  museAgentStatusQuery: (query: unknown) => query,
}));
vi.mock("/src/state/query.ts", () => ({
  useEnvironmentQuery: () => state.status,
}));
vi.mock("/src/components/agents/MuseAgentFeaturesDialog.tsx", async () => {
  const { useEffect } = await import("react");
  return {
    MuseAgentSectionPage: (props: {
      section: string;
      environmentId: string;
      providerInstanceId: string;
    }) => {
      useEffect(() => {
        if (props.section !== "chat") return;
        let current = true;
        void state.open().then((result) => {
          if (!current || result === null) return;
          state.navigate(result);
        });
        return () => {
          current = false;
        };
      }, [props.environmentId, props.providerInstanceId, props.section]);
      return (
        <div>
          {`muse-section:${props.section}:${props.environmentId}:${props.providerInstanceId}`}
        </div>
      );
    },
  };
});
vi.mock("/src/components/agents/MuseAgentRouteConnection.tsx", () => ({
  MuseChatLoading: () => <div role="status">Opening Muse</div>,
}));

import { Route } from "./_chat.muse.$section";

const Page = Route.options.component!;
await Page.preload?.();
function setup() {
  state.section = "activity";
  state.environmentId = "test-env";
  state.status = {
    data: { ready: true, provider: { instanceId: "muse-current" } },
    error: null,
    isPending: false,
  };
  state.open.mockReset();
  state.open.mockResolvedValue(null);
  state.navigate.mockReset();
}

it("treats an unknown section as not a Muse page even while status is pending", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  const { container } = screen;
  const render = async (section: string) => {
    state.section = section;
    await screen.rerender(<Page />);
  };
  state.status.isPending = true;
  await render("settings");
  await vi.waitFor(() => expect(container.textContent).toContain("Not a Muse page"));
  await vi.waitFor(() => expect(container.textContent).not.toContain("Opening Muse"));
  await vi.waitFor(() => expect(container.textContent).not.toContain("Muse isn't connected"));
});

it("shows in-chat loading for /muse/chat while Muse status is still loading", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  const { container } = screen;
  const render = async (section: string) => {
    state.section = section;
    await screen.rerender(<Page />);
  };
  state.status = { data: null, error: null, isPending: true };
  await render("chat");
  await vi.waitFor(() =>
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Opening Muse"),
  );
  await vi.waitFor(() => expect(container.textContent).not.toContain("Not a Muse page"));
  await vi.waitFor(() => expect(container.textContent).not.toContain("Muse isn't connected"));
});

it("opens the chat entry once Muse is connected", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  const { container } = screen;
  const render = async (section: string) => {
    state.section = section;
    await screen.rerender(<Page />);
  };
  await render("chat");
  await vi.waitFor(() =>
    expect(container.textContent).toBe("muse-section:chat:test-env:muse-current"),
  );
});

it("keeps the chat entry mounted while connected Muse status is refreshing", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  const { container } = screen;
  const render = async (section: string) => {
    state.section = section;
    await screen.rerender(<Page />);
  };
  await render("chat");
  state.status = {
    data: { ready: true, provider: { instanceId: "muse-current" } },
    error: null,
    isPending: true,
  };
  await act(async () => screen.rerender(<Page />));
  await vi.waitFor(() =>
    expect(container.textContent).toBe("muse-section:chat:test-env:muse-current"),
  );
  await vi.waitFor(() => expect(container.textContent).not.toContain("Opening Muse"));
});

it("replace-navigates after Muse open while a connected status refresh is pending", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  const { container } = screen;
  const render = async (section: string) => {
    state.section = section;
    await screen.rerender(<Page />);
  };
  const pending: Array<(value: { threadId: string } | null) => void> = [];
  state.open.mockImplementation(
    () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  );
  await render("chat");
  expect(state.open).toHaveBeenCalledTimes(1);
  expect(state.navigate).not.toHaveBeenCalled();
  state.status = {
    data: { ready: true, provider: { instanceId: "muse-current" } },
    error: null,
    isPending: true,
  };
  await act(async () => screen.rerender(<Page />));
  await vi.waitFor(() =>
    expect(container.textContent).toBe("muse-section:chat:test-env:muse-current"),
  );
  expect(state.open).toHaveBeenCalledTimes(1);
  const resolveOpen = pending[0];
  if (resolveOpen === undefined) throw new Error("Muse open did not start");
  await act(async () => {
    resolveOpen({ threadId: "opened-thread" });
  });
  expect(state.navigate).toHaveBeenCalledTimes(1);
  expect(state.navigate).toHaveBeenCalledWith({ threadId: "opened-thread" });
  expect(state.open).toHaveBeenCalledTimes(1);
});

it("opens routines and subagents once Muse is connected", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  const { container } = screen;
  const render = async (section: string) => {
    state.section = section;
    await screen.rerender(<Page />);
  };
  await render("routines");
  await vi.waitFor(() =>
    expect(container.textContent).toBe("muse-section:routines:test-env:muse-current"),
  );
  await render("subagents");
  await vi.waitFor(() =>
    expect(container.textContent).toBe("muse-section:subagents:test-env:muse-current"),
  );
});

it("does not finish an in-flight open after Muse switches accounts", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  const { container } = screen;
  const render = async (section: string) => {
    state.section = section;
    await screen.rerender(<Page />);
  };
  const pending: Array<(value: { threadId: string } | null) => void> = [];
  state.open.mockImplementation(
    () =>
      new Promise((resolve) => {
        pending.push(resolve);
      }),
  );
  await render("chat");
  expect(state.open).toHaveBeenCalledTimes(1);
  state.status = {
    data: { ready: true, provider: { instanceId: "muse-other" } },
    error: null,
    isPending: false,
  };
  await act(async () => screen.rerender(<Page />));
  await vi.waitFor(() =>
    expect(container.textContent).toBe("muse-section:chat:test-env:muse-other"),
  );
  expect(state.open).toHaveBeenCalledTimes(2);
  const resolveFirst = pending[0];
  if (resolveFirst === undefined) throw new Error("Muse open did not start");
  await act(async () => {
    resolveFirst({ threadId: "old-account-thread" });
  });
  expect(state.navigate).not.toHaveBeenCalled();
});

it("does not open chat for another account when Muse is not ready", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  const { container } = screen;
  const render = async (section: string) => {
    state.section = section;
    await screen.rerender(<Page />);
  };
  state.status = { data: { ready: false, provider: null }, error: null, isPending: false };
  await render("chat");
  await vi.waitFor(() => expect(container.textContent).toContain("Muse isn't connected"));
  await vi.waitFor(() => expect(container.textContent).not.toContain("muse-section:"));
});

it("does not open a Muse page without an environment", async () => {
  setup();
  await using screen = await renderScreen(<></>);
  const { container } = screen;
  const render = async (section: string) => {
    state.section = section;
    await screen.rerender(<Page />);
  };
  state.environmentId = null;
  await render("chat");
  await vi.waitFor(() => expect(container.textContent).toContain("Muse isn't connected"));
  await vi.waitFor(() => expect(container.textContent).not.toContain("Opening Muse"));
});
