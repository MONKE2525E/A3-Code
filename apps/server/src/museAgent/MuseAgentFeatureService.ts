import * as Features from "@t3tools/contracts/museAgentFeatures";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Transport from "./MuseAgentTransport.ts";

/** Public feature failures never retain native payloads, credential text, or arbitrary defect messages. */
export class MuseAgentFeatureError extends Schema.TaggedError<MuseAgentFeatureError>()(
  "MuseAgentFeatureError",
  {
    feature: Features.MuseAgentFeature,
    code: Schema.Literals([
      "unavailable",
      "account_changed",
      "connection_unavailable",
      "invalid_request",
      "invalid_response",
      "write_uncertain",
      "conflict",
      "refused",
    ]),
  },
) {
  override get message() {
    switch (this.code) {
      case "unavailable":
        return "This Muse feature is unavailable in the verified native protocol or on this account.";
      case "account_changed":
        return "The Muse account or cloud workspace changed. Set up a new binding.";
      case "connection_unavailable":
        return "The authenticated Muse connection is unavailable.";
      case "invalid_request":
        return "The Muse feature request is invalid.";
      case "invalid_response":
        return "Muse returned an unsupported feature response.";
      case "write_uncertain":
        return "Muse may have accepted this change. Refresh before trying again.";
      case "conflict":
        return "This Muse document changed. Reload it before saving.";
      default:
        return "Muse refused this feature action.";
    }
  }
}

