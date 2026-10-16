// @vitest-environment jsdom
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  refreshInbox: vi.fn(),
  refreshConnectors: vi.fn(),
  permissions: { credential_submit: true, connector_auth: true },
  connectorRequests: [
    {
      requestId: "connect-linear",
      sessionId: "side-chat",
      title: "Connect Linear",
      connectorId: "linear",
    },
  ] as Array<{
    requestId: string;
    sessionId: string;
    title: string;
    connectorId: string;
  }>,
  connectors: [
    {
      id: "linear",
      name: "Linear",
      description: "Issues",
      state: "disconnected" as const,
    },
  ],
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => atom === true,
}));
vi.mock("~/state/museAgent", () => ({
  museAgentFeatureUpdate: {
    permissionAtom: (_environment: unknown, input?: { operation?: string }) =>
      input?.operation === "connector_auth"
        ? mocks.permissions.connector_auth
        : mocks.permissions.credential_submit,
  },
  museAgentCredentialRequestsQuery: () => "credential-requests",
  museAgentFeatureReadQuery: () => "connectors",
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.submit }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    if (atom === "connectors") {
      return {
        refresh: mocks.refreshConnectors,
        data: { operation: "connectors", data: mocks.connectors },
      };
    }
    return {
      refresh: mocks.refreshInbox,
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
          connectorRequests: mocks.connectorRequests,
        },
      },
    };
  },
}));
vi.mock("./MuseAgentConnectionsSection", () => ({
  MuseAgentConnectorAuthDialog: (props: {
    connector: { id: string; name: string };
    onClose: () => void;
    onRecheck: () => void;
  }) => (
    <div role="dialog" data-connector-id={props.connector.id}>
      Connect {props.connector.name}
      <button type="button" onClick={props.onRecheck}>
        Check connection
      </button>
      <button type="button" onClick={props.onClose}>
        Close
      </button>
    </div>
  ),
}));
import { MuseAgentCredentialPanel } from "./MuseAgentCredentialPanel";

beforeEach(() => {
  mocks.submit.mockReset();
  mocks.refreshInbox.mockReset();
  mocks.refreshConnectors.mockReset();
  mocks.permissions.credential_submit = true;
  mocks.permissions.connector_auth = true;
});

const environmentId = EnvironmentId.make("test-env");
const providerInstanceId = ProviderInstanceId.make("muse-test");

async function renderPanel() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MuseAgentCredentialPanel
        environmentId={environmentId}
        providerInstanceId={providerInstanceId}
        threadId="muse-agent:test:side-chat"
      />,
    ),
  );
  return { container, root };
}

it("clears private fields as it submits directly to the vault command and refreshes after confirmation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { container, root } = await renderPanel();
  try {
    mocks.submit.mockImplementation(async () => {
      expect([...container.querySelectorAll("input")].map((x) => x.value)).toEqual(["", ""]);
      return { _tag: "Success", value: { updated: true } };
    });
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
    expect(mocks.refreshInbox).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("synthetic-secret");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("opens the checked connector authorization dialog from a native request card", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { container, root } = await renderPanel();
  try {
    expect(container.textContent).toContain("Connect Linear");
    expect(container.textContent).toContain("Not connected");
    expect(container.innerHTML).not.toContain("authorize.");
    expect(document.querySelector("[role=dialog]")).toBeNull();
    const connect = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect",
    )!;
    await act(async () => connect.click());
    const dialog = document.querySelector("[role=dialog]")!;
    expect(dialog.getAttribute("data-connector-id")).toBe("linear");
    expect(dialog.textContent).toContain("Connect Linear");
    await act(async () => {
      [...dialog.querySelectorAll("button")]
        .find((button) => button.textContent === "Check connection")!
        .click();
    });
    expect(mocks.refreshInbox).toHaveBeenCalled();
    expect(mocks.refreshConnectors).toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each([
  {
    credential_submit: true,
    connector_auth: false,
    saveDisabled: false,
    connectDisabled: true,
  },
  {
    credential_submit: false,
    connector_auth: true,
    saveDisabled: true,
    connectDisabled: false,
  },
] as const)(
  "splits credential_submit (operate) from connector_auth (settings write) ($credential_submit / $connector_auth)",
  async ({ credential_submit, connector_auth, saveDisabled, connectDisabled }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.permissions.credential_submit = credential_submit;
    mocks.permissions.connector_auth = connector_auth;
    const { container, root } = await renderPanel();
    try {
      const save = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Save securely",
      )!;
      const connect = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Connect",
      )!;
      expect(save.disabled).toBe(saveDisabled);
      expect(connect.disabled).toBe(connectDisabled);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  },
);
