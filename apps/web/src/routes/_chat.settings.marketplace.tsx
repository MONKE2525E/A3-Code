import { createFileRoute } from "@tanstack/react-router";

import { GrokBotMarketplacePage } from "../components/grokBot/GrokBotMarketplacePage";

export const Route = createFileRoute("/_chat/settings/marketplace")({
  component: GrokBotMarketplacePage,
});
