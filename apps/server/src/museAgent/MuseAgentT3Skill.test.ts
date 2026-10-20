import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Skill from "./MuseAgentT3Skill.ts";
import * as Transport from "./MuseAgentTransport.ts";

const fixture = () => {
  const files = new Map<string, string>();
  const writes: string[] = [];
  let failure: Transport.MuseAgentTransportError | undefined;
  let corrupt = false;
  const transport = Layer.mock(Transport.MuseAgentTransport)({
    request: (_, method, params, write) =>
      Effect.suspend(() => {
        if (failure) return Effect.fail(failure);
        const path = String(params.path);
        if (method === "fs.stat")
          return files.has(path)
            ? Effect.succeed({ kind: "file", size: Buffer.byteLength(files.get(path) ?? "") })
            : Effect.fail(
                new Transport.MuseAgentTransportError({
                  kind: "unavailable",
                  cause: { code: "not_found", httpStatus: 404 },
                }),
              );
        if (method === "fs.write") {
          expect(write).toBe(true);
          expect(params.create_parent).toBe(true);
          writes.push(path);
          files.set(path, String(params.text));
          return Effect.succeed({});
        }
        if (method === "fs.read") {
          const bytes = Buffer.from(corrupt ? "tampered" : (files.get(path) ?? ""));
          return Effect.succeed({
            data_base64: bytes.toString("base64"),
            len: bytes.length,
            eof: true,
          });
        }
        return Effect.die(`Unexpected method: ${method}`);
      }),
  });
  return {
    files,
    writes,
    layer: Skill.layer.pipe(Layer.provide(transport)),
    fail: (error: Transport.MuseAgentTransportError) => {
      failure = error;
    },
    corruptRead: () => {
      corrupt = true;
    },
  };
};

it.effect("installs a custom skill and manifest, verifies exact readback and reuses them", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* Skill.MuseAgentT3Skill;
    yield* service.install("account");
    yield* service.verify("account");
    yield* service.install("account");
    expect(f.writes).toHaveLength(2);
    expect(f.files.get(Skill.MUSE_T3_SKILL_PATH)).toBe(Skill.MUSE_T3_SKILL_CONTENT);
    expect([...f.files.values()].some((text) => text.includes("include_in_prompt: true"))).toBe(
      true,
    );
  }).pipe(Effect.provide(f.layer));
});

it.effect("refuses to overwrite a user-owned skill", () => {
  const f = fixture();
  f.files.set(Skill.MUSE_T3_SKILL_PATH, "User instructions");
  return Effect.gen(function* () {
    const service = yield* Skill.MuseAgentT3Skill;
    const error = yield* service.install("account").pipe(Effect.flip);
    expect(error.kind).toBe("conflict");
    expect(f.writes).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("rejects corrupted readback and later file changes", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* Skill.MuseAgentT3Skill;
    yield* service.install("account");
    f.corruptRead();
    expect((yield* service.verify("account").pipe(Effect.flip)).kind).toBe("readback_failed");
    expect((yield* service.install("account").pipe(Effect.flip)).kind).toBe("conflict");
  }).pipe(Effect.provide(f.layer));
});

it.effect("never treats an account change as a missing skill", () => {
  const f = fixture();
  f.fail(
    new Transport.MuseAgentTransportError({
      kind: "account_changed",
      cause: { code: "not_found", httpStatus: 404 },
    }),
  );
  return Effect.gen(function* () {
    const service = yield* Skill.MuseAgentT3Skill;
    expect((yield* service.install("account").pipe(Effect.flip)).kind).toBe("account_changed");
    expect(f.writes).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});
