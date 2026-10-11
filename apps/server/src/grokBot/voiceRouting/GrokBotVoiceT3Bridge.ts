import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { GROK_BOT_MANAGED_SKILL_NAME } from "../../orchestration-v2/Adapters/GrokBotManagedBinding.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as GrokBotThreadService from "../GrokBotThreadService.ts";

/**
 * Tools the native voice harness defines itself, read from the official desktop bundle
 * (`yB.all()` in the main-process harness). `send_task` relays work to the bot's native agent
 * on the desktop, which is the execution path voice calls must not use; the rest only steer
 * the conversation and stay native.
 */
export const NATIVE_EXECUTION_TOOLS: ReadonlySet<string> = new Set(["send_task"]);
export const NATIVE_CONTROL_TOOLS: ReadonlySet<string> = new Set([
  "end_the_call",
  "recall_text_messages",
  "search_conversations",
  "stay_silent",
]);

export const T3_RUN_TASK = "t3_run_task";
export const T3_PROJECT_LIST = "t3_project_list";
export const T3_TASK_PROGRESS = "t3_task_progress";

interface VoiceToolDescriptor {
  readonly type: string;
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

/** The T3 tools a voice session gets. Shapes mirror the native descriptors: a JSON-schema object. */
export const T3_VOICE_TOOLS: ReadonlyArray<VoiceToolDescriptor> = [
  {
    type: "function",
    name: T3_RUN_TASK,
    description:
      "Do any computer, file, code, or project work by handing it to this bot's T3 Code agents. Use this instead of send_task. Say what to do in the task; pass projectId (from t3_project_list) when the user names a project. Returns once the work is accepted; it keeps running after this call.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "What the T3 agents should do, in plain words." },
        projectId: { type: "string", description: "A projectId from t3_project_list." },
      },
      required: ["task"],
    },
  },
  {
    type: "function",
    name: T3_PROJECT_LIST,
    description: "List the T3 Code projects work can run in, with their projectId.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: T3_TASK_PROGRESS,
    description: "Say whether this bot's T3 work is running or finished.",
    parameters: { type: "object", properties: {} },
  },
];

/** Short session addendum; the full protocol lives in the managed skill, not in the call prompt. */
export const T3_VOICE_INSTRUCTIONS = `Computer, file, and code work runs in T3 Code, never through send_task: call ${T3_RUN_TASK}. Follow the ${GROK_BOT_MANAGED_SKILL_NAME} skill for how T3 work is done.`;

/**
 * A session's tools are an allowlist: only native conversation controls (plain `function` tools by
 * name) survive, then the T3 tools are appended. Anything else native returns is dropped, notably
 * `mcp`-type entries (a connector the realtime model would call directly, outside this server,
 * e.g. another T3 install) and any other T3-looking or execution tool.
 */
export const routeSessionTools = (
  native: ReadonlyArray<VoiceToolDescriptor>,
): ReadonlyArray<VoiceToolDescriptor> => [
  ...native.filter((tool) => tool.type === "function" && NATIVE_CONTROL_TOOLS.has(tool.name)),
  ...T3_VOICE_TOOLS,
];

export const withT3Instructions = (instructions: string) =>
  `${instructions}\n\n${T3_VOICE_INSTRUCTIONS}`;

/**
 * Whether the voice service must answer a tool locally. `send_task` is included so a model that
 * still calls it is refused here instead of reaching native execution.
 */
export const isRoutedLocally = (name: string) =>
  NATIVE_EXECUTION_TOOLS.has(name) || T3_VOICE_TOOLS.some((tool) => tool.name === name);

/** The only names forwarded to native; every other name is refused locally as an unknown tool. */
export const isNativeControl = (name: string) => NATIVE_CONTROL_TOOLS.has(name);

/** What the voice RPC's own principal allows; the model never supplies it. */
export type VoiceAccess = "read" | "operate";

export interface VoiceToolCall {
  /** The account binding and bot the call was opened for. */
  readonly binding: string;
  readonly botId: string;
  /** The T3 call id, so a reused realtime tool call id in another call is not deduplicated. */
  readonly callId: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly input: unknown;
  readonly access: VoiceAccess;
}

export type VoiceToolOutcome =
  | { readonly kind: "served"; readonly output: unknown }
  | { readonly kind: "invalid_input"; readonly output: { readonly error: string } };

