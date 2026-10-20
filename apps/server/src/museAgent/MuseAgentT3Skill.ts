import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Transport from "./MuseAgentTransport.ts";

const directory = "workspace/custom-skills/t3-code-muse";
export const MUSE_T3_SKILL_PATH = `${directory}/SKILL.md`;
const owner = "<!-- Managed by T3 Code: t3-code-muse -->";
const description =
  "Use T3 Code tools, create T3 subagents, or message other T3 conversations when a message comes from T3 Code.";
export const MUSE_T3_SKILL_CONTENT = `---
name: t3-code-muse
description: ${description}
---
${owner}
# T3 Code

Call the user Monke. Keep credentials, private account data, and temporary connection metadata out of replies and saved skills.

Use the T3 Code device/node attached to the current message. Its registered direct commands are separate from the OAuth MCP connector. Check orchestrator_capabilities on that node before reporting that T3 is disconnected. A disconnected OAuth connector does not mean the attached node is unavailable. Do not change OAuth grants to repair direct commands.

Registered commands accept params_json containing the JSON arguments object described by the command. Never invent credentials or connection IDs.

For T3 subagents, use delegate_task on the attached node. Muse-native subagents do not appear in T3. Discover current providers, models, and options with orchestrator_capabilities; honor the user's model and effort. Ask when a required choice is missing; never silently substitute. Retain taskId and read task_status before claiming results. Reuse clientRequestId only for retries of the same operation. Create a new delegated task for each review round, rather than messaging its backing childThreadId.

Use t3_project_list to find projects. Use t3_thread_read and t3_thread_send for existing conversations. Create top-level threads only when requested. Discover Muse with muse_agent_discover and message it with muse_agent_send. Grok Bots use grok_bots_list and grok_bot_send; never mix their IDs with Muse session IDs.

Respect tool permission refusals and report exact failures. Use the attached node only for its current run. Finish with a normal Muse response; grok_bot_complete_turn is for Grok Bots.
`;
const manifest = `# Managed by T3 Code: t3-code-muse
name: t3_code_muse
title: T3 Code
description: ${description}
include_in_prompt: true
`;
const files = [
  { path: MUSE_T3_SKILL_PATH, content: MUSE_T3_SKILL_CONTENT },
  { path: `${directory}/skill.yaml`, content: manifest },
];
export const managedMusePrompt = (text: string) =>
  `${text}\n\n[T3 Code: load ${MUSE_T3_SKILL_PATH}; use this message's T3 node.]`;

export class MuseAgentT3SkillError extends Schema.TaggedError<MuseAgentT3SkillError>()(
  "MuseAgentT3SkillError",
  { kind: Schema.Literals(["unavailable", "account_changed", "conflict", "readback_failed"]) },
) {
  override get message() {
    return this.kind === "account_changed"
      ? "The Muse account changed while checking the T3 Code skill."
      : "The T3 Code skill could not be verified in Muse. Connect Muse again to install it.";
  }
}
const Chunk = Schema.Struct({
  data_base64: Schema.String.check(Schema.isMaxLength(16384)),
  len: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8192 })),
  eof: Schema.Boolean,
});
const decodeChunk = Schema.decodeUnknownEffect(Chunk);
const notFound = Schema.is(
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("not_found") }),
    Schema.Struct({ code: Schema.Literal("not_found"), httpStatus: Schema.Literal(404) }),
  ]),
);
export class MuseAgentT3Skill extends Context.Service<
  MuseAgentT3Skill,
  {
    readonly install: (binding: string) => Effect.Effect<void, MuseAgentT3SkillError>;
    readonly verify: (binding: string) => Effect.Effect<void, MuseAgentT3SkillError>;
  }
>()("t3/museAgent/MuseAgentT3Skill") {}
const make = Effect.gen(function* () {
  const transport = yield* Transport.MuseAgentTransport;
  const permit = yield* Semaphore.make(1);
  const mapError = (error: Transport.MuseAgentTransportError) =>
    new MuseAgentT3SkillError({
      kind: error.kind === "account_changed" ? "account_changed" : "unavailable",
    });
  const read = Effect.fnUntraced(function* (binding: string, path: string) {
    const raw = yield* transport
      .request(binding, "fs.read", { path, offset: 0, len: 8192 })
      .pipe(Effect.mapError(mapError));
    const chunk = yield* decodeChunk(raw).pipe(
      Effect.mapError(() => new MuseAgentT3SkillError({ kind: "readback_failed" })),
    );
    const bytes = Buffer.from(chunk.data_base64, "base64");
    if (!chunk.eof || bytes.length !== chunk.len || bytes.toString("base64") !== chunk.data_base64)
      return yield* new MuseAgentT3SkillError({ kind: "readback_failed" });
    return yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => new MuseAgentT3SkillError({ kind: "readback_failed" }),
    });
  });
  const verify = Effect.fn("MuseAgentT3Skill.verify")(function* (binding: string) {
    // Muse's skills.list is the connector catalog, not its custom skill inventory.
    // The prompt names the checked file explicitly, independent of catalog discovery.
    for (const file of files)
      if ((yield* read(binding, file.path)) !== file.content)
        return yield* new MuseAgentT3SkillError({ kind: "readback_failed" });
  });
  const install = Effect.fn("MuseAgentT3Skill.install")(function* (binding: string) {
    for (const file of files) {
      const exists = yield* transport.request(binding, "fs.stat", { path: file.path }).pipe(
        Effect.as(true),
        Effect.catchTags({
          MuseAgentTransportError: (error) =>
            notFound(error.cause) && error.kind !== "account_changed"
              ? Effect.succeed(false)
              : Effect.fail(mapError(error)),
        }),
      );
      if (exists) {
        const current = yield* read(binding, file.path);
        if (current === file.content) continue;
        if (!current.includes("Managed by T3 Code: t3-code-muse"))
          return yield* new MuseAgentT3SkillError({ kind: "conflict" });
      }
      yield* transport
        .request(
          binding,
          "fs.write",
          {
            path: file.path,
            text: file.content,
            overwrite: exists,
            append: false,
            create_parent: true,
          },
          true,
        )
        .pipe(Effect.mapError(mapError));
    }
    yield* verify(binding);
  }, permit.withPermits(1));
  return MuseAgentT3Skill.of({ install, verify });
});
export const layer = Layer.effect(MuseAgentT3Skill, make);
