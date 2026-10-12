// This CLI boundary uses Node flags for private, bounded, no-follow file reads.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { callAcpMcpTool } from "./AcpMcpStdioBridge.ts";

const MAX_ARGUMENT_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const usage =
  "Usage: t3 mcp-call <tool> --endpoint <url> --token-file <private-file> --arguments-file <file|-> [--timeout-ms <1..300000>]";

class InputError extends Error {}

const argumentsSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeArguments = Schema.decodeUnknownSync(Schema.fromJsonString(argumentsSchema));

/** The shell client has no retry policy: callers retain existing tool retry keys. */
export interface McpShellCliOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: { write(chunk: string): unknown };
  readonly errorOutput?: { write(chunk: string): unknown };
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

const parseInput = (args: ReadonlyArray<string>) => {
  const [tool, ...flags] = args;
  if (tool === undefined || !/^[a-z][a-z0-9_]*$/.test(tool)) throw new InputError(usage);
  const values = new Map<string, string>();
  const allowed = new Set(["--endpoint", "--token-file", "--arguments-file", "--timeout-ms"]);
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (flag === undefined || !allowed.has(flag) || values.has(flag) || value === undefined)
      throw new InputError(usage);
    values.set(flag, value);
  }
  const endpoint = values.get("--endpoint");
  const tokenFile = values.get("--token-file");
  const argumentsFile = values.get("--arguments-file");
  if (!endpoint || !tokenFile || !argumentsFile) throw new InputError(usage);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new InputError("The MCP endpoint must be a valid URL.");
  }
  const loopback = url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new InputError(
      "Use an HTTPS endpoint or HTTP loopback, without URL credentials, query, or fragment.",
    );
  const rawTimeout = values.get("--timeout-ms");
  const timeoutMs = rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : Number(rawTimeout);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new InputError("timeout-ms must be an integer between 1 and 300000.");
  return { tool, endpoint: url.href, tokenFile, argumentsFile, timeoutMs };
};

const readFile = async (path: string, maxBytes: number, privateToken: boolean) => {
  try {
    // The handle is checked after opening so replacement cannot bypass the checks.
    if (NodeFS.constants.O_NOFOLLOW === undefined && (await NodeFSP.lstat(path)).isSymbolicLink())
      throw new InputError("Input files must not be symbolic links.");
    const handle = await NodeFSP.open(
      path,
      NodeFS.constants.O_RDONLY |
        (NodeFS.constants.O_NOFOLLOW ?? 0) |
        (NodeFS.constants.O_NONBLOCK ?? 0),
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes)
        throw new InputError("Input file is not a bounded regular file.");
      if (
        privateToken &&
        // oxlint-disable-next-line t3code/no-global-process-runtime -- This CLI boundary checks native file permissions before starting the Effect transport.
        NodeOS.platform() !== "win32" &&
        ((info.mode & 0o777) !== 0o600 || info.uid !== process.geteuid?.())
      )
        throw new InputError("The token file must be owned by the current user with mode 0600.");
      const buffer = Buffer.alloc(maxBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > maxBytes) throw new InputError("Input file exceeds the size limit.");
      return buffer.subarray(0, offset).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("Unable to read a regular input file; symbolic links are refused.");
  }
};

const readStdin = (input: NodeJS.ReadableStream, signal: AbortSignal): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    let bytes = 0;
    const cleanup = () => {
      input.pause();
      input.off("data", data);
      input.off("end", end);
      input.off("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const failed = () => {
      cleanup();
      reject(new InputError("Unable to read arguments from stdin."));
    };
    const aborted = () => {
      cleanup();
      reject(new InputError("Timed out reading arguments from stdin."));
    };
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_ARGUMENT_BYTES) {
        cleanup();
        reject(new InputError("Arguments exceed the 1 MiB size limit."));
      } else chunks.push(buffer);
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    input.on("data", data);
    input.once("end", end);
    input.once("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });

/** Run one existing tool with a private bearer token; errors never print causes or input. */
export async function runMcpShellCli(
  args: ReadonlyArray<string>,
  options: McpShellCliOptions = {},
): Promise<0 | 1 | 2> {
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    output.write(`${usage}\n`);
    return 0;
  }
  let config: ReturnType<typeof parseInput>;
  let token: string;
  let parameters: Schema.Schema.Type<typeof argumentsSchema>;
  let signal: AbortSignal;
  try {
    config = parseInput(args);
    signal = AbortSignal.timeout(config.timeoutMs);
    token = (await readFile(config.tokenFile, 8192, true)).replace(/\r?\n$/, "");
    if (!/^[\x21-\x7e]+$/.test(token))
      throw new InputError("The token file must contain one bare bearer token without whitespace.");
    const json =
      config.argumentsFile === "-"
        ? await readStdin(options.input ?? process.stdin, signal)
        : await readFile(config.argumentsFile, MAX_ARGUMENT_BYTES, false);
    try {
      parameters = decodeArguments(json);
    } catch {
      throw new InputError("Arguments must be a JSON object.");
    }
  } catch (error) {
    errorOutput.write(
      `${error instanceof InputError ? error.message : "Invalid MCP call configuration."}\n`,
    );
    return 2;
  }
  try {
    const fetchImplementation = options.fetchImplementation ?? fetch;
    const result = await Effect.runPromise(
      callAcpMcpTool({
        endpoint: config.endpoint,
        authorization: `Bearer ${token}`,
        tool: config.tool,
        arguments: parameters,
        signal,
        redirect: "error",
        terminateSession: true,
        fetchImplementation: async (url, init) => {
          const response = await fetchImplementation(url, init);
          if (response.body === null) return response;
          let bytes = 0;
          const bounded = response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                bytes += chunk.byteLength;
                if (bytes > MAX_RESPONSE_BYTES) throw new Error("MCP response exceeds size limit.");
                controller.enqueue(chunk);
              },
            }),
          );
          return new Response(bounded, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        },
      }),
    );
    output.write(`${JSON.stringify(result)}\n`);
    if (
      typeof result === "object" &&
      result !== null &&
      "isError" in result &&
      result.isError === true
    ) {
      errorOutput.write("The MCP tool returned an error.\n");
      return 1;
    }
    return 0;
  } catch {
    errorOutput.write(
      signal.aborted
        ? "The MCP call timed out; its outcome may be unknown.\n"
        : "The MCP call failed; its outcome may be unknown.\n",
    );
    return 1;
  }
}