const Id = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
  // eslint-disable-next-line no-control-regex -- Native IDs must not contain control characters.
  Schema.isPattern(/^[^\u0000-\u001f\u007f]+$/),
);
const Binding = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const NativeText = Schema.String.check(Schema.isMaxLength(8192));
const Content = Schema.String.check(Schema.isMaxLength(131072));
const optionalText = Schema.optionalKey(Schema.NullOr(NativeText));
const optionalContent = Schema.optionalKey(Schema.NullOr(Content));
const NativeMemory = Schema.Struct({
  memory_uri: Schema.optionalKey(Schema.NullOr(Id)),
  uri: Schema.optionalKey(Schema.NullOr(Id)),
  id: Schema.optionalKey(Schema.NullOr(Id)),
  title: optionalText,
  summary: optionalContent,
  snippet: optionalContent,
  content_markdown: optionalContent,
  content: optionalContent,
  text: optionalContent,
  value: optionalContent,
});
const NativeMemoryHit = Schema.Struct({
  ...NativeMemory.fields,
  memory: Schema.optionalKey(Schema.NullOr(NativeMemory)),
  score: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
const NativeMemoryGet = Schema.Struct({
  ...NativeMemoryHit.fields,
  entry: Schema.optionalKey(Schema.NullOr(NativeMemory)),
  result: Schema.optionalKey(Schema.NullOr(NativeMemory)),
  hit: Schema.optionalKey(Schema.NullOr(NativeMemoryHit)),
});
const NativeTask = Schema.Struct({
  id: Id,
  title: optionalText,
  schedule_key: NativeText,
  timezone: optionalText,
  next_run_at_utc: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  is_heartbeat: Schema.optionalKey(Schema.Boolean),
});
const NativeRun = Schema.Struct({ run_id: Id, job_id: Id, status: optionalText });
const NativeConnector = Schema.Struct({
  id: Id,
  name: optionalText,
  description: optionalText,
  state: optionalText,
  supports_multiple_accounts: Schema.optionalKey(Schema.Boolean),
  is_custom: Schema.optionalKey(Schema.Boolean),
});
const NativeSkill = Schema.Struct({
  name: Id,
  title: optionalText,
  description: optionalText,
  category: optionalText,
  source: optionalText,
  requires_auth: Schema.optionalKey(Schema.Boolean),
  official: Schema.optionalKey(Schema.Boolean),
  enabled: Schema.optionalKey(Schema.Boolean),
  disabled: Schema.optionalKey(Schema.Boolean),
  user_disabled: Schema.optionalKey(Schema.Boolean),
  eligible: Schema.optionalKey(Schema.Boolean),
  status: optionalText,
  status_reason: optionalText,
  blocked_by_allowlist: Schema.optionalKey(Schema.Boolean),
  managed_by: optionalText,
  auth_provider: optionalText,
  connector_slug: optionalText,
});
const NativeSession = Schema.Struct({
  session_id: Id,
  status: NativeText,
  is_primary: Schema.Boolean,
  is_thread: Schema.Boolean,
  title: optionalText,
  snippet: optionalText,
  archived: Schema.optionalKey(Schema.Boolean),
  pinned: Schema.optionalKey(Schema.Boolean),
  can_send_messages: Schema.optionalKey(Schema.Boolean),
  can_send_actions: Schema.optionalKey(Schema.Boolean),
  read_only_reason: optionalText,
});
const NativeComputerTask = Schema.Struct({
  browser_task_id: Schema.optionalKey(Id),
  activity_thread_id: Schema.optionalKey(Id),
  session_id: Schema.optionalKey(Id),
  title: optionalText,
  name: optionalText,
  status: optionalText,
  display_status: optionalText,
  preview_available: Schema.optionalKey(Schema.Boolean),
  queue_position: Schema.optionalKey(Schema.Int),
  control_owner: optionalText,
  owner_kind: optionalText,
});
const NativeErrorCode = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  httpStatus: Schema.optionalKey(Schema.Int),
  status: Schema.optionalKey(Schema.Int),
});
const isNativeErrorCode = Schema.is(NativeErrorCode);
const ProfileDocument = Schema.Literals(["identity", "soul", "memory"]);
const ProfileRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const PROFILE_DOCUMENT_MAX_BYTES = 1024 * 1024;
const ProfileContent = Schema.String.check(Schema.isMaxLength(PROFILE_DOCUMENT_MAX_BYTES));
const ProfileChunk = Schema.Struct({
  data_base64: Schema.String.check(
    Schema.isMaxLength(4 * Math.ceil(PROFILE_DOCUMENT_MAX_BYTES / 3)),
  ),
  len: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(PROFILE_DOCUMENT_MAX_BYTES),
  ),
  eof: Schema.Boolean,
});
const profilePaths = { identity: "IDENTITY.md", soul: "SOUL.md", memory: "MEMORY.md" };
const ThemeId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const ThemeColor = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const WireColor = Schema.Struct({ light: ThemeColor, dark: ThemeColor });
const WirePalette = Schema.Struct({
  userText: WireColor,
  userBubble: WireColor,
  botText: WireColor,
  botBubble: WireColor,
  background: WireColor,
});
const WireThemes = Schema.Struct({
  selected_theme_id: Schema.NullOr(ThemeId),
  order: Schema.Array(ThemeId).check(Schema.isMaxLength(256)),
  options: Schema.Record(ThemeId, WirePalette),
});
const compact = (value: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));

const inventory: Features.MuseAgentFeatureInventory = {
  accountAvailability: "unverified",
  features: [
    { feature: "memory", operations: ["search", "read"], support: "documented" },
    { feature: "tasks", operations: ["list", "runs", "delete"], support: "documented" },
    { feature: "connectors", operations: ["list"], support: "documented" },
    { feature: "skills", operations: ["list"], support: "documented" },
    {
      feature: "sessions",
      operations: ["list", "rename", "archive", "unarchive", "history_page"],
      support: "documented",
    },
    {
      feature: "profile",
      operations: ["read_document", "save_document", "themes", "set_theme"],
      support: "documented",
    },
    { feature: "computer", operations: ["status"], support: "documented" },
    { feature: "dictation", operations: ["status", "transcribe"], support: "documented" },
  ],
};

