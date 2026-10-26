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
import * as Option from "effect/Option";
import * as IntegrationBrowser from "../preview/IntegrationBrowser.ts";
import * as CredentialInbox from "./MuseAgentCredentialInbox.ts";
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
        return "Sign in to Muse in Settings → Providers. A compatible browser is required on the server.";
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
      /** Runs after account verification, immediately before the page bridge is invoked. */
      onDispatch?: () => void,
    ) => Effect.Effect<unknown, MuseAgentTransportError>;
    readonly acquireTurn: (
      binding: string,
      sessionId: string,
    ) => Effect.Effect<Effect.Effect<void>, MuseAgentTransportError>;
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
  /** Hands the page's subscription to another session: one last frame, then a clean end. */
  supersede() {
    this.offer({ event: "transport.session_superseded" });
    this.close();
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

// Playwright serializes thrown Errors without native code/status properties. Return
// only the bounded fields feature services classify, never native error text or payloads.
const requestPageBridge = (page: Page, input: unknown) =>
  page
    .evaluate(async (input) => {
      try {
        return {
          ok: true as const,
          value: await (globalThis as MuseAgentPageGlobal).__t3Muse!.request(input),
        };
      } catch (cause) {
        const code =
          typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
        const httpStatus =
          typeof cause === "object" && cause !== null && "httpStatus" in cause
            ? cause.httpStatus
            : undefined;
        const status =
          typeof cause === "object" && cause !== null && "status" in cause
            ? cause.status
            : undefined;
        return {
          ok: false as const,
          error: {
            ...(typeof cause === "object" &&
            cause !== null &&
            "kind" in cause &&
            cause.kind === "jarvis_rejection" &&
            "message" in cause &&
            cause.message === "matched route missing from endpoint ACL"
              ? { missingEndpointAcl: true as const }
              : {}),
            ...(typeof code === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(code) ? { code } : {}),
            ...(typeof httpStatus === "number" &&
            Number.isInteger(httpStatus) &&
            httpStatus >= 100 &&
            httpStatus <= 599
              ? { httpStatus }
              : {}),
            ...(typeof status === "number" &&
            Number.isInteger(status) &&
            status >= 100 &&
            status <= 599
              ? { status }
              : {}),
          },
        };
      }
    }, input)
    .then((result) => {
      if (!result.ok) throw result.error;
      return result.value;
    });

export const makeMuseAgentTransportLayer = (
  options: { readonly executablePath?: string; readonly profileRoot?: string } = {},
) =>
  Layer.effect(
    MuseAgentTransport,
    Effect.gen(function* () {
      const source = yield* SessionSource.MuseAgentSessionSource;
      const integrationBrowser = yield* Effect.serviceOption(IntegrationBrowser.IntegrationBrowser);
      const credentialInbox = yield* Effect.serviceOption(CredentialInbox.MuseAgentCredentialInbox);
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
      let turnReservation:
        | {
            readonly binding: string;
            readonly sessionId: string;
            readonly released: Promise<void>;
            readonly release: () => void;
          }
        | undefined;
      const releaseTurn = () => {
        const current = turnReservation;
        turnReservation = undefined;
        current?.release();
      };
      const reset = async (error?: MuseAgentTransportError) => {
        for (const box of mailboxes) box.close(error);
        mailboxes.clear();
        for (const current of computerStreams.values()) current.box.close(error);
        computerStreams.clear();
        watchedSessionId = undefined;
        registration = undefined;
        releaseTurn();
        authority = undefined;
        const ownedPage = page;
        page = undefined;
        fingerprint = undefined;
        const ownedContext = browserContext;
        const profile = ownedProfile;
        browserContext = undefined;
        ownedProfile = undefined;
        // Closing this context stops only the Chromium process Playwright spawned.
        // Preserve the profile if shutdown fails; never remove an in-use profile.
        await ownedContext?.close();
        if (!ownedContext) await ownedPage?.close().catch(() => {});
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
        if (!executablePath && session.source !== "t3-browser")
          throw new MuseAgentTransportError({ kind: "unavailable", stage: "browser" });
        if (session.source === "t3-browser" && Option.isSome(integrationBrowser)) {
          page = await atStage("browser", () =>
            Effect.runPromiseWith(callbackContext)(integrationBrowser.value.museTransportPage),
          );
        } else {
          if (!executablePath)
            throw new MuseAgentTransportError({ kind: "unavailable", stage: "browser" });
          ownedProfile = await atStage("browser", () =>
            NodeFSP.mkdtemp(
              NodePath.join(options.profileRoot ?? NodeOS.tmpdir(), "t3-muse-agent-"),
            ),
          );
          // Keep Meta's bootstrap in an ephemeral persistent context. Import cookies
          // readonly; Chromium never opens the user's Muse or Chrome profile.
          const context = await atStage("browser", () =>
            chromium.launchPersistentContext(ownedProfile!, { executablePath, headless: true }),
          );
          browserContext = context;
          await atStage("cookies", () => context.addCookies([...session.cookies]));
          page = await atStage("browser", () => context.newPage());
        }
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
          if (Option.isSome(credentialInbox))
            credentialInbox.value.observe(hashAuthority(event.authority), frame);
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
      const acquireTurn = (binding: string, sessionId: string) =>
        Effect.suspend(() => {
          let acquired: Effect.Effect<void> | undefined;
          return Effect.gen(function* () {
            while (true) {
              yield* verify(binding);
              const result = yield* watchPermit.withPermits(1)(
                Effect.sync(() => {
                  if (turnReservation) return { wait: turnReservation.released };
                  const signal = Promise.withResolvers<void>();
                  const owner = {
                    binding,
                    sessionId,
                    released: signal.promise,
                    release: signal.resolve,
                  };
                  turnReservation = owner;
                  acquired = Effect.sync(() => {
                    if (turnReservation === owner) releaseTurn();
                  });
                  return { release: acquired, owner };
                }),
              );
              if ("release" in result) {
                yield* verify(binding);
                if (turnReservation !== result.owner) continue;
                return result.release;
              }
              yield* Effect.promise(() => result.wait);
            }
          }).pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) && acquired ? acquired : Effect.void)),
          );
        });
      return MuseAgentTransport.of({
        connect,
        acquireTurn,
        request: (binding, method, params, write = false, deliveryKey, onDispatch) =>
          verify(binding).pipe(
            Effect.flatMap((current) =>
              Effect.tryPromise({
                try: () => {
                  onDispatch?.();
                  return requestPageBridge(current.page, {
                    authority: current.authority,
                    method,
                    params,
                    ...(deliveryKey ? { deliveryKey } : {}),
                  });
                },
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
        watch: Effect.fn("MuseAgentTransport.watch")(function* (binding, sessionId) {
          let current = yield* verify(binding);
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
          while (true) {
            current = yield* verify(binding);
            const waiting = yield* watchPermit
              .withPermits(1)(
                Effect.gen(function* () {
                  if (
                    turnReservation &&
                    (turnReservation.binding !== binding || turnReservation.sessionId !== sessionId)
                  )
                    return { wait: turnReservation.released };
                  // A turn retains the route until its registration is removed, including
                  // reconnect recovery after native callbacks have been revoked.
                  if (registration && registration.input.nativeSessionId !== sessionId)
                    return yield* new MuseAgentTransportError({ kind: "protocol" });
                  if (watchedSessionId !== sessionId) {
                    for (const previous of mailboxes) previous.supersede();
                    mailboxes.clear();
                  }
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
                  return undefined;
                }),
              )
              .pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? close : Effect.void)));
            if (waiting === undefined) break;
            yield* Effect.promise(() => waiting.wait);
          }
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
        readAvatar: Effect.fn("MuseAgentTransport.readAvatar")(function* (binding, path) {
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
        readComputerPreview: Effect.fn("MuseAgentTransport.readComputerPreview")(
          function* (binding, input) {
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
          },
        ),
        openComputerStream: Effect.fn("MuseAgentTransport.openComputerStream")(
          function* (binding, input) {
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
          },
        ),
        registerTools: Effect.fn("MuseAgentTransport.registerTools")(function* (binding, input) {
          const current = yield* verify(binding);
          if (
            registration ||
            (turnReservation &&
              (turnReservation.binding !== binding ||
                turnReservation.sessionId !== input.nativeSessionId)) ||
            (watchedSessionId !== undefined && watchedSessionId !== input.nativeSessionId)
          )
            return yield* new MuseAgentTransportError({ kind: "protocol" });
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
            catch: (cause) =>
              new MuseAgentTransportError({
                kind:
                  cause instanceof Error &&
                  /(?:registration_scope_changed|heartbeat_scope_changed|connection_changed|disconnected)/u.test(
                    cause.message,
                  )
                    ? "disconnected"
                    : "protocol",
                stage: "register",
                cause,
              }),
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) && registration === currentRegistration
                ? // Registration can install handlers before response decoding fails.
                  unregisterTools(binding, input.clientId)
                : Effect.void,
            ),
          );
        }, watchPermit.withPermits(1)),
        unregisterTools,
      });
    }),
  );

export const layer = makeMuseAgentTransportLayer();
