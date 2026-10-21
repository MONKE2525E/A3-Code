import { EnvironmentId } from "@t3tools/contracts";
import { act, render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("/src/components/grokBot/marketplaceIconCache.ts", () => ({
  loadMarketplaceIcon: mocks.load,
}));
vi.mock("/src/components/grokBot/GrokBotAvatar.tsx", () => ({
  GrokBotAvatar: () => <span>Fallback avatar</span>,
}));
import { CreatorAvatar } from "./GrokBotMarketplaceAvatar";

it("loads one cached image, restores the fallback on failure, and releases the blob", async () => {
  mocks.load.mockReset();
  let finish: (value: Blob | null) => void = () => {};
  mocks.load.mockReturnValue(
    new Promise<Blob | null>((resolve) => {
      finish = resolve;
    }),
  );
  using create = vi.spyOn(URL, "createObjectURL");
  using revoke = vi.spyOn(URL, "revokeObjectURL");
  let blobUrl: string | undefined;
  {
    await using screen = await render(
      <CreatorAvatar
        environmentId={EnvironmentId.make("test-env")}
        name="Example"
        photoUrl="https://images.example.test/avatar.png"
      />,
    );
    await expect.element(screen.getByText("Fallback avatar")).toBeVisible();
    expect(screen.container.querySelector("img")).toBeNull();
    await act(() =>
      finish(
        new Blob(
          [
            '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="blue"/></svg>',
          ],
          { type: "image/svg+xml" },
        ),
      ),
    );
    await vi.waitFor(() => expect(screen.container.textContent).not.toContain("Fallback avatar"));
    const img = screen.container.querySelector("img");
    expect(img).not.toBeNull();
    blobUrl = img?.getAttribute("src") ?? undefined;
    expect(blobUrl).toMatch(/^blob:/);
    expect(create).toHaveBeenCalledTimes(1);
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith("https://images.example.test/avatar.png");
    await act(() => img?.dispatchEvent(new Event("error")));
    await expect.element(screen.getByText("Fallback avatar")).toBeVisible();
    expect(screen.container.querySelector("img")).toBeNull();
  }
  expect(revoke).toHaveBeenCalledWith(blobUrl);
});