export class MuseAgentFeatureService extends Context.Service<
  MuseAgentFeatureService,
  {
    readonly inventory: (
      binding: string,
    ) => Effect.Effect<Features.MuseAgentFeatureInventory, MuseAgentFeatureError>;
    readonly searchMemory: (
      binding: string,
      query: string,
    ) => Effect.Effect<readonly Features.MuseAgentMemory[], MuseAgentFeatureError>;
    readonly readMemory: (
      binding: string,
      uri: string,
    ) => Effect.Effect<Features.MuseAgentMemory, MuseAgentFeatureError>;
    readonly tasks: (
      binding: string,
    ) => Effect.Effect<readonly Features.MuseAgentTask[], MuseAgentFeatureError>;
    readonly taskRuns: (
      binding: string,
      jobId?: string,
    ) => Effect.Effect<readonly Features.MuseAgentTaskRun[], MuseAgentFeatureError>;
    readonly deleteTask: (
      binding: string,
      jobId: string,
    ) => Effect.Effect<void, MuseAgentFeatureError>;
    readonly connectors: (
      binding: string,
    ) => Effect.Effect<readonly Features.MuseAgentConnector[], MuseAgentFeatureError>;
    readonly skills: (
      binding: string,
    ) => Effect.Effect<readonly Features.MuseAgentSkill[], MuseAgentFeatureError>;
    readonly sessions: (
      binding: string,
      view?: "active" | "archived",
    ) => Effect.Effect<readonly Features.MuseAgentFeatureSession[], MuseAgentFeatureError>;
    readonly renameSession: (
      binding: string,
      sessionId: string,
      title: string,
    ) => Effect.Effect<{ readonly title: string }, MuseAgentFeatureError>;
    readonly setSessionArchived: (
      binding: string,
      sessionId: string,
      archived: boolean,
    ) => Effect.Effect<void, MuseAgentFeatureError>;
    readonly computerStatus: (
      binding: string,
    ) => Effect.Effect<Features.MuseAgentComputerStatus, MuseAgentFeatureError>;
    readonly readProfileDocument: (
      binding: string,
      document: "identity" | "soul" | "memory",
    ) => Effect.Effect<Features.MuseAgentProfileDocument, MuseAgentFeatureError>;
    readonly saveProfileDocument: (
      binding: string,
      document: "identity" | "soul" | "memory",
      content: string,
      expectedRevision: string,
    ) => Effect.Effect<Features.MuseAgentProfileDocument, MuseAgentFeatureError>;
    readonly themes: (
      binding: string,
    ) => Effect.Effect<Features.MuseAgentThemes, MuseAgentFeatureError>;
    readonly setTheme: (
      binding: string,
      themeId: string,
    ) => Effect.Effect<void, MuseAgentFeatureError>;
  }
>()("t3/museAgent/MuseAgentFeatureService") {}

