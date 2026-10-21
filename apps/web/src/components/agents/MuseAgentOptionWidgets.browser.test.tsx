import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";
import { render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({ ready: false }));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("/src/state/entities.ts", () => ({
  useThreadShell: () => ({ modelSelection: { instanceId: "muse" } }),
}));
vi.mock("/src/state/museAgent.ts", () => ({
  museAgentFeatureUpdate: { permissionAtom: () => null },
  museAgentOptionWidgetsQuery: () => null,
}));
vi.mock("/src/state/use-atom-command.ts", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("/src/state/query.ts", () => ({
  useEnvironmentQuery: () => {
    const [available, setAvailable] = useState(false);
    const [refresh] = useState(() => () => setAvailable(native.ready));
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

it("shows choices finalized in native history after their marker streamed", async () => {
  native.ready = false;
  const threadRef: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("muse-agent:thread"),
  };
  await using screen = await render(
    <MuseAgentOptionWidgets threadRef={threadRef} messageId="message" isStreaming />,
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent("Loading Muse choices…");
  native.ready = true;
  await screen.rerender(
    <MuseAgentOptionWidgets threadRef={threadRef} messageId="message" isStreaming={false} />,
  );
  await expect.element(screen.getByRole("button", { name: "Use GPT-6 Luna" })).toBeEnabled();
});
