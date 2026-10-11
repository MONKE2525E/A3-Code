import { describe, expect, it } from "vite-plus/test";
import { parseGrokBotTemplateLink } from "./grokBotTemplateLink";

const shareId = "AbC123def456ghi789_j-";

describe("parseGrokBotTemplateLink", () => {
  it("extracts the native published share link and template deep links", () => {
    for (const link of [
      `https://x.ai/bot/${shareId}`,
      `  https://x.ai/bot/${shareId}/  `,
      `grokbot://app/v1/bot-template?id=${shareId}`,
      `sand://app/v1/bot-template?id=${shareId}`,
    ])
      expect(parseGrokBotTemplateLink(link)).toBe(shareId);
  });

  it("rejects other hosts, routes, credential URLs and malformed IDs", () => {
    for (const link of [
      shareId,
      `http://x.ai/bot/${shareId}`,
      `https://x.ai.example.com/bot/${shareId}`,
      `https://x.ai@evil.example/bot/${shareId}`,
      `https://name:secret@x.ai/bot/${shareId}`,
      `https://x.ai:444/bot/${shareId}`,
      `https://x.ai/bot/${shareId}?redirect=https://evil.example`,
      `https://x.ai/bot/${shareId}#fragment`,
      `https://x.ai/bot/${shareId}/extra`,
      `https://x.ai/bot/${shareId.slice(1)}`,
      `https://x.ai/bot/${shareId}x`,
      `https://x.ai/bot/${shareId.slice(1)}%2f`,
      `grokbot://app/v1/agent?id=${shareId}`,
      `grokbot://app/v1/bot-template?id=${shareId}&id=${shareId}`,
      `grokbot://app/v1/bot-template?id=${shareId}&other=value`,
      `grokbot://other/v1/bot-template?id=${shareId}`,
      `javascript:alert('${shareId}')`,
      `https://x.ai/bot/${"a".repeat(2050)}`,
    ])
      expect(parseGrokBotTemplateLink(link)).toBeNull();
  });
});
