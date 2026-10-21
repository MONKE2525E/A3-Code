import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { ComposerCommandMenu } from "./ComposerCommandMenu";

it("offers native Muse skills and stop commands without local skill paths", async () => {
  const onSelect = vi.fn();
  await using screen = await render(
    <ComposerCommandMenu
      listId="muse-suggestions"
      items={[
        {
          id: "muse-skill:web-search",
          type: "muse-skill",
          skill: { name: "web-search", description: "Search the web", category: "tools" },
          label: "Web Search",
          description: "Use this Muse skill",
        },
        {
          id: "muse-slash:stop",
          type: "muse-slash-command",
          name: "stop",
          runnable: true,
          label: "/stop",
          description: "Stop the current response",
        },
      ]}
      resolvedTheme="dark"
      isLoading={false}
      triggerKind="slash-command"
      activeItemId="muse-skill:web-search"
      onHighlightedItemChange={() => {}}
      onSelect={onSelect}
    />,
  );
  await expect.element(screen.getByText("Web Search", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("/stop", { exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toContain("/skill:");
  expect(screen.container.textContent).not.toContain("SKILL.md");
  await act(() =>
    screen.container
      .querySelector<HTMLElement>('[data-composer-item-id="muse-skill:web-search"]')
      ?.click(),
  );
  expect(onSelect).toHaveBeenCalledWith(
    expect.objectContaining({ type: "muse-skill", id: "muse-skill:web-search" }),
  );
});
