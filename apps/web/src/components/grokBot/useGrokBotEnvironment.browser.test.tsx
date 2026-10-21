import { EnvironmentId } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

import { useSelectedGrokBotEnvironmentId } from "./useGrokBotEnvironment";

vi.mock("/src/state/environments.ts", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("primary"),
}));

it.each([
  ["/remote/thread", "primary"],
  ["/usage", "primary"],
  ["/another-remote/thread", "primary"],
  ["/grok-bots/bot?environmentId=bot-host", "bot-host"],
  ["/grok-bots/bot?environmentId=", "primary"],
])("selects the bot environment for %s", async (href, expected) => {
  function Shell() {
    const environmentId = useSelectedGrokBotEnvironmentId();
    return (
      <>
        <output>{environmentId}</output>
        <Outlet />
      </>
    );
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
  // This test supplies its own route tree to validate search parameters.
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  await expect.element(screen.getByRole("status")).toHaveTextContent(expected);
});
