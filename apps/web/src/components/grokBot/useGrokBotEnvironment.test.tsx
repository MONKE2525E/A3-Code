import { EnvironmentId } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { useSelectedGrokBotEnvironmentId } from "./useGrokBotEnvironment";

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("primary"),
}));

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  await act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

it.each([
  ["/remote/thread", "primary"],
  ["/usage", "primary"],
  ["/another-remote/thread", "primary"],
  ["/grok-bots/bot?environmentId=bot-host", "bot-host"],
  ["/grok-bots/bot?environmentId=", "primary"],
])("selects the bot environment for %s", async (href, expected) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let selected: EnvironmentId | null = null;
  function Shell() {
    const environmentId = useSelectedGrokBotEnvironmentId();
    useLayoutEffect(() => {
      selected = environmentId;
    });
    return <Outlet />;
  }
  const root = createRootRoute({
    component: Shell,
    validateSearch: (search: Record<string, unknown>) =>
      typeof search.environmentId === "string" ? { environmentId: search.environmentId } : {},
  });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "$environmentId/$threadId" }),
      createRoute({ getParentRoute: () => root, path: "usage" }),
      createRoute({ getParentRoute: () => root, path: "grok-bots/$botId" }),
    ]),
    history: createMemoryHistory({ initialEntries: [href] }),
  });
  await router.load();
  await act(() => {
    renderer = create(<RouterProvider router={router} />);
  });
  expect(selected).toBe(expected);
});
