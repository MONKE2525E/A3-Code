import { createFileRoute } from "@tanstack/react-router";

import { GrokBotMarketplacePage } from "../components/grokBot/GrokBotMarketplacePage";

export const Route = createFileRoute("/settings/marketplace")({
  component: GrokBotMarketplacePage,
});
