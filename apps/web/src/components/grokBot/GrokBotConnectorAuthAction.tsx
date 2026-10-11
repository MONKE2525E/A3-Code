import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "~/components/ui/button";
import type { ChatMarkdownLinkOverride } from "../ChatMarkdown";
import { isNativeConnectorAuthLink } from "./grokBotConnectorAuthLink";

/**
 * Replaces a native connector sign-in link in a bot message. Settings lists each connector account
 * with its own Authenticate, which is permission-checked and starts a flow T3 can complete.
 */
export function GrokBotConnectorAuthAction({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const navigate = useNavigate();
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={() =>
        void navigate({ to: "/settings/marketplace", search: { machine: environmentId } })
      }
    >
      Connect in Settings
    </Button>
  );
}

/**
 * Link override for a Grok Bot transcript's assistant text. Links it does not claim keep their
 * normal rendering.
 */
export function createGrokBotConnectorAuthLinkOverride(environmentId: EnvironmentId) {
  return ({ href }: ChatMarkdownLinkOverride) =>
    isNativeConnectorAuthLink(href) ? (
      <GrokBotConnectorAuthAction environmentId={environmentId} />
    ) : undefined;
}
