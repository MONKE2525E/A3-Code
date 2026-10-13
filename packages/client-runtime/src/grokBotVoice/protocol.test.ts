import { describe, expect, it } from "vite-plus/test";

import { parseServerEvent, truncateFrame } from "./protocol.ts";

const parse = (event: unknown) => parseServerEvent(JSON.stringify(event));

describe("voice transcript and playback wire events", () => {
  it.each(["current-response", undefined, null])(
    "preserves nullable tool response identity (%s)",
    (response_id) => {
      expect(
        parse({
          type: "response.function_call_arguments.done",
          call_id: "delegate",
          name: "delegate_task",
          arguments: '{"task":"Current request"}',
          response_id,
        }),
      ).toEqual({
        type: "tool.call",
        callId: "delegate",
        name: "delegate_task",
        argumentsJson: '{"task":"Current request"}',
        responseId: response_id ?? null,
      });
    },
  );

  it.each(["response.audio.delta", "response.output_audio.delta"])(
    "retains the response, item, and content identity of %s",
    (type) => {
      expect(
        parse({ type, response_id: "r", item_id: "a", content_index: 2, delta: "AAAAAA==" }),
      ).toMatchObject({ type: "audio.delta", responseId: "r", itemId: "a", contentIndex: 2 });
    },
  );

  it.each([undefined, -1, 0.5, "0"])("does not invent an audio content index from %s", (index) => {
    expect(
      parse({ type: "response.output_audio.delta", content_index: index, delta: "AAAAAA==" }),
    ).toMatchObject({ contentIndex: null });
  });

  it("preserves cumulative transcription corrections, including an empty correction", () => {
    expect(
      parse({
        type: "conversation.item.input_audio_transcription.updated",
        item_id: "u",
        transcript: "",
      }),
    ).toEqual({ type: "transcript.user", itemId: "u", text: "", final: false });
    expect(
      parse({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "u",
        transcript: "corrected",
      }),
    ).toEqual({ type: "transcript.user", itemId: "u", text: "corrected", final: true });
  });

  it.each(["response.audio_transcript.done", "response.output_audio_transcript.done"])(
    "accepts a final-only transcript from %s",
    (type) => {
      expect(parse({ type, response_id: "r", item_id: "a", transcript: "Final words" })).toEqual({
        type: "transcript.assistant.final",
        responseId: "r",
        itemId: "a",
        text: "Final words",
      });
    },
  );

  it("reads only message text or audio transcripts for supported conversation roles", () => {
    expect(
      parse({
        type: "conversation.item.added",
        item: {
          id: "a",
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "Hello " },
            { type: "output_audio", transcript: "caller" },
            { type: "function_call", text: "not speech" },
          ],
        },
      }),
    ).toMatchObject({ type: "transcript.item", speaker: "assistant", text: "Hello caller" });
    expect(
      parse({
        type: "conversation.item.added",
        item: {
          id: "system",
          type: "message",
          role: "system",
          content: [{ type: "text", text: "secret" }],
        },
      }),
    ).toEqual({ type: "unsupported", wireType: "conversation.item.added" });
  });

  it("preserves explicit user input_text separately from generic conversation context", () => {
    expect(
      parse({
        type: "conversation.item.added",
        item: {
          id: "typed-user",
          type: "message",
          role: "user",
          content: [
            { type: "text", text: "Context: " },
            { type: "input_text", text: "New caller request" },
          ],
        },
      }),
    ).toEqual({
      type: "transcript.item",
      itemId: "typed-user",
      responseId: null,
      speaker: "user",
      text: "Context: New caller request",
      inputText: "New caller request",
    });
  });

  it.each([
    { role: "user", part: { type: "text", text: "Old request" } },
    { role: "user", part: { type: "output_text", text: "Old request" } },
    { role: "user", part: { type: "input_audio", transcript: "Old request" } },
    { role: "user", part: { type: "input_text", text: "  " } },
    { role: "assistant", part: { type: "input_text", text: "New caller request" } },
    {
      role: "user",
      response_id: "generated-response",
      part: { type: "input_text", text: "Generated context" },
    },
  ])(
    "does not classify $role $part.type context as caller text input",
    ({ role, part, ...rest }) => {
      expect(
        parse({
          type: "conversation.item.added",
          ...rest,
          item: { id: "context", type: "message", role, content: [part] },
        }),
      ).toMatchObject({ type: "transcript.item", inputText: null });
    },
  );

  it("recognizes item completion and the server's truncation acknowledgement", () => {
    expect(parse({ type: "response.output_item.done", item: { id: "a" } })).toEqual({
      type: "item.ended",
      itemId: "a",
    });
    const frame = JSON.parse(truncateFrame({ itemId: "a", contentIndex: 1, audioEndMs: 625.4 }));
    expect(frame).toEqual({
      type: "conversation.item.truncate",
      item_id: "a",
      content_index: 1,
      audio_end_ms: 625,
    });
    expect(parse({ ...frame, type: "conversation.item.truncated" })).toEqual({
      type: "item.truncated",
      itemId: "a",
    });
  });
});
