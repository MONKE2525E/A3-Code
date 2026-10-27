import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Features from "../../../../packages/contracts/src/museAgentFeatures.ts";
import * as CryptoPlatform from "@effect/platform-node/NodeCrypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Independent synchronous test fixtures compute the expected SHA-256 outside the service under test.
import * as NodeCrypto from "node:crypto";
import * as Service from "./MuseAgentFeatureService.ts";
import * as Transport from "./MuseAgentTransport.ts";

const binding = "a".repeat(64);
const isInventory = Schema.is(Features.MuseAgentFeatureInventory);
const isComputerStatus = Schema.is(Features.MuseAgentComputerStatus);
// Synthetic fixtures exercise fields consumed by the bundled Muse 6 client, not a live account.
const fixture = (
  responses: Readonly<Record<string, unknown>>,
  respond?: (
    method: string,
    params: Record<string, unknown>,
  ) => Effect.Effect<unknown, Transport.MuseAgentTransportError>,
) => {
  const calls: {
    binding: string;
    method: string;
    params: Record<string, unknown>;
    write: boolean;
  }[] = [];
  let currentBinding = binding;
  let error: Transport.MuseAgentTransportError | undefined;
  let connectCalls = 0;
  const transport = Transport.MuseAgentTransport.of({
    subscription: () =>
      Effect.succeed({ value: { tier: { name: "Muse Free" } }, accountFingerprint: "account" }),
    acquireTurn: () => Effect.succeed(Effect.void),
    releaseOwned: () => Effect.void,
    connect: Effect.sync(() => {
      connectCalls++;
      return currentBinding;
    }),
    request: (account, method, params, write = false) =>
      Effect.suspend(() => {
        calls.push({ binding: account, method, params, write });
        return error
          ? Effect.fail(error)
          : (respond?.(method, params) ?? Effect.succeed(responses[method]));
      }),
    watch: () => Effect.die("unused watch"),
    connectionId: () => Effect.die("unused connectionId"),
    readAvatar: () => Effect.die("unused readAvatar"),
    openComputerStream: () => Effect.die("unused openComputerStream"),
    readComputerPreview: () => Effect.die("unused readComputerPreview"),
    cancelOwned: () => Effect.die("unused cancelOwned"),
    registerTools: () => Effect.die("unused registerTools"),
    unregisterTools: () => Effect.die("unused unregisterTools"),
  });
  return {
    calls,
    layer: Service.layer.pipe(
      Layer.provide(Layer.succeed(Transport.MuseAgentTransport, transport)),
      Layer.provide(CryptoPlatform.layer),
    ),
    changeAccount: () => {
      currentBinding = "b".repeat(64);
    },
    fail: (failure: Transport.MuseAgentTransportError) => {
      error = failure;
    },
    get connectCalls() {
      return connectCalls;
    },
  };
};

