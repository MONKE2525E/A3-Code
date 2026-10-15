// @vitest-environment jsdom
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ submit: vi.fn(), refresh: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("~/state/museAgent", () => ({
  museAgentFeatureUpdate: { permissionAtom: () => ({}) },
  museAgentCredentialRequestsQuery: () => ({}),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.submit }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    refresh: mocks.refresh,
    data: {
      operation: "credential_requests",
      data: {
        sessionId: "side-chat",
        requests: [
          {
            requestId: "prompt",
            sessionId: "side-chat",
            title: "Sign in to Example",
            pageUrl: "https://example.test",
            capture: "sign_in",
            usernameLabel: "Username",
            passwordLabel: "Password",
            codeLabel: "Code",
          },
        ],
      },
    },
  }),
}));
import { MuseAgentCredentialPanel } from "./MuseAgentCredentialPanel";

it("clears private fields as it submits directly to the vault command and refreshes after confirmation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const environmentId = EnvironmentId.make("test-env");
  const providerInstanceId = ProviderInstanceId.make("muse-test");
  try {
    mocks.submit.mockImplementation(async () => {
      expect([...container.querySelectorAll("input")].map((x) => x.value)).toEqual(["", ""]);
      return { _tag: "Success", value: { updated: true } };
    });
    await act(async () =>
      root.render(
        <MuseAgentCredentialPanel
          environmentId={environmentId}
          providerInstanceId={providerInstanceId}
          threadId="muse-agent:test:side-chat"
        />,
      ),
    );
    const inputs = container.querySelectorAll("input");
    inputs[0]!.value = "synthetic-user";
    inputs[1]!.value = "synthetic-secret";
    expect(inputs[1]!.type).toBe("password");
    await act(async () => {
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        operation: "credential_submit",
        providerInstanceId,
        sessionId: "side-chat",
        requestId: "prompt",
        username: "synthetic-user",
        password: "synthetic-secret",
      },
    });
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("synthetic-secret");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
