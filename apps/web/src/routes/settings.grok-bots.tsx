import { createFileRoute, redirect } from "@tanstack/react-router";

import {
  grokBotLegacySettingsRedirect,
  validateGrokBotSettingsSearch,
} from "../components/grokBot/grokBotPresentation";

/** Grok Bots are edited under Providers; this keeps old links and bookmarks working. */
export const Route = createFileRoute("/settings/grok-bots")({
  validateSearch: validateGrokBotSettingsSearch,
  beforeLoad: ({ search, location }) => {
    throw redirect({
      to: "/settings/providers",
      search: (previous) =>
        grokBotLegacySettingsRedirect({ previousSearch: previous, search, hash: location.hash })
          .search,
      hash: grokBotLegacySettingsRedirect({
        previousSearch: {},
        search,
        hash: location.hash,
      }).hash,
      replace: true,
    });
  },
});
