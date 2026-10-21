import * as Layer from "effect/Layer";
import * as Muse from "../museAgent/MuseAgentNativeRuntimeService.ts";
import * as DirectTools from "../museAgent/MuseAgentDirectToolsPort.ts";
import * as Grok from "../grokBot/GrokBotProviderServices.testkit.ts";

/** Registry tests do not connect personal native accounts. */
export const layer = Layer.mergeAll(
  Grok.layer,
  DirectTools.layer,
  Layer.mock(Muse.MuseAgentNativeRuntimeService)({}),
);