it.effect(
  "inventory distinguishes bundled support from account availability and unverified writes",
  () => {
    const f = fixture({});
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentFeatureService;
      const result = yield* service.inventory(binding);
      expect(isInventory(result)).toBe(true);
      expect(result.accountAvailability).toBe("unverified");
      expect(result.features.find((item) => item.feature === "profile")).toEqual({
        feature: "profile",
        operations: ["read_document", "save_document", "themes", "set_theme"],
        support: "documented",
      });
      expect(result.features.find((item) => item.feature === "sessions")?.operations).toEqual([
        "list",
        "rename",
        "archive",
        "unarchive",
        "history_page",
      ]);
      expect(result.features.find((item) => item.feature === "dictation")).toEqual({
        feature: "dictation",
        operations: ["status", "transcribe"],
        support: "documented",
      });
      expect(result.features.find((item) => item.feature === "skills")?.operations).toEqual([
        "list",
      ]);
      expect(f.calls).toEqual([]);
      expect(f.connectCalls).toBe(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "searches native memory with bounded params and preserves markdown while dropping extra fields",
  () => {
    const f = fixture({
      "memory.search": {
        hits: [
          {
            memory: {
              memory_uri: "memory://one",
              title: "First",
              summary: "Summary",
              content_markdown: "# Detail\n\nFull text",
              privateToken: "synthetic-private",
            },
            score: 0.9,
          },
          { uri: "memory://two", title: "Second", snippet: "Relevant excerpt" },
        ],
      },
    });
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentFeatureService;
      const results = yield* service.searchMemory(binding, "  project  ");
      expect(results).toEqual([
        {
          uri: "memory://one",
          title: "First",
          summary: "Summary",
          contentMarkdown: "# Detail\n\nFull text",
          score: 0.9,
        },
        {
          uri: "memory://two",
          title: "Second",
          summary: "Relevant excerpt",
          contentMarkdown: "Relevant excerpt",
        },
      ]);
      expect(JSON.stringify(results)).not.toContain("synthetic-private");
      expect(f.calls).toEqual([
        {
          binding,
          method: "memory.search",
          params: { query: "project", top_k: 8, limit: 8 },
          write: false,
        },
      ]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each(["memory", "entry", "result"] as const)(
  "reads the documented $0 memory envelope with both URI aliases",
  (envelope) => {
    const f = fixture({
      "memory.get": {
        memory: null,
        hit: null,
        [envelope]: {
          memory_uri: null,
          uri: "memory://one",
          title: "Memory",
          value: "Long-form content",
        },
        score: null,
      },
    });
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentFeatureService;
      expect(yield* service.readMemory(binding, "memory://one")).toMatchObject({
        uri: "memory://one",
        contentMarkdown: "Long-form content",
      });
      expect(f.calls[0]?.params).toEqual({ memory_uri: "memory://one", uri: "memory://one" });
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "reads nested hit memory and rejects an empty get result instead of inventing content",
  () => {
    const f = fixture({
      "memory.get": {
        hit: { memory: { title: "Known", content: "Body" }, snippet: "Snippet", score: 0.8 },
      },
    });
    const empty = fixture({ "memory.get": {} });
    return Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const service = yield* Service.MuseAgentFeatureService;
        return yield* service.readMemory(binding, "memory://one");
      }).pipe(Effect.provide(f.layer));
      expect(result).toMatchObject({ title: "Known", contentMarkdown: "Body", score: 0.8 });
      yield* Effect.gen(function* () {
        const service = yield* Service.MuseAgentFeatureService;
        expect((yield* Effect.flip(service.readMemory(binding, "memory://one"))).code).toBe(
          "invalid_response",
        );
      }).pipe(Effect.provide(empty.layer));
    });
  },
);

it.effect("lists schedule details and runs with the native limit and optional job filter", () => {
  const f = fixture({
    "tasks.list": {
      schedules: [
        {
          id: "routine",
          title: "Daily report",
          schedule_key: "daily@09:00",
          timezone: "America/Vancouver",
          next_run_at_utc: 1770000000,
          is_heartbeat: false,
          prompt: "unverified field",
        },
      ],
    },
    "tasks.runs": {
      runs: [{ run_id: "run-one", job_id: "routine", status: "completed", extra: "ignored" }],
    },
  });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect(yield* service.tasks(binding)).toEqual([
      {
        id: "routine",
        title: "Daily report",
        scheduleKey: "daily@09:00",
        timezone: "America/Vancouver",
        nextRunAtUtc: 1770000000,
        isHeartbeat: false,
      },
    ]);
    expect(yield* service.taskRuns(binding, "routine")).toEqual([
      { runId: "run-one", jobId: "routine", status: "completed" },
    ]);
    yield* service.taskRuns(binding);
    expect(f.calls.map((call) => [call.method, call.params, call.write])).toEqual([
      ["tasks.list", {}, false],
      ["tasks.runs", { limit: 100, job_id: "routine" }, false],
      ["tasks.runs", { limit: 100 }, false],
    ]);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "lists settings connectors without leaking account/OAuth details or hiding unknown states",
  () => {
    const f = fixture({
      "connectors.list": {
        connectors: [
          {
            id: "drive",
            name: "Drive",
            description: "Files",
            state: "connected",
            supports_multiple_accounts: true,
            consent: {
              account_center: { consent_url: "https://example.invalid/?token=synthetic" },
            },
            accounts: ["private"],
          },
          { id: "future", state: "new-state" },
        ],
      },
    });
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentFeatureService;
      expect(yield* service.connectors(binding)).toEqual([
        {
          id: "drive",
          name: "Drive",
          description: "Files",
          state: "connected",
          supportsMultipleAccounts: true,
        },
        { id: "future", name: "future", description: "", state: "unknown" },
      ]);
      expect(f.calls[0]?.params).toEqual({ surface: "settings" });
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("retains native skill eligibility and disabled flags independently", () => {
  const f = fixture({
    "skills.list": {
      skills: [
        {
          name: "calendar",
          title: "Calendar",
          description: "Events",
          category: "productivity",
          source: "official",
          requires_auth: true,
          official: true,
          enabled: false,
          disabled: true,
          user_disabled: false,
          eligible: false,
          status: "blocked",
          status_reason: "Unavailable",
          blocked_by_allowlist: true,
          managed_by: "agent",
          auth_provider: "calendar",
          connector_slug: "calendar",
          token: "synthetic",
        },
      ],
    },
  });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    const result = yield* service.skills(binding);
    expect(result[0]).toMatchObject({
      enabled: false,
      disabled: true,
      userDisabled: false,
      eligible: false,
      blockedByAllowlist: true,
      statusReason: "Unavailable",
      managedBy: "agent",
      requiresAuth: true,
    });
    expect(JSON.stringify(result)).not.toContain("synthetic");
    expect(f.calls[0]?.params).toEqual({});
  }).pipe(Effect.provide(f.layer));
});

it.effect("lists active and archived sessions and preserves native read-only permissions", () => {
  const f = fixture({
    "sessions.list": {
      sessions: [
        {
          session_id: "peer",
          status: "idle",
          is_primary: false,
          is_thread: true,
          title: "Peer",
          archived: true,
          pinned: false,
          can_send_messages: false,
          can_send_actions: false,
          read_only_reason: "peer",
        },
      ],
    },
  });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect(yield* service.sessions(binding, "archived")).toMatchObject([
      {
        sessionId: "peer",
        readOnlyReason: "peer",
        canSendMessages: false,
        canSendActions: false,
        archived: true,
      },
    ]);
    yield* service.sessions(binding);
    expect(f.calls.map((call) => call.params)).toEqual([
      { include_peer_sidechats: true, view: "archived" },
      { include_peer_sidechats: true },
    ]);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "uses native rename acknowledgement and reversible archive bodies with the write flag",
  () => {
    const f = fixture({
      "session.rename": { updated: true, title: "Normalized title" },
      "session.archive": {},
      "session.unarchive": {},
    });
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentFeatureService;
      expect(yield* service.renameSession(binding, "side-one", " Requested title ")).toEqual({
        title: "Normalized title",
      });
      yield* service.setSessionArchived(binding, "side-one", true);
      yield* service.setSessionArchived(binding, "side-one", false);
      expect(f.calls.map((call) => [call.method, call.params, call.write])).toEqual([
        ["session.rename", { session_id: "side-one", title: "Requested title" }, true],
        ["session.archive", { method: "/api/session/archive", session_id: "side-one" }, true],
        ["session.unarchive", { method: "/api/session/unarchive", session_id: "side-one" }, true],
      ]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("does not report a refused native rename as successful", () => {
  const f = fixture({ "session.rename": { updated: false, title: "Old" } });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect((yield* Effect.flip(service.renameSession(binding, "side-one", "New"))).code).toBe(
      "refused",
    );
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "deletes tasks with the evidenced job ID without inventing a response acknowledgement",
  () => {
    const f = fixture({ "tasks.delete": null });
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentFeatureService;
      expect(yield* service.deleteTask(binding, "routine")).toBeUndefined();
      expect(f.calls[0]).toEqual({
        binding,
        method: "tasks.delete",
        params: { job_id: "routine" },
        write: true,
      });
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("reads computer tasks and marks legacy activity threads read-only", () => {
  const f = fixture({
    "computer.context": {
      tasks: [
        {
          browser_task_id: "computer-one",
          session_id: "session-one",
          title: "Research",
          status: "running",
          display_status: "Reading",
          preview_available: true,
          queue_position: 1,
          control_owner: "agent",
          owner_kind: "cron",
          latest_screenshot: { url: "https://private.invalid/?token=synthetic" },
        },
        { activity_thread_id: "legacy", name: "Past activity" },
      ],
    },
  });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    const status = yield* service.computerStatus(binding);
    expect(isComputerStatus(status)).toBe(true);
    expect(status).toMatchObject({
      available: true,
      tasks: [
        {
          taskId: "computer-one",
          sessionId: "session-one",
          readOnly: false,
          controlOwner: "agent",
          ownerKind: "cron",
          previewAvailable: true,
        },
        { taskId: "legacy", readOnly: true, previewAvailable: false },
      ],
    });
    expect(JSON.stringify(status)).not.toContain("synthetic");
    expect(f.calls[0]?.method).toBe("computer.context");
  }).pipe(Effect.provide(f.layer));
});

it.effect("fails malformed responses instead of returning fake empty feature lists", () => {
  const f = fixture({
    "skills.list": {},
    "tasks.list": { schedules: [{ id: "task" }] },
    "connectors.list": { connectors: "bad" },
    "memory.search": { hits: [{ summary: "No ID" }] },
    "sessions.list": { sessions: [{ session_id: "only" }] },
    "computer.context": { tasks: [{ browser_task_id: "task", title: "Missing session" }] },
  });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    const operations = [
      service.skills(binding).pipe(Effect.asVoid),
      service.tasks(binding).pipe(Effect.asVoid),
      service.connectors(binding).pipe(Effect.asVoid),
      service.searchMemory(binding, "query").pipe(Effect.asVoid),
      service.sessions(binding).pipe(Effect.asVoid),
      service.computerStatus(binding).pipe(Effect.asVoid),
    ];
    for (const operation of operations) {
      const error = yield* Effect.flip(operation);
      expect(error.code).toBe("invalid_response");
      expect(error.message).toBe("Muse returned an unsupported feature response.");
    }
  }).pipe(Effect.provide(f.layer));
});

it.effect("rejects invalid inputs before any cloud request", () => {
  const f = fixture({});
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    for (const operation of [
      service.searchMemory(binding, " "),
      service.searchMemory(binding, "a".repeat(8193)),
      service.readMemory(binding, ""),
      service.taskRuns(binding, ""),
      service.deleteTask(binding, "\n"),
      service.renameSession(binding, "session", " "),
      service.skills("invalid-binding"),
    ]) {
      expect((yield* Effect.flip(operation)).code).toBe("invalid_request");
    }
    expect(f.calls).toEqual([]);
    expect(f.connectCalls).toBe(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("rechecks account identity for every call and refuses stale reads and writes", () => {
  const f = fixture({ "tasks.list": { schedules: [] } });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    yield* service.tasks(binding);
    f.changeAccount();
    for (const operation of [
      service.tasks(binding),
      service.inventory(binding),
      service.deleteTask(binding, "routine"),
    ]) {
      expect((yield* Effect.flip(operation)).code).toBe("account_changed");
    }
    expect(f.calls).toHaveLength(1);
    expect(f.connectCalls).toBe(4);
  }).pipe(Effect.provide(f.layer));
});

it.effect.each([
  "method_not_found",
  "unknown_method",
  "unsupported_method",
  "not_implemented",
  "computer_disabled",
])("maps native $0 to unavailable and removes raw causes", (code) => {
  const f = fixture({});
  f.fail(
    new Transport.MuseAgentTransportError({
      kind: "disconnected",
      cause: { code, message: "private-token synthetic" },
    }),
  );
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    const error = yield* Effect.flip(service.computerStatus(binding));
    expect(error.code).toBe("unavailable");
    expect(JSON.stringify(error)).not.toMatch(/private-token|synthetic|cause/);
    expect(error.message).not.toMatch(/private-token|synthetic/);
  }).pipe(Effect.provide(f.layer));
});

it.effect.each([
  ["account_changed", "account_changed"],
  ["uncertain", "write_uncertain"],
  ["protocol", "invalid_response"],
  ["disconnected", "connection_unavailable"],
  ["unavailable", "connection_unavailable"],
] as const)("maps transport $0 to sanitized $1 without retries", ([kind, code]) => {
  const f = fixture({});
  f.fail(
    new Transport.MuseAgentTransportError({ kind, cause: new Error("private-token synthetic") }),
  );
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    const error = yield* Effect.flip(service.deleteTask(binding, "routine"));
    expect(error.code).toBe(code);
    expect(JSON.stringify(error)).not.toContain("private-token");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.write).toBe(true);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "preserves authoritative account changes even when the native cause has an unavailable code",
  () => {
    const f = fixture({});
    f.fail(
      new Transport.MuseAgentTransportError({
        kind: "account_changed",
        cause: { code: "unsupported_method" },
      }),
    );
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentFeatureService;
      expect((yield* Effect.flip(service.skills(binding))).code).toBe("account_changed");
    }).pipe(Effect.provide(f.layer));
  },
);

const revision = (content: string) =>
  NodeCrypto.createHash("sha256").update(content, "utf8").digest("hex");
const chunk = (content: string, eof = true) => ({
  data_base64: Buffer.from(content, "utf8").toString("base64"),
  len: Buffer.byteLength(content, "utf8"),
  eof,
});
const nativeThemes = {
  selected_theme_id: "violet",
  order: ["violet"],
  options: {
    violet: {
      userText: { light: "#111111", dark: "#eeeeee" },
      userBubble: { light: "#bbbbbb", dark: "#333333" },
      botText: { light: "#222222", dark: "#dddddd" },
      botBubble: { light: "#cccccc", dark: "#444444" },
      background: { light: "#ffffff", dark: "#000000" },
    },
  },
};

it.effect.each(["identity", "soul", "memory"] as const)(
  "reads the whitelisted $0 document with its content revision",
  (document) => {
    const f = fixture({ "fs.read": chunk("# Native document\n") });
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentFeatureService;
      expect(yield* service.readProfileDocument(binding, document)).toEqual({
        document,
        content: "# Native document\n",
        revision: revision("# Native document\n"),
      });
      expect(f.calls).toEqual([
        {
          binding,
          method: "fs.read",
          params: { path: document.toUpperCase() + ".md", offset: 0, len: 1048576 },
          write: false,
        },
      ]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("decodes UTF-8 across native read chunks and advances by bytes", () => {
  const encoded = Buffer.from("A🐒B");
  const chunks = [
    { data_base64: encoded.subarray(0, 3).toString("base64"), len: 3, eof: false },
    { data_base64: encoded.subarray(3).toString("base64"), len: 3, eof: true },
  ];
  const f = fixture({}, () => Effect.succeed(chunks.shift()));
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect((yield* service.readProfileDocument(binding, "memory")).content).toBe("A🐒B");
    expect(f.calls.map((call) => call.params.offset)).toEqual([0, 3]);
    expect(f.calls[1]?.params.len).toBe(1048574);
  }).pipe(Effect.provide(f.layer));
});

it.effect.each([
  { data_base64: "", len: 0, eof: false },
  { data_base64: "!!!!", len: 0, eof: true },
  { data_base64: "YQ==", len: 2, eof: true },
  { data_base64: "/w==", len: 1, eof: true },
])("rejects malformed, stalled or non-UTF8 native document reads: $0", (native) => {
  const f = fixture({ "fs.read": native });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect((yield* Effect.flip(service.readProfileDocument(binding, "identity"))).code).toBe(
      "invalid_response",
    );
    expect(f.calls).toHaveLength(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect("rejects document content beyond the byte ceiling", () => {
  const chunks = [chunk("a".repeat(1048576), false), chunk("b")];
  const f = fixture({}, () => Effect.succeed(chunks.shift()));
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect((yield* Effect.flip(service.readProfileDocument(binding, "memory"))).code).toBe(
      "invalid_response",
    );
    expect(f.calls[1]?.params).toEqual({ path: "MEMORY.md", offset: 1048576, len: 1 });
  }).pipe(Effect.provide(f.layer));
});

it.effect("refuses arbitrary document names before native dispatch", () => {
  const f = fixture({});
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    // Cross-wire input still reaches this boundary as unknown despite the public TypeScript union.
    const read = service.readProfileDocument as (
      account: string,
      document: string,
    ) => ReturnType<typeof service.readProfileDocument>;
    expect((yield* Effect.flip(read(binding, "../../credentials.json"))).code).toBe(
      "invalid_request",
    );
    expect((yield* Effect.flip(read(binding, "constructor"))).code).toBe("invalid_request");
    expect(f.calls).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("saves explicit UTF8 text once after verifying the current revision", () => {
  const f = fixture({ "fs.read": chunk("original"), "fs.write": null });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect(
      yield* service.saveProfileDocument(binding, "soul", "updated 🐒", revision("original")),
    ).toEqual({
      document: "soul",
      content: "updated 🐒",
      revision: revision("updated 🐒"),
    });
    expect(f.calls[1]).toEqual({
      binding,
      method: "fs.write",
      params: {
        path: "SOUL.md",
        text: "updated 🐒",
        overwrite: true,
        append: false,
        create_parent: false,
      },
      write: true,
    });
  }).pipe(Effect.provide(f.layer));
});

it.effect("refuses stale revisions and oversized or invalid UTF8 save input before writing", () => {
  const f = fixture({ "fs.read": chunk("changed") });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect(
      (yield* Effect.flip(
        service.saveProfileDocument(binding, "memory", "edited", revision("original")),
      )).code,
    ).toBe("conflict");
    const reads = f.calls.length;
    expect(
      (yield* Effect.flip(
        service.saveProfileDocument(binding, "memory", "🐒".repeat(300000), revision("changed")),
      )).code,
    ).toBe("invalid_request");
    expect(
      (yield* Effect.flip(
        service.saveProfileDocument(binding, "memory", "\ud800", revision("changed")),
      )).code,
    ).toBe("invalid_request");
    expect(
      (yield* Effect.flip(service.saveProfileDocument(binding, "memory", "edit", "invalid"))).code,
    ).toBe("invalid_request");
    expect(f.calls).toHaveLength(reads);
    expect(f.calls.every((call) => !call.write)).toBe(true);
  }).pipe(Effect.provide(f.layer));
});

it.effect("never retries an uncertain native document save", () => {
  const f = fixture({}, (method) =>
    method === "fs.write"
      ? Effect.fail(new Transport.MuseAgentTransportError({ kind: "uncertain" }))
      : Effect.succeed(chunk("original")),
  );
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect(
      (yield* Effect.flip(
        service.saveProfileDocument(binding, "identity", "updated", revision("original")),
      )).code,
    ).toBe("write_uncertain");
    expect(f.calls.filter((call) => call.write)).toHaveLength(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect("fences account changes between document revision read and save dispatch", () => {
  const f = fixture({}, () =>
    Effect.sync(() => {
      f.changeAccount();
      return chunk("original");
    }),
  );
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect(
      (yield* Effect.flip(
        service.saveProfileDocument(binding, "soul", "updated", revision("original")),
      )).code,
    ).toBe("account_changed");
    expect(f.calls.filter((call) => call.write)).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "serializes simultaneous T3 saves so a stale second edit cannot overwrite the first",
  () => {
    let content = "original";
    const f = fixture({}, (method, params) =>
      Effect.gen(function* () {
        yield* Effect.yieldNow;
        if (method === "fs.write") {
          content = String(params.text);
          return null;
        }
        return chunk(content);
      }),
    );
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentFeatureService;
      const results = yield* Effect.all(
        [
          Effect.result(
            service.saveProfileDocument(binding, "identity", "one", revision("original")),
          ),
          Effect.result(
            service.saveProfileDocument(binding, "identity", "two", revision("original")),
          ),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(results.filter((result) => result._tag === "Failure")).toHaveLength(1);
      expect(f.calls.filter((call) => call.write)).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("maps validated native themes into light and dark agent palettes", () => {
  const f = fixture({ "chat.themes": nativeThemes });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect(yield* service.themes(binding)).toEqual({
      selectedThemeId: "violet",
      order: ["violet"],
      options: {
        violet: {
          light: {
            userText: "#111111",
            userBubble: "#bbbbbb",
            agentText: "#222222",
            agentBubble: "#cccccc",
            background: "#ffffff",
          },
          dark: {
            userText: "#eeeeee",
            userBubble: "#333333",
            agentText: "#dddddd",
            agentBubble: "#444444",
            background: "#000000",
          },
        },
      },
    });
    expect(f.calls[0]).toMatchObject({ method: "chat.themes", params: {}, write: false });
  }).pipe(Effect.provide(f.layer));
});

it.effect.each([
  { ...nativeThemes, selected_theme_id: "missing" },
  { ...nativeThemes, order: ["missing"] },
  { ...nativeThemes, order: ["violet", "violet"] },
  {
    ...nativeThemes,
    options: { violet: { ...nativeThemes.options.violet, botText: { light: 42, dark: "#fff" } } },
  },
])("rejects inconsistent or malformed theme catalogs: $0", (native) => {
  const f = fixture({ "chat.themes": native });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect((yield* Effect.flip(service.themes(binding))).code).toBe("invalid_response");
  }).pipe(Effect.provide(f.layer));
});

it.effect("accepts an empty native default theme catalog with no selection", () => {
  const f = fixture({ "chat.themes": { selected_theme_id: null, order: [], options: {} } });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect(yield* service.themes(binding)).toEqual({
      selectedThemeId: null,
      order: [],
      options: {},
    });
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "checks the current native catalog before setting one theme, refusing inherited and absent IDs",
  () => {
    const f = fixture({ "chat.themes": nativeThemes, "chat.themes.set": {} });
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentFeatureService;
      yield* service.setTheme(binding, "violet");
      expect((yield* Effect.flip(service.setTheme(binding, "constructor"))).code).toBe(
        "invalid_request",
      );
      expect((yield* Effect.flip(service.setTheme(binding, "missing"))).code).toBe(
        "invalid_request",
      );
      expect(f.calls.filter((call) => call.write)).toEqual([
        {
          binding,
          method: "chat.themes.set",
          params: { theme_id: "violet" },
          write: true,
        },
      ]);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("never retries an ambiguous theme write", () => {
  const f = fixture({}, (method) =>
    method === "chat.themes.set"
      ? Effect.fail(new Transport.MuseAgentTransportError({ kind: "uncertain" }))
      : Effect.succeed(nativeThemes),
  );
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect((yield* Effect.flip(service.setTheme(binding, "violet"))).code).toBe("write_uncertain");
    expect(f.calls.filter((call) => call.write)).toHaveLength(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect("preserves the native UTF8 byte order mark in document content and revision", () => {
  const content = "\ufeff# Identity";
  const f = fixture({ "fs.read": chunk(content) });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect(yield* service.readProfileDocument(binding, "identity")).toEqual({
      document: "identity",
      content,
      revision: revision(content),
    });
  }).pipe(Effect.provide(f.layer));
});

it.effect("bounds a native reader that repeatedly returns tiny incomplete chunks", () => {
  const f = fixture({ "fs.read": chunk("a", false) });
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect((yield* Effect.flip(service.readProfileDocument(binding, "identity"))).code).toBe(
      "invalid_response",
    );
    expect(f.calls).toHaveLength(256);
  }).pipe(Effect.provide(f.layer));
});

it.effect("fences account changes between the theme catalog and mutation", () => {
  const f = fixture({}, () =>
    Effect.sync(() => {
      f.changeAccount();
      return nativeThemes;
    }),
  );
  return Effect.gen(function* () {
    const service = yield* Service.MuseAgentFeatureService;
    expect((yield* Effect.flip(service.setTheme(binding, "violet"))).code).toBe("account_changed");
    expect(f.calls.filter((call) => call.write)).toHaveLength(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect.each([
  ["status", 403, "refused"],
  ["status", 501, "unavailable"],
  ["httpStatus", 403, "refused"],
  ["httpStatus", 501, "unavailable"],
] as const)(
  "classifies native $0=$1 for both reads and uncertain writes",
  ([field, status, expected]) => {
    const f = fixture({});
    return Effect.gen(function* () {
      const service = yield* Service.MuseAgentFeatureService;
      f.fail(
        new Transport.MuseAgentTransportError({
          kind: "disconnected",
          cause: { [field]: status, message: "private-token" },
        }),
      );
      const read = yield* Effect.flip(service.computerStatus(binding));
      expect(read.code).toBe(expected);
      f.fail(
        new Transport.MuseAgentTransportError({
          kind: "uncertain",
          cause: { [field]: status, message: "private-token" },
        }),
      );
      const write = yield* Effect.flip(service.deleteTask(binding, "routine"));
      expect(write.code).toBe(expected);
      expect(JSON.stringify([read, write])).not.toContain("private-token");
      expect(f.calls).toHaveLength(2);
    }).pipe(Effect.provide(f.layer));
  },
);
