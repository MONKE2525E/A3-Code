import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { NativeAgentFeatureReadInput, NativeAgentFeatureUpdateInput } from "./nativeAgentApi.ts";

const reference = { providerInstanceId: "muse-test", threadId: "muse-agent:test" };
const decodeRead = Schema.decodeUnknownSync(NativeAgentFeatureReadInput);
const decodeUpdate = Schema.decodeUnknownSync(NativeAgentFeatureUpdateInput);

describe("native history permissions boundary", () => {
  it("cannot carry an import cursor through the read schema", () => {
    const decoded = decodeRead({
      ...reference,
      operation: "history_page",
      beforeSeq: 10,
    });
    expect(decoded).toEqual({ ...reference, operation: "history_page" });
  });

  it("requires an explicit cursor for the update", () => {
    expect(() =>
      decodeUpdate({
        ...reference,
        operation: "history_page",
      }),
    ).toThrow();
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid import cursor %s",
    (beforeSeq) => {
      expect(() =>
        decodeUpdate({
          ...reference,
          operation: "history_page",
          beforeSeq,
        }),
      ).toThrow();
    },
  );

  it("keeps cursor zero as an explicit update", () => {
    const input = { ...reference, operation: "history_page", beforeSeq: 0 };
    expect(decodeUpdate(input)).toEqual(input);
  });
});
