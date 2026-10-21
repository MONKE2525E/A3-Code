import type { ScopedThreadRef } from "@t3tools/contracts";
import { act, useCallback, useState } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({ ready: false }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({ modelSelection: { instanceId: "muse" } }),
}));
vi.mock("~/state/museAgent", () => ({
  museAgentFeatureUpdate: { permissionAtom: () => null },
  museAgentOptionWidgetsQuery: () => null,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => {
    const [available, setAvailable] = useState(false);
    const refresh = useCallback(() => setAvailable(native.ready), []);
    return {
      data: {
        operation: "option_widgets",
        data: available
          ? [
              {
                messageId: "message",
                widgetId: "choice",
                options: ["Use GPT-6 Luna"],
                selectedText: null,
              },
            ]
          : [],
      },
      refresh,
      isPending: false,
      error: null,
    };
  },
}));

import { MuseAgentOptionWidgets } from "./MuseAgentOptionWidgets";

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
  native.ready = false;
});

it("shows choices finalized in native history after their marker streamed", async () => {
  const threadRef = {
    environmentId: "environment",
    threadId: "muse-agent:thread",
  } as ScopedThreadRef;
  await act(() => {
    renderer = create(
      <MuseAgentOptionWidgets threadRef={threadRef} messageId="message" isStreaming />,
    );
  });
  expect(renderer!.root.findByType("p").children).toEqual(["Loading Muse choices…"]);
  native.ready = true;
  await act(() => {
    renderer!.update(
      <MuseAgentOptionWidgets threadRef={threadRef} messageId="message" isStreaming={false} />,
    );
  });
  const button = renderer!.root.findByType("button");
  expect(button.children).toContain("Use GPT-6 Luna");
  expect(button.props.disabled).toBe(false);
});