const RunTaskInput = Schema.Struct({
  task: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
  projectId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  ),
});
const decodeRunTask = Schema.decodeUnknownEffect(RunTaskInput);

const spoken = (text: string) => ({ kind: "served", output: { spoken: text } }) as const;
const MAX_PROJECTS = 25;

export class GrokBotVoiceT3Bridge extends Context.Service<
  GrokBotVoiceT3Bridge,
  {
    readonly call: (input: VoiceToolCall) => Effect.Effect<VoiceToolOutcome>;
  }
>()("t3/grokBot/voiceRouting/GrokBotVoiceT3Bridge") {}

const progressText = (run: { status: string } | undefined) =>
  run === undefined
    ? "No T3 work has been started for this bot yet."
    : `The latest T3 run is ${run.status}.`;

const make = Effect.gen(function* () {
  const threads = yield* GrokBotThreadService.GrokBotThreadService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;

  /**
   * Work starts as a message on the bot's own thread: its managed turn already carries the T3
   * MCP tools and the managed skill, and delegate_task needs a live parent run a call lacks.
   * The bot's thread keeps its own runtime and interaction modes, so nothing is escalated.
   */
  const runTask = (input: VoiceToolCall) =>
    Effect.gen(function* () {
      if (input.access !== "operate")
        return spoken("This session is not allowed to start T3 work.");
      const parsed = yield* decodeRunTask(input.input).pipe(Effect.option);
      if (parsed._tag === "None")
        return {
          kind: "invalid_input",
          output: { error: `invalid arguments for ${T3_RUN_TASK}` },
        } as const;
      const { task, projectId } = parsed.value;
      const message = [
        "[From a voice call]",
        projectId === undefined
          ? undefined
          : `Project: ${projectId} (pass it as projectId to delegate_task).`,
        task,
      ]
        .filter((line) => line !== undefined)
        .join("\n");
      const sent = yield* threads
        .send(
          {
            botId: input.botId,
            message,
            clientRequestId: `voice:${input.callId}:${input.toolCallId}`,
          },
          {
            requestNamespace: `grok-bot-voice:${input.binding}:${input.botId}`,
            voiceRequest: true,
          },
        )
        .pipe(Effect.option);
      return sent._tag === "None"
        ? spoken("T3 could not take that task right now.")
        : spoken(
            sent.value.delivery === "queued"
              ? "Queued in T3 behind earlier work."
              : "Started in T3. It keeps running on its own.",
          );
    });

  const projectList = Effect.gen(function* () {
    const snapshot = yield* projects.snapshot.pipe(Effect.option);
    if (snapshot._tag === "None") return spoken("T3 projects are unavailable right now.");
    const rows = snapshot.value.projects.filter((project) => project.deletedAt === null);
    return {
      kind: "served",
      output: {
        projects: rows
          .slice(0, MAX_PROJECTS)
          .map((project) => ({ projectId: project.id, title: project.title })),
        truncated: rows.length > MAX_PROJECTS,
      },
    } as const;
  });

  /** Reads only run status from the bot's own canonical thread; no MCP scope is involved. */
  const progress = (input: VoiceToolCall) =>
    Effect.gen(function* () {
      const opened = yield* threads.open({ botId: input.botId }).pipe(Effect.option);
      if (opened._tag === "None") return spoken("T3 is not ready for this bot.");
      const read = yield* threadManagement
        .getThreadRecords(ThreadId.make(opened.value.threadId), ["runs"])
        .pipe(Effect.option);
      if (read._tag === "None") return spoken("T3 progress is unavailable right now.");
      const latest = read.value.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      return spoken(progressText(latest));
    });

  return GrokBotVoiceT3Bridge.of({
    call: (input) => {
      if (NATIVE_EXECUTION_TOOLS.has(input.name))
        return Effect.succeed(spoken(`Use ${T3_RUN_TASK} for that; native task execution is off.`));
      switch (input.name) {
        case T3_RUN_TASK:
          return runTask(input);
        case T3_PROJECT_LIST:
          return projectList;
        case T3_TASK_PROGRESS:
          return progress(input);
        default:
          return Effect.succeed({
            kind: "invalid_input",
            output: { error: `${input.name} is not a T3 voice tool` },
          } as const);
      }
    },
  });
});

export const layer = Layer.effect(GrokBotVoiceT3Bridge, make);
