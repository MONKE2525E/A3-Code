// @effect-diagnostics-next-line nodeBuiltinImport:off -- The browser callback boundary needs a synchronous SHA-256 binding.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Executable discovery runs inside the Playwright Promise acquisition boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Profile paths are constructed inside the browser acquisition boundary.
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import * as SessionSource from "./MuseAgentSessionSource.ts";
import { museAgentBrowserBridge } from "./MuseAgentBrowserBridge.ts";
import { exposeMuseComputerStreamFactory } from "./MuseAgentComputerStreamBootstrap.ts";
import { MuseAgentComputerStreamMailbox } from "./MuseAgentComputerStreamMailbox.ts";
import type { MuseAgentReceipt } from "./MuseAgentDeliveryStore.ts";
import {
  MUSE_AGENT_AVATAR_MAX_BYTES,
  MuseAgentAvatarMime,
  MuseAgentAvatarPath,
} from "./MuseAgentAvatar.ts";

export class MuseAgentTransportError extends Schema.TaggedError<MuseAgentTransportError>()(
  "MuseAgentTransportError",
  {
    kind: Schema.Literals([
      "unavailable",
      "account_changed",
      "disconnected",
      "protocol",
      "uncertain",
    ]),
    stage: Schema.optional(
      Schema.Literals([
        "session",
        "browser",
        "cookies",
        "bridge",
        "navigate",
        "ready",
        "authority",
        "request",
        "watch",
        "register",
        "avatar",
        "cancel",
      ]),
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    switch (this.kind) {
      case "account_changed":
        return "The Muse account or cloud workspace changed. Set up a new provider binding.";
      case "uncertain":
        return "Muse delivery is uncertain. The message was not sent again.";
      case "protocol":
        return "Muse returned an unsupported native protocol response.";
      case "disconnected":
        return "The authenticated Muse connection is unavailable.";
      default:
        if (this.stage === "ready")
          return "Muse did not expose a ready authenticated native connection.";
        if (this.stage === "browser") return "The server could not launch its owned Muse browser.";
        if (this.stage === "cookies")
          return "The server could not import the readonly Muse session into its owned browser.";
        if (this.stage === "navigate") return "The owned browser could not load Muse.";
        return "Open Muse for Linux and sign in. A compatible headless browser is also required.";
    }
  }
}

export interface MuseAgentNativeEvent {
  readonly event: string;
  readonly payload?: unknown;
  readonly meta?: { readonly seq?: number; readonly ts_ms?: number };
}
export interface MuseAgentToolRegistration {
  readonly clientId: string;
  readonly connectionId: string;
  readonly nativeSessionId: string;
  readonly commands: Readonly<Record<string, unknown>>;
  /** Callback is the permission boundary; the page never receives T3 credentials. */
  readonly invoke: (input: {
    readonly accountBinding: string;
    readonly nativeSessionId: string;
    readonly commandId: string;
    readonly payload: unknown;
    readonly connectionId: string;
  }) => Effect.Effect<
    {
      readonly method: "client.invoke.result";
      readonly params: {
        readonly invoke_id: string;
        readonly ok: boolean;
        readonly payload_json?: string;
        readonly error?: { readonly code: string; readonly message: string };
      };
      readonly options: { readonly expectedConnectionId: string };
    },
    MuseAgentTransportError
  >;
}

export class MuseAgentTransport extends Context.Service<
  MuseAgentTransport,
  {
    readonly connect: Effect.Effect<string, MuseAgentTransportError>;
    readonly request: (
      binding: string,
      method: string,
      params: Record<string, unknown>,
      write?: boolean,
      deliveryKey?: string,
    ) => Effect.Effect<unknown, MuseAgentTransportError>;
    readonly watch: (
      binding: string,
      sessionId: string,
    ) => Effect.Effect<
      {
        readonly events: Stream.Stream<MuseAgentNativeEvent, MuseAgentTransportError>;
        readonly close: Effect.Effect<void>;
      },
      MuseAgentTransportError
    >;
    readonly connectionId: (binding: string) => Effect.Effect<string, MuseAgentTransportError>;
    readonly cancelOwned: (
      binding: string,
      receipt: MuseAgentReceipt,
    ) => Effect.Effect<void, MuseAgentTransportError>;
    readonly releaseOwned: (
      binding: string,
      input: {
        readonly sessionId: string;
        readonly deliveryKey: string;
        readonly receipt: MuseAgentReceipt | null;
      },
    ) => Effect.Effect<void, MuseAgentTransportError>;
    readonly readAvatar: (
      binding: string,
      path: string,
    ) => Effect.Effect<
      { readonly bytes: Uint8Array; readonly contentType: typeof MuseAgentAvatarMime.Type },
      MuseAgentTransportError
    >;
    readonly readComputerPreview: (
      binding: string,
      input: { readonly taskId: string; readonly sha256: string },
    ) => Effect.Effect<
      {
        readonly bytes: Uint8Array;
        readonly contentType: "image/png" | "image/jpeg" | "image/webp";
      },
      MuseAgentTransportError
    >;
    readonly openComputerStream: (
      binding: string,
      input: { readonly taskId: string; readonly sessionId: string; readonly takeoverId: string },
    ) => Effect.Effect<
      {
        readonly events: Stream.Stream<Uint8Array, MuseAgentTransportError>;
        readonly send: (data: Uint8Array) => Effect.Effect<void, MuseAgentTransportError>;
        readonly close: Effect.Effect<void>;
      },
      MuseAgentTransportError,
      Scope.Scope
    >;
    readonly registerTools: (
      binding: string,
      input: MuseAgentToolRegistration,
    ) => Effect.Effect<
      { readonly accepted: number; readonly connectionId: string },
      MuseAgentTransportError
    >;
    readonly unregisterTools: (binding: string, clientId: string) => Effect.Effect<void>;
  }
>()("t3/museAgent/MuseAgentTransport") {}

// Browser callbacks are a Promise boundary. They feed an async iterator without an Effect runtime.
class EventMailbox implements AsyncIterable<MuseAgentNativeEvent> {
  private readonly pending: MuseAgentNativeEvent[] = [];
  private waiter:
    | {
        resolve: (value: IteratorResult<MuseAgentNativeEvent>) => void;
        reject: (error: MuseAgentTransportError) => void;
      }
    | undefined;
  private ended = false;
  private failure: MuseAgentTransportError | undefined;
  offer(value: MuseAgentNativeEvent) {
    if (this.ended) return;
    if (this.pending.length >= 4096) {
      this.failure = new MuseAgentTransportError({ kind: "disconnected" });
      this.close();
      return;
    }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ done: false, value });
    } else this.pending.push(value);
  }
  close(error?: MuseAgentTransportError) {
    if (this.ended) return;
    this.ended = true;
    if (error) this.failure = error;
    if (this.failure) {
      this.pending.length = 0;
      this.waiter?.reject(this.failure);
    } else this.waiter?.resolve({ done: true, value: undefined });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<MuseAgentNativeEvent> {
    return {
      next: async () => {
        if (this.failure) throw this.failure;
        const value = this.pending.shift();
        if (value) return { done: false, value };
        if (this.ended) return { done: true, value: undefined };
        return new Promise((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

const decodeBridgeEvent = Schema.decodeUnknownSync(
  Schema.Struct({
    event: Schema.String,
    authority: Schema.String,
    payload: Schema.optionalKey(Schema.Unknown),
    meta: Schema.optionalKey(
      Schema.Struct({
        seq: Schema.optionalKey(Schema.Number),
        ts_ms: Schema.optionalKey(Schema.Number),
      }),
    ),
  }),
);
const decodeInvoke = Schema.decodeUnknownSync(
  Schema.Struct({
    authority: Schema.String,
    nativeSessionId: Schema.String,
    commandId: Schema.String,
    payload: Schema.Unknown,
    connectionId: Schema.String,
  }),
);
const decodeRegistration = Schema.decodeUnknownSync(
  Schema.Struct({ accepted: Schema.Int, connectionId: Schema.String }),
);
const decodeConnectionId = Schema.decodeUnknownSync(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
);
const ComputerStreamId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
  // eslint-disable-next-line no-control-regex -- These native IDs must remain one route segment.
  Schema.isPattern(/^[^/\\\u0000-\u001f\u007f]+$/),
);
const decodeComputerStreamInput = Schema.decodeEffect(
  Schema.Struct({
    taskId: ComputerStreamId,
    sessionId: ComputerStreamId,
    takeoverId: ComputerStreamId,
  }),
);
const decodeComputerStreamEvent = Schema.decodeUnknownSync(
  Schema.Struct({
    authority: Schema.String,
    id: Schema.String,
    connectionId: Schema.String,
    type: Schema.Literals(["data", "close"]),
    base64: Schema.optionalKey(
      Schema.String.check(
        Schema.isMaxLength(4 * Math.ceil((4 * 1024 * 1024) / 3)),
        Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
      ),
    ),
  }),
);
const isTransportError = Schema.is(MuseAgentTransportError);
const AvatarResult = Schema.Struct({
  base64: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(Math.ceil(MUSE_AGENT_AVATAR_MAX_BYTES / 3) * 4),
    Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
  ),
  contentType: MuseAgentAvatarMime,
});
const decodeAvatarPath = Schema.decodeEffect(MuseAgentAvatarPath);
const decodeAvatarResult = Schema.decodeUnknownEffect(AvatarResult);
const COMPUTER_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
const ComputerPreviewMime = Schema.Literals(["image/png", "image/jpeg", "image/webp"]);
const decodeComputerPreviewInput = Schema.decodeUnknownEffect(
  Schema.Struct({
    taskId: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(256),
      // eslint-disable-next-line no-control-regex -- Preview IDs become one native route segment.
      Schema.isPattern(/^[^/\\\u0000-\u001f\u007f]+$/),
    ),
    sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  }),
);
const decodeComputerPreviewResult = Schema.decodeUnknownEffect(
  Schema.Struct({
    base64: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4 * Math.ceil(COMPUTER_PREVIEW_MAX_BYTES / 3)),
      Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
    ),
    contentType: ComputerPreviewMime,
  }),
);
const hashAuthority = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

interface MuseAgentPageBridge {
  authority(): string | null;
  observeDisconnect(input: unknown): void;
  request(input: unknown): Promise<unknown>;
  watch(input: unknown): Promise<unknown>;
  unwatch(input?: unknown): void;
  connectionId(input: unknown): string;
  cancelOwned(input: unknown): Promise<unknown>;
  releaseOwned(input: unknown): Promise<unknown>;
  readAvatar(input: unknown): Promise<unknown>;
  register(input: unknown): Promise<unknown>;
  readComputerPreview(input: unknown): Promise<unknown>;
  openComputerStream(input: unknown): Promise<unknown>;
  sendComputerStream(input: unknown): Promise<unknown>;
  closeComputerStream(input: unknown): Promise<unknown>;
  unregister(input: unknown): Promise<unknown>;
}
type MuseAgentPageGlobal = typeof globalThis & {
  __t3Muse?: MuseAgentPageBridge;
  __t3MusePreloadComputerModule?: () => Promise<void>;
};

// Playwright invokes function arguments. An arrow passed as a string is evaluated
// as a function value instead, returning undefined without calling the bridge.
const callPageBridge = (
  page: Page,
  method: Exclude<keyof MuseAgentPageBridge, "authority">,
  input?: unknown,
) =>
  page.evaluate(
    async ({ method, input }) => {
      const native = globalThis as MuseAgentPageGlobal;
      if (method === "openComputerStream") await native.__t3MusePreloadComputerModule?.();
      return native.__t3Muse![method](input);
    },
    { method, input },
  );
const pageAuthority = (page: Page) =>
  page.evaluate(() => (globalThis as MuseAgentPageGlobal).__t3Muse?.authority() ?? null);

export const makeMuseAgentTransportLayer = (
  options: { readonly executablePath?: string; readonly profileRoot?: string } = {},
) =>
  Layer.effect(
    MuseAgentTransport,
    Effect.gen(function* () {
      const source = yield* SessionSource.MuseAgentSessionSource;
      // Playwright exposes a native Promise callback. Capture the application context
      // once for that callback boundary, without a feature-owned managed runtime.
      const callbackContext = yield* Effect.context<never>();
      let browserContext: BrowserContext | undefined;
      let ownedProfile: string | undefined;
      let page: Page | undefined;
      let fingerprint: string | undefined;
      let authority: string | undefined;
      let connecting: Promise<string> | undefined;
      let registration:
        | { binding: string; input: MuseAgentToolRegistration; active: boolean }
        | undefined;
      const mailboxes = new Set<EventMailbox>();
      const computerStreams = new Map<
        string,
        { authority: string; connectionId: string; box: MuseAgentComputerStreamMailbox }
      >();
      const watchPermit = yield* Semaphore.make(1);
      let watchedSessionId: string | undefined;
      const reset = async (error?: MuseAgentTransportError) => {
        for (const box of mailboxes) box.close(error);
        mailboxes.clear();
        for (const current of computerStreams.values()) current.box.close(error);
        computerStreams.clear();
        watchedSessionId = undefined;
        registration = undefined;
        authority = undefined;
        page = undefined;
        fingerprint = undefined;
        const ownedContext = browserContext;
        const profile = ownedProfile;
        browserContext = undefined;
        ownedProfile = undefined;
        // Closing this context stops only the Chromium process Playwright spawned.
        // Preserve the profile if shutdown fails; never remove an in-use profile.
        await ownedContext?.close();
        if (profile) await NodeFSP.rm(profile, { recursive: true, force: true });
      };
      yield* Effect.addFinalizer(() => Effect.promise(() => reset()));
      const launch = async (session: SessionSource.MuseAgentSessionSnapshot) => {
        const atStage = async <A>(
          stage: NonNullable<MuseAgentTransportError["stage"]>,
          run: () => Promise<A>,
        ): Promise<A> => {
          try {
            return await run();
          } catch (cause) {
            throw isTransportError(cause)
              ? cause
              : new MuseAgentTransportError({ kind: "unavailable", stage, cause });
          }
        };
        if (page && fingerprint === session.fingerprint) {
          const current = await pageAuthority(page);
          if (!current) throw new MuseAgentTransportError({ kind: "disconnected" });
          if (authority !== undefined && current !== authority)
            throw new MuseAgentTransportError({ kind: "account_changed" });
          authority = current;
          return hashAuthority(current);
        }
        await reset(new MuseAgentTransportError({ kind: "disconnected" }));
        const candidates = options.executablePath
          ? [options.executablePath]
          : [
              "/usr/bin/google-chrome-stable",
              "/usr/bin/google-chrome",
              "/usr/bin/chromium",
              "/usr/bin/chromium-browser",
              chromium.executablePath(),
            ];
        let executablePath: string | undefined;
        for (const candidate of candidates)
          if (
            await NodeFSP.access(candidate).then(
              () => true,
              () => false,
            )
          ) {
            executablePath = candidate;
            break;
          }
        if (!executablePath)
          throw new MuseAgentTransportError({ kind: "unavailable", stage: "browser" });
        ownedProfile = await atStage("browser", () =>
          NodeFSP.mkdtemp(NodePath.join(options.profileRoot ?? NodeOS.tmpdir(), "t3-muse-agent-")),
        );
        // Keep Meta's bootstrap in an ephemeral persistent context. Import cookies
        // readonly; Chromium never opens the user's Muse or Chrome profile.
        const context = await atStage("browser", () =>
          chromium.launchPersistentContext(ownedProfile!, { executablePath, headless: true }),
        );
        browserContext = context;
        await atStage("cookies", () => context.addCookies([...session.cookies]));
        page = await atStage("browser", () => context.newPage());
        await page.route("**/*", async (route) => {
          let handlingAttempted = false;
          try {
            const kind = route.request().resourceType();
            if (kind !== "document" && kind !== "script") {
              handlingAttempted = true;
              await route.continue();
              return;
            }
            const response = await route.fetch();
            const contentType = response.headers()["content-type"] ?? "";
            const body = /(?:javascript|html)/i.test(contentType) ? await response.body() : null;
            const patched =
              body && body.length <= 64 * 1024 * 1024
                ? exposeMuseComputerStreamFactory(body.toString("utf8"))
                : null;
            // Playwright consumes a route before awaiting fulfillment or continuation.
            // A disposal failure cannot be followed by another handling attempt.
            handlingAttempted = true;
            await route.fulfill(patched ? { response, body: patched } : { response });
          } catch {
            if (!handlingAttempted) await route.abort("failed").catch(() => {});
          }
        });
        await page.exposeFunction("__t3MuseComputerStreamEvent", (raw: unknown) => {
          const event = decodeComputerStreamEvent(raw);
          const current = computerStreams.get(event.id);
          if (
            !current ||
            event.authority !== authority ||
            current.authority !== event.authority ||
            current.connectionId !== event.connectionId
          )
            return;
          if (event.type === "close") {
            current.box.close();
            return;
          }
          if (!event.base64 || !current.box.offer(Buffer.from(event.base64, "base64")))
            throw new MuseAgentTransportError({ kind: "protocol" });
        });
        await page.exposeFunction("__t3MuseEvent", (raw: unknown) => {
          const event = decodeBridgeEvent(raw);
          if (event.authority !== authority) return;
          const { authority: _privateAuthority, ...frame } = event;
          for (const box of mailboxes) box.offer(frame);
        });
        await page.exposeFunction("__t3MuseInvoke", async (raw: unknown) => {
          const input = decodeInvoke(raw);
          if (
            input.authority !== authority ||
            !registration ||
            !registration.active ||
            registration.binding !== hashAuthority(input.authority) ||
            registration.input.nativeSessionId !== input.nativeSessionId ||
            registration.input.connectionId !== input.connectionId ||
            !Object.hasOwn(registration.input.commands, input.commandId)
          )
            throw new MuseAgentTransportError({ kind: "account_changed" });
          const response = await Effect.runPromiseWith(callbackContext)(
            registration.input.invoke({
              accountBinding: registration.binding,
              nativeSessionId: registration.input.nativeSessionId,
              commandId: input.commandId,
              payload: input.payload,
              connectionId: input.connectionId,
            }),
          );
          return response;
        });
        await atStage("bridge", () => page!.addInitScript({ content: museAgentBrowserBridge }));
        await atStage("navigate", () =>
          page!.goto("https://muse.ai/", { waitUntil: "domcontentloaded", timeout: 45000 }),
        );
        await atStage("ready", () =>
          // String predicates use eval inside the page and violate Muse's CSP.
          page!.waitForFunction(
            () => (globalThis as MuseAgentPageGlobal).__t3Muse?.authority() != null,
            undefined,
            { timeout: 30000 },
          ),
        );
        const found = await pageAuthority(page);
        if (!found) throw new MuseAgentTransportError({ kind: "unavailable", stage: "authority" });
        authority = found;
        fingerprint = session.fingerprint;
        return hashAuthority(found);
      };
      const connect = source.read.pipe(
        Effect.mapError(
          (cause) => new MuseAgentTransportError({ kind: "unavailable", stage: "session", cause }),
        ),
        Effect.flatMap((session) =>
          Effect.tryPromise({
            try: () => {
              connecting ??= launch(session)
                .catch(async (cause) => {
                  if (
                    isTransportError(cause) &&
                    cause.kind === "disconnected" &&
                    page &&
                    fingerprint === session.fingerprint &&
                    !page.isClosed?.()
                  ) {
                    // A warm native peer can briefly leave React's ready context.
                    // Keep its watcher alive for the bridge's fenced reconnect loop;
                    // no operation may use the cached authority while it is absent.
                    if (registration) registration.active = false;
                    if (mailboxes.size && authority) {
                      try {
                        await callPageBridge(page, "observeDisconnect", { authority });
                      } catch {
                        // If local recovery cannot be fenced, retire the old readers
                        // rather than leave them waiting without a recovery signal.
                        const failure = new MuseAgentTransportError({ kind: "disconnected" });
                        await reset(failure);
                        throw failure;
                      }
                    }
                  } else
                    await reset(
                      isTransportError(cause)
                        ? cause
                        : new MuseAgentTransportError({ kind: "unavailable" }),
                    );
                  throw cause;
                })
                .finally(() => {
                  connecting = undefined;
                });
              return connecting;
            },
            catch: (cause) =>
              isTransportError(cause)
                ? cause
                : new MuseAgentTransportError({ kind: "unavailable", cause }),
          }),
        ),
      );
      const verify = Effect.fnUntraced(function* (binding: string) {
        if ((yield* connect) !== binding || !page || !authority)
          return yield* new MuseAgentTransportError({ kind: "account_changed" });
        return { page, authority };
      });
      const unregisterTools = (binding: string, clientId: string) =>
        Effect.suspend(() => {
          if (registration?.binding !== binding || registration.input.clientId !== clientId)
            return Effect.void;
          const currentRegistration = registration;
          currentRegistration.active = false;
          registration = undefined;
          const currentPage = page;
          if (!currentPage) return Effect.void;
          // Local authority is revoked before native removal. A stalled cloud
          // acknowledgement must not retain a turn or prevent Stop from dispatching.
          return Effect.promise(() =>
            callPageBridge(currentPage, "unregister", {
              authority,
              clientId,
              connectionId: currentRegistration.input.connectionId,
            }).catch(() => {}),
          ).pipe(
            Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.void }),
            Effect.asVoid,
          );
        });
      return MuseAgentTransport.of({
        connect,
        request: (binding, method, params, write = false, deliveryKey) =>
          verify(binding).pipe(
            Effect.flatMap((current) =>
              Effect.tryPromise({
                try: () =>
                  callPageBridge(current.page, "request", {
                    authority: current.authority,
                    method,
                    params,
                    ...(deliveryKey ? { deliveryKey } : {}),
                  }),
                catch: (cause) =>
                  new MuseAgentTransportError({
                    kind: write ? "uncertain" : "disconnected",
                    cause,
                  }),
              }),
            ),
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () =>
                Effect.fail(
                  new MuseAgentTransportError({ kind: write ? "uncertain" : "disconnected" }),
                ),
            }),
          ),
        watch: (binding, sessionId) =>
          Effect.gen(function* () {
            const current = yield* verify(binding);
            const box = new EventMailbox();
            const close = Effect.promise(async () => {
              if (!mailboxes.has(box)) return;
              mailboxes.delete(box);
              box.close();
              if (mailboxes.size === 0) {
                watchedSessionId = undefined;
                await callPageBridge(current.page, "unwatch").catch(() => {});
              }
            }).pipe(watchPermit.withPermits(1));
            // The observer and managed turn share one native route. Each has its
            // own queue, and only the last reader removes the page subscription.
            yield* watchPermit
              .withPermits(1)(
                Effect.gen(function* () {
                  if (mailboxes.size && watchedSessionId !== sessionId)
                    return yield* new MuseAgentTransportError({ kind: "protocol" });
                  const subscribe = mailboxes.size === 0;
                  watchedSessionId = sessionId;
                  mailboxes.add(box);
                  if (subscribe)
                    yield* Effect.tryPromise({
                      try: () =>
                        callPageBridge(current.page, "watch", {
                          authority: current.authority,
                          session: sessionId,
                        }),
                      catch: (cause) => new MuseAgentTransportError({ kind: "protocol", cause }),
                    });
                }),
              )
              .pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? close : Effect.void)));
            return {
              events: Stream.fromAsyncIterable(box, (cause) =>
                isTransportError(cause)
                  ? cause
                  : new MuseAgentTransportError({ kind: "disconnected", cause }),
              ),
              close,
            };
          }),
        connectionId: (binding) =>
          verify(binding).pipe(
            Effect.flatMap((current) =>
              Effect.tryPromise({
                try: async () =>
                  decodeConnectionId(
                    await callPageBridge(current.page, "connectionId", {
                      authority: current.authority,
                    }),
                  ),
                catch: (cause) => new MuseAgentTransportError({ kind: "disconnected", cause }),
              }),
            ),
          ),
        cancelOwned: (binding, receipt) =>
          verify(binding).pipe(
            Effect.flatMap((current) =>
              Effect.tryPromise({
                try: async () => {
                  await callPageBridge(current.page, "cancelOwned", {
                    authority: current.authority,
                    receipt,
                  });
                },
                catch: (cause) => new MuseAgentTransportError({ kind: "uncertain", cause }),
              }),
            ),
          ),
        releaseOwned: (binding, input) =>
          verify(binding).pipe(
            Effect.flatMap((current) =>
              Effect.tryPromise({
                try: async () => {
                  await callPageBridge(current.page, "releaseOwned", {
                    authority: current.authority,
                    session: input.sessionId,
                    deliveryKey: input.deliveryKey,
                    receipt: input.receipt,
                  });
                },
                catch: (cause) => new MuseAgentTransportError({ kind: "uncertain", cause }),
              }),
            ),
          ),
        readAvatar: (binding, path) =>
          Effect.gen(function* () {
            yield* decodeAvatarPath(path).pipe(
              Effect.mapError((cause) => new MuseAgentTransportError({ kind: "protocol", cause })),
            );
            const current = yield* verify(binding);
            const raw = yield* Effect.tryPromise({
              try: () =>
                callPageBridge(current.page, "readAvatar", {
                  authority: current.authority,
                  path,
                }),
              catch: (cause) => new MuseAgentTransportError({ kind: "protocol", cause }),
            });
            const result = yield* decodeAvatarResult(raw).pipe(
              Effect.mapError((cause) => new MuseAgentTransportError({ kind: "protocol", cause })),
            );
            const bytes = Buffer.from(result.base64, "base64");
            if (!bytes.length || bytes.length > MUSE_AGENT_AVATAR_MAX_BYTES)
              return yield* new MuseAgentTransportError({ kind: "protocol" });
            return { bytes, contentType: result.contentType };
          }),
        readComputerPreview: (binding, input) =>
          Effect.gen(function* () {
            const selected = yield* decodeComputerPreviewInput(input).pipe(
              Effect.mapError((cause) => new MuseAgentTransportError({ kind: "protocol", cause })),
            );
            const current = yield* verify(binding);
            const raw = yield* Effect.tryPromise({
              try: () =>
                callPageBridge(current.page, "readComputerPreview", {
                  authority: current.authority,
                  ...selected,
                }),
              catch: (cause) => new MuseAgentTransportError({ kind: "protocol", cause }),
            });
            const result = yield* decodeComputerPreviewResult(raw).pipe(
              Effect.mapError((cause) => new MuseAgentTransportError({ kind: "protocol", cause })),
            );
            const bytes = Buffer.from(result.base64, "base64");
            if (!bytes.length || bytes.length > COMPUTER_PREVIEW_MAX_BYTES)
              return yield* new MuseAgentTransportError({ kind: "protocol" });
            return { bytes, contentType: result.contentType };
          }),
        openComputerStream: (binding, input) =>
          Effect.gen(function* () {
            const selected = yield* decodeComputerStreamInput(input).pipe(
              Effect.mapError((cause) => new MuseAgentTransportError({ kind: "protocol", cause })),
            );
            const current = yield* verify(binding);
            const connectionId = decodeConnectionId(
              yield* Effect.tryPromise({
                try: () =>
                  callPageBridge(current.page, "connectionId", { authority: current.authority }),
                catch: (cause) => new MuseAgentTransportError({ kind: "disconnected", cause }),
              }),
            );
            if (computerStreams.size >= 2)
              return yield* new MuseAgentTransportError({ kind: "unavailable" });
            const id = NodeCrypto.randomUUID(),
              box = new MuseAgentComputerStreamMailbox();
            const close = Effect.suspend(() => {
              if (!computerStreams.delete(id)) return Effect.void;
              box.close();
              return Effect.promise(() =>
                callPageBridge(current.page, "closeComputerStream", {
                  authority: current.authority,
                  id,
                  connectionId,
                }).catch(() => {}),
              ).pipe(
                Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.void }),
                Effect.asVoid,
              );
            });
            yield* Effect.acquireRelease(
              Effect.sync(() =>
                computerStreams.set(id, { authority: current.authority, connectionId, box }),
              ),
              () => close,
            );
            yield* Effect.tryPromise({
              try: () =>
                callPageBridge(current.page, "openComputerStream", {
                  authority: current.authority,
                  id,
                  connectionId,
                  ...selected,
                }),
              catch: (cause) => new MuseAgentTransportError({ kind: "unavailable", cause }),
            }).pipe(
              Effect.timeoutOrElse({
                duration: "35 seconds",
                orElse: () => Effect.fail(new MuseAgentTransportError({ kind: "unavailable" })),
              }),
              Effect.onExit((exit) => (Exit.isFailure(exit) ? close : Effect.void)),
            );
            const sending = yield* Semaphore.make(1);
            const send = (data: Uint8Array) =>
              Effect.suspend(() => {
                if (!computerStreams.has(id) || !data.length || data.length > 256 * 1024)
                  return Effect.fail(new MuseAgentTransportError({ kind: "protocol" }));
                return Effect.tryPromise({
                  try: () =>
                    callPageBridge(current.page, "sendComputerStream", {
                      authority: current.authority,
                      id,
                      connectionId,
                      base64: Buffer.from(data).toString("base64"),
                    }).then(() => undefined),
                  catch: (cause) => new MuseAgentTransportError({ kind: "disconnected", cause }),
                }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? close : Effect.void)));
              }).pipe(sending.withPermits(1));
            return {
              events: Stream.fromAsyncIterable(
                box,
                (cause) => new MuseAgentTransportError({ kind: "disconnected", cause }),
              ).pipe(Stream.ensuring(close)),
              send,
              close,
            };
          }),
        registerTools: (binding, input) =>
          Effect.gen(function* () {
            const current = yield* verify(binding);
            if (registration) return yield* new MuseAgentTransportError({ kind: "protocol" });
            const currentRegistration = { binding, input, active: true };
            registration = currentRegistration;
            return yield* Effect.tryPromise({
              try: async () =>
                decodeRegistration(
                  await callPageBridge(current.page, "register", {
                    authority: current.authority,
                    clientId: input.clientId,
                    nativeSessionId: input.nativeSessionId,
                    connectionId: input.connectionId,
                    commands: input.commands,
                  }),
                ),
              catch: (cause) => new MuseAgentTransportError({ kind: "protocol", cause }),
            }).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) && registration === currentRegistration
                  ? // Registration can install handlers before response decoding fails.
                    unregisterTools(binding, input.clientId)
                  : Effect.void,
              ),
            );
          }),
        unregisterTools,
      });
    }),
  );

export const layer = makeMuseAgentTransportLayer();
