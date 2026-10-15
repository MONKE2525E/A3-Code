// @vitest-environment jsdom
import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./marketplaceIconCache", () => ({ loadMarketplaceIcon: mocks.load }));
vi.mock("./GrokBotAvatar", () => ({ GrokBotAvatar: () => <span>Fallback avatar</span> }));
import { CreatorAvatar } from "./GrokBotMarketplaceAvatar";

it("keeps the fallback visible while loading cached bytes and never starts a duplicate image request", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let finish: (value: Blob | null) => void = () => {};
  mocks.load.mockReturnValue(
    new Promise<Blob | null>((resolve) => {
      finish = resolve;
    }),
  );
  const revoke = vi.fn();
  const create = vi.fn(() => "blob:cached-icon");
  const originalCreate = URL.createObjectURL,
    originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = create;
  URL.revokeObjectURL = revoke;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <CreatorAvatar
          environmentId={EnvironmentId.make("test-env")}
          name="Example"
          photoUrl="https://images.example.test/avatar.png"
        />,
      ),
    );
    expect(container.textContent).toContain("Fallback avatar");
    expect(container.querySelector("img")).toBeNull();
    await act(async () => finish(new Blob(["synthetic-image"], { type: "image/png" })));
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("blob:cached-icon");
    expect(container.textContent).toContain("Fallback avatar");
    await act(async () => img.dispatchEvent(new Event("load")));
    expect(container.textContent).not.toContain("Fallback avatar");
    await act(async () => img.dispatchEvent(new Event("error")));
    expect(container.textContent).toContain("Fallback avatar");
    expect(container.querySelector("img")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    expect(revoke).toHaveBeenCalledWith("blob:cached-icon");
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    container.remove();
    vi.unstubAllGlobals();
  }
});