const make = Effect.gen(function* () {
  const transport = yield* Transport.MuseAgentTransport;
  const crypto = yield* Crypto.Crypto;
  const profileWritePermit = yield* Semaphore.make(1);
  const contentRevision = (content: string) =>
    crypto.digest("SHA-256", Buffer.from(content, "utf8")).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
      Effect.mapError(() => new MuseAgentFeatureError({ feature: "profile", code: "refused" })),
    );
  const failure = (
    feature: Features.MuseAgentFeature,
    error: Transport.MuseAgentTransportError,
  ) => {
    if (error.kind === "account_changed")
      return new MuseAgentFeatureError({ feature, code: "account_changed" });
    // Only structured native codes cross this boundary. Playwright text is not parsed as protocol evidence.
    const native = isNativeErrorCode(error.cause) ? error.cause : undefined;
    if (
      native &&
      [
        "method_not_found",
        "unknown_method",
        "unsupported_method",
        "not_implemented",
        "computer_disabled",
      ].includes(native.code ?? "")
    ) {
      return new MuseAgentFeatureError({ feature, code: "unavailable" });
    }
    const status = native?.httpStatus ?? native?.status;
    if (status === 501) return new MuseAgentFeatureError({ feature, code: "unavailable" });
    if (status === 403) return new MuseAgentFeatureError({ feature, code: "refused" });
    const code =
      error.kind === "uncertain"
        ? "write_uncertain"
        : error.kind === "protocol"
          ? "invalid_response"
          : "connection_unavailable";
    return new MuseAgentFeatureError({ feature, code });
  };
  const decode = <S extends Schema.Top>(
    feature: Features.MuseAgentFeature,
    schema: S,
    value: unknown,
  ) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => new MuseAgentFeatureError({ feature, code: "invalid_response" })),
    );
  const validate = <S extends Schema.Top>(
    feature: Features.MuseAgentFeature,
    schema: S,
    value: unknown,
  ) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => new MuseAgentFeatureError({ feature, code: "invalid_request" })),
    );
  const check = Effect.fnUntraced(function* (feature: Features.MuseAgentFeature, binding: string) {
    yield* validate(feature, Binding, binding);
    const current = yield* transport.connect.pipe(
      Effect.mapError((error) => failure(feature, error)),
    );
    if (current !== binding)
      return yield* new MuseAgentFeatureError({ feature, code: "account_changed" });
  });
  const request = Effect.fnUntraced(function* (
    feature: Features.MuseAgentFeature,
    binding: string,
    method: string,
    params: Record<string, unknown>,
    write = false,
  ) {
    yield* check(feature, binding);
    return yield* transport
      .request(binding, method, params, write)
      .pipe(Effect.mapError((error) => failure(feature, error)));
  });
  const memory = Effect.fnUntraced(function* (
    native: typeof NativeMemoryHit.Type,
    requestedUri?: string,
    forRead = false,
  ) {
    const inner = native.memory ?? native;
    const uri =
      inner.memory_uri ?? inner.uri ?? inner.id ?? native.memory_uri ?? native.uri ?? requestedUri;
    const summary = inner.summary ?? native.summary ?? native.snippet ?? undefined;
    const contentMarkdown =
      inner.content_markdown ??
      inner.content ??
      inner.text ??
      (forRead ? inner.value : undefined) ??
      native.content_markdown ??
      native.snippet ??
      (forRead ? summary : undefined);
    // The requested URI is not proof that an empty response represents a readable memory.
    if (!uri || (forRead && contentMarkdown === undefined && inner.title == null)) {
      return yield* new MuseAgentFeatureError({ feature: "memory", code: "invalid_response" });
    }
    return yield* decode(
      "memory",
      Features.MuseAgentMemory,
      compact({
        uri,
        title: inner.title ?? native.title ?? "Memory entry",
        summary,
        contentMarkdown,
        score: native.score ?? undefined,
      }),
    );
  });
  const readProfileDocument = Effect.fnUntraced(function* (
    binding: string,
    document: "identity" | "soul" | "memory",
  ) {
    const selected = yield* validate("profile", ProfileDocument, document);
    const chunks: Uint8Array[] = [];
    let offset = 0;
    let complete = false;
    while (!complete) {
      if (chunks.length >= 256)
        return yield* new MuseAgentFeatureError({ feature: "profile", code: "invalid_response" });
      const limit = Math.min(PROFILE_DOCUMENT_MAX_BYTES, PROFILE_DOCUMENT_MAX_BYTES - offset + 1);
      const native = yield* decode(
        "profile",
        ProfileChunk,
        yield* request("profile", binding, "fs.read", {
          path: profilePaths[selected],
          offset,
          len: limit,
        }),
      );
      const bytes = Buffer.from(native.data_base64, "base64");
      // Buffer's permissive decoder alone accepts truncated and non-base64 native payloads.
      if (
        bytes.toString("base64") !== native.data_base64 ||
        bytes.byteLength !== native.len ||
        native.len > limit ||
        offset + native.len > PROFILE_DOCUMENT_MAX_BYTES ||
        (native.len === 0 && !native.eof)
      ) {
        return yield* new MuseAgentFeatureError({ feature: "profile", code: "invalid_response" });
      }
      chunks.push(bytes);
      offset += native.len;
      complete = native.eof;
    }
    const content = yield* Effect.try({
      try: () =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)),
      catch: () => new MuseAgentFeatureError({ feature: "profile", code: "invalid_response" }),
    });
    return { document: selected, content, revision: yield* contentRevision(content) };
  });
  const themes = Effect.fnUntraced(function* (binding: string) {
    const native = yield* decode(
      "profile",
      WireThemes,
      yield* request("profile", binding, "chat.themes", {}),
    );
    const ids = Object.keys(native.options);
    if (
      ids.length > 256 ||
      new Set(native.order).size !== native.order.length ||
      native.order.some((id) => !Object.hasOwn(native.options, id)) ||
      (native.selected_theme_id !== null &&
        !Object.hasOwn(native.options, native.selected_theme_id))
    ) {
      return yield* new MuseAgentFeatureError({ feature: "profile", code: "invalid_response" });
    }
    const options = Object.fromEntries(
      Object.entries(native.options).map(([id, palette]) => {
        const variant = (mode: "light" | "dark") => ({
          userText: palette.userText[mode],
          userBubble: palette.userBubble[mode],
          agentText: palette.botText[mode],
          agentBubble: palette.botBubble[mode],
          background: palette.background[mode],
        });
        return [id, { light: variant("light"), dark: variant("dark") }];
      }),
    );
    return { selectedThemeId: native.selected_theme_id, order: native.order, options };
  });
  return MuseAgentFeatureService.of({
    readProfileDocument,
    saveProfileDocument: Effect.fn("MuseAgentFeatureService.saveProfileDocument")(function* (
      binding,
      document,
      content,
      expectedRevision,
    ) {
      const selected = yield* validate("profile", ProfileDocument, document);
      yield* validate("profile", ProfileContent, content);
      yield* validate("profile", ProfileRevision, expectedRevision);
      const bytes = Buffer.from(content, "utf8");
      if (bytes.byteLength > PROFILE_DOCUMENT_MAX_BYTES || bytes.toString("utf8") !== content)
        return yield* new MuseAgentFeatureError({ feature: "profile", code: "invalid_request" });
      const revision = yield* contentRevision(content);
      const current = yield* readProfileDocument(binding, selected);
      if (current.revision !== expectedRevision)
        return yield* new MuseAgentFeatureError({ feature: "profile", code: "conflict" });
      // Native fs.write has no atomic compare-and-swap. This catches stale edits before dispatch;
      // the permit serializes T3 saves, while external native editors can still race this check.
      yield* request(
        "profile",
        binding,
        "fs.write",
        {
          path: profilePaths[selected],
          text: content,
          overwrite: true,
          append: false,
          create_parent: false,
        },
        true,
      );
      return { document: selected, content, revision };
    }, profileWritePermit.withPermits(1)),
    themes,
    setTheme: Effect.fnUntraced(function* (binding, themeId) {
      yield* validate("profile", ThemeId, themeId);
      const catalog = yield* themes(binding);
      if (!Object.hasOwn(catalog.options, themeId))
        return yield* new MuseAgentFeatureError({ feature: "profile", code: "invalid_request" });
      yield* request("profile", binding, "chat.themes.set", { theme_id: themeId }, true);
    }),
    inventory: (binding) => check("inventory", binding).pipe(Effect.as(inventory)),
    searchMemory: Effect.fnUntraced(function* (binding, query) {
      const clean = yield* validate(
        "memory",
        Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
        query.trim(),
      );
      // Bundle 28,544,881: memory.search uses both top_k and limit.
      const result = yield* request("memory", binding, "memory.search", {
        query: clean,
        top_k: 8,
        limit: 8,
      });
      const native = yield* decode(
        "memory",
        Schema.Struct({ hits: Schema.Array(NativeMemoryHit) }),
        result,
      );
      return yield* Effect.forEach(native.hits, (hit) => memory(hit));
    }),
    readMemory: Effect.fnUntraced(function* (binding, uri) {
      yield* validate("memory", Id, uri);
      // Bundle 28,539,391: both aliases are supplied by the official client.
      const result = yield* request("memory", binding, "memory.get", { memory_uri: uri, uri });
      const native = yield* decode("memory", NativeMemoryGet, result);
      const inner = native.memory ?? native.entry ?? native.result;
      return yield* memory(
        { ...(native.hit ?? native), ...(inner === undefined ? {} : { memory: inner }) },
        uri,
        true,
      );
    }),
    tasks: Effect.fnUntraced(function* (binding) {
      const result = yield* request("tasks", binding, "tasks.list", {});
      const native = yield* decode(
        "tasks",
        Schema.Struct({ schedules: Schema.Array(NativeTask) }),
        result,
      );
      return yield* decode(
        "tasks",
        Schema.Array(Features.MuseAgentTask),
        native.schedules.map((task) =>
          compact({
            id: task.id,
            title: task.title ?? undefined,
            scheduleKey: task.schedule_key,
            timezone: task.timezone ?? undefined,
            nextRunAtUtc: task.next_run_at_utc ?? undefined,
            isHeartbeat: task.is_heartbeat,
          }),
        ),
      );
    }),
    taskRuns: Effect.fnUntraced(function* (binding, jobId) {
      if (jobId !== undefined) yield* validate("tasks", Id, jobId);
      const result = yield* request("tasks", binding, "tasks.runs", {
        limit: 100,
        ...(jobId === undefined ? {} : { job_id: jobId }),
      });
      const native = yield* decode(
        "tasks",
        Schema.Struct({ runs: Schema.Array(NativeRun) }),
        result,
      );
      return yield* decode(
        "tasks",
        Schema.Array(Features.MuseAgentTaskRun),
        native.runs.map((run) =>
          compact({ runId: run.run_id, jobId: run.job_id, status: run.status ?? undefined }),
        ),
      );
    }),
    deleteTask: Effect.fnUntraced(function* (binding, jobId) {
      yield* validate("tasks", Id, jobId);
      // Bundle 38,107,854 ignores the native response; do not invent an acknowledgement body.
      yield* request("tasks", binding, "tasks.delete", { job_id: jobId }, true);
    }),
    connectors: Effect.fnUntraced(function* (binding) {
      const result = yield* request("connectors", binding, "connectors.list", {
        surface: "settings",
      });
      const native = yield* decode(
        "connectors",
        Schema.Struct({ connectors: Schema.Array(NativeConnector) }),
        result,
      );
      return yield* decode(
        "connectors",
        Schema.Array(Features.MuseAgentConnector),
        native.connectors.map((item) =>
          compact({
            id: item.id,
            name: item.name ?? item.id,
            description: item.description ?? "",
            state: ["connected", "disconnected", "coming_soon"].includes(item.state ?? "")
              ? item.state
              : "unknown",
            supportsMultipleAccounts: item.supports_multiple_accounts,
            isCustom: item.is_custom,
          }),
        ),
      );
    }),
    skills: Effect.fnUntraced(function* (binding) {
      const result = yield* request("skills", binding, "skills.list", {});
      const native = yield* decode(
        "skills",
        Schema.Struct({ skills: Schema.Array(NativeSkill) }),
        result,
      );
      return yield* decode(
        "skills",
        Schema.Array(Features.MuseAgentSkill),
        native.skills.map((skill) =>
          compact({
            name: skill.name,
            title: skill.title ?? undefined,
            description: skill.description ?? "",
            category: skill.category ?? "uncategorized",
            source: skill.source ?? undefined,
            requiresAuth: skill.requires_auth,
            official: skill.official,
            enabled: skill.enabled,
            disabled: skill.disabled,
            userDisabled: skill.user_disabled,
            eligible: skill.eligible,
            status: skill.status ?? undefined,
            statusReason: skill.status_reason ?? undefined,
            blockedByAllowlist: skill.blocked_by_allowlist,
            managedBy: skill.managed_by ?? undefined,
            authProvider: skill.auth_provider ?? undefined,
            connectorSlug: skill.connector_slug ?? undefined,
          }),
        ),
      );
    }),
    sessions: Effect.fnUntraced(function* (binding, view = "active") {
      yield* validate("sessions", Schema.Literals(["active", "archived"]), view);
      const result = yield* request("sessions", binding, "sessions.list", {
        include_peer_sidechats: true,
        ...(view === "archived" ? { view } : {}),
      });
      const native = yield* decode(
        "sessions",
        Schema.Struct({ sessions: Schema.Array(NativeSession) }),
        result,
      );
      return yield* decode(
        "sessions",
        Schema.Array(Features.MuseAgentFeatureSession),
        native.sessions.map((session) =>
          compact({
            sessionId: session.session_id,
            status: session.status,
            isPrimary: session.is_primary,
            isThread: session.is_thread,
            title: session.title ?? undefined,
            snippet: session.snippet ?? undefined,
            archived: session.archived,
            pinned: session.pinned,
            canSendMessages: session.can_send_messages,
            canSendActions: session.can_send_actions,
            readOnlyReason: session.read_only_reason ?? undefined,
          }),
        ),
      );
    }),
    renameSession: Effect.fnUntraced(function* (binding, sessionId, title) {
      yield* validate("sessions", Id, sessionId);
      const clean = yield* validate(
        "sessions",
        Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
        title.trim(),
      );
      // Bundle 4,339,560 requires updated === true and uses the returned title.
      const result = yield* request(
        "sessions",
        binding,
        "session.rename",
        { session_id: sessionId, title: clean },
        true,
      );
      const native = yield* decode(
        "sessions",
        Schema.Struct({ updated: Schema.Boolean, title: NativeText }),
        result,
      );
      if (!native.updated)
        return yield* new MuseAgentFeatureError({ feature: "sessions", code: "refused" });
      return { title: native.title };
    }),
    setSessionArchived: Effect.fnUntraced(function* (binding, sessionId, archived) {
      yield* validate("sessions", Id, sessionId);
      yield* validate("sessions", Schema.Boolean, archived);
      // Bundle 32,746,036 includes the API method inside the params for both directions.
      const method = archived ? "session.archive" : "session.unarchive";
      yield* request(
        "sessions",
        binding,
        method,
        {
          method: archived ? "/api/session/archive" : "/api/session/unarchive",
          session_id: sessionId,
        },
        true,
      );
    }),
    computerStatus: Effect.fnUntraced(function* (binding) {
      const result = yield* request("computer", binding, "computer.context", {});
      const native = yield* decode(
        "computer",
        Schema.Struct({ tasks: Schema.Array(NativeComputerTask) }),
        result,
      );
      const tasks = yield* Effect.forEach(native.tasks, (task) => {
        const taskId = task.browser_task_id ?? task.activity_thread_id;
        const readOnly = task.browser_task_id === undefined;
        const title = task.title ?? (readOnly ? task.name : undefined);
        if (!taskId || !title || (!readOnly && !task.session_id))
          return Effect.fail(
            new MuseAgentFeatureError({ feature: "computer", code: "invalid_response" }),
          );
        return decode(
          "computer",
          Features.MuseAgentComputerTask,
          compact({
            taskId,
            title,
            readOnly,
            sessionId: task.session_id,
            status: task.status ?? undefined,
            displayStatus: task.display_status ?? undefined,
            previewAvailable: task.preview_available === true,
            queuePosition: task.queue_position,
            controlOwner: task.control_owner ?? undefined,
            ownerKind: task.owner_kind ?? undefined,
          }),
        );
      });
      return { available: true, tasks };
    }),
  });
});

export const layer = Layer.effect(MuseAgentFeatureService, make);
