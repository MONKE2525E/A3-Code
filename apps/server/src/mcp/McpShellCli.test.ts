// The CLI fixture owns temporary files and streams; no provider or server is started.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { describe, expect, it } from "@effect/vitest";

import { runMcpShellCli } from "./McpShellCli.ts";

const token = "native-token-sentinel";

async function fixture(
  test: (input: {
    directory: string;
    tokenFile: string;
    argumentsFile: string;
    args: Array<string>;
  }) => Promise<void>,
) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mcp-shell-"));
  try {
    const tokenFile = NodePath.join(directory, "token");
    const argumentsFile = NodePath.join(directory, "arguments.json");
    await NodeFSP.writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    await NodeFSP.writeFile(argumentsFile, '{"clientRequestId":"stable-key"}');
    await test({
      directory,
      tokenFile,
      argumentsFile,
      args: [
        "delegate_task",
        "--endpoint",
        "https://fixture.invalid/mcp",
        "--token-file",
        tokenFile,
        "--arguments-file",
        argumentsFile,
      ],
    });
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}

function io() {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  return {
    stdout,
    stderr,
    output: { write: (text: string) => stdout.push(text) },
    errorOutput: { write: (text: string) => stderr.push(text) },
  };
}

function transport(result: unknown, sse = false) {
  const requests: Array<Request> = [];
  return {
    requests,
    fetchImplementation: async (url: string, init?: RequestInit) => {
      const request = new Request(url, init);
      requests.push(request);
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      const body = (await request.clone().json()) as { id?: string; method: string };
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const response = {
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} }
            : result,
      };
      return new Response(
        sse ? `data: ${JSON.stringify(response)}\n\n` : JSON.stringify(response),
        {
          headers: {
            "content-type": sse ? "text/event-stream" : "application/json",
            "mcp-session-id": "fixture-session",
          },
        },
      );
    },
  };
}

describe("McpShellCli", () => {
  it.each([false, true])("uses existing transport with SSE=%s responses", async (sse) =>
    fixture(async ({ args }) => {
      const output = io();
      const http = transport({ structuredContent: { taskId: "task-1" } }, sse);
      expect(await runMcpShellCli(args, { ...output, ...http })).toBe(0);
      expect(JSON.parse(output.stdout.join(""))).toEqual({
        structuredContent: { taskId: "task-1" },
      });
      expect(http.requests).toHaveLength(4);
      expect(
        http.requests.every(
          (request) => request.headers.get("authorization") === `Bearer ${token}`,
        ),
      ).toBe(true);
      expect(http.requests.every((request) => request.redirect === "error")).toBe(true);
      expect(http.requests[2]?.headers.get("mcp-session-id")).toBe("fixture-session");
      expect(http.requests[2]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
      expect(http.requests[3]?.method).toBe("DELETE");
      expect(http.requests[3]?.headers.get("mcp-session-id")).toBe("fixture-session");
      expect(http.requests[3]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
      expect(await http.requests[2]?.json()).toMatchObject({
        method: "tools/call",
        params: { name: "delegate_task", arguments: { clientRequestId: "stable-key" } },
      });
      expect(output.stderr).toEqual([]);
    }),
  );

  it("reads bounded JSON from stdin and accepts opaque OAuth tokens", async () =>
    fixture(async ({ args, tokenFile }) => {
      await NodeFSP.writeFile(tokenFile, "opaque.jwt.signature\n");
      args[args.length - 1] = "-";
      const output = io();
      const http = transport({ structuredContent: {} });
      expect(
        await runMcpShellCli(args, {
          ...output,
          ...http,
          input: NodeStream.Readable.from(['{"limit":1}']),
        }),
      ).toBe(0);
      expect(http.requests[0]?.headers.get("authorization")).toBe("Bearer opaque.jwt.signature");
    }));

  it("returns exit 1 for a tool error while retaining the tool result", async () =>
    fixture(async ({ args }) => {
      const output = io();
      const result = {
        isError: true,
        content: [{ type: "text", text: "Caller is not authorized." }],
      };
      const http = transport(result);
      expect(await runMcpShellCli(args, { ...output, ...http })).toBe(1);
      expect(JSON.parse(output.stdout.join(""))).toEqual(result);
      expect(http.requests.at(-1)?.method).toBe("DELETE");
    }));

  it("redacts HTTP and protocol failures without retrying", async () =>
    fixture(async ({ args }) => {
      for (const status of [401, 302]) {
        const output = io();
        let requests = 0;
        expect(
          await runMcpShellCli(args, {
            ...output,
            fetchImplementation: async () => {
              requests += 1;
              return new Response(token, { status });
            },
          }),
        ).toBe(1);
        expect(requests).toBe(1);
        expect(output.stdout).toEqual([]);
        expect(output.stderr.join("")).not.toContain(token);
      }
      const output = io();
      expect(
        await runMcpShellCli(args, {
          ...output,
          fetchImplementation: async () =>
            new Response(JSON.stringify({ error: { message: token } })),
        }),
      ).toBe(1);
      expect(output.stderr.join("")).not.toContain(token);
    }));

  it("does not replay a mutation after its response is lost", async () =>
    fixture(async ({ args }) => {
      const output = io();
      const http = transport({});
      let calls = 0;
      expect(
        await runMcpShellCli(args, {
          ...output,
          fetchImplementation: async (url, init) => {
            if (init?.method === "DELETE") return http.fetchImplementation(url, init);
            const body = JSON.parse(String(init?.body)) as { method: string };
            if (body.method === "tools/call") {
              calls += 1;
              throw new Error(token);
            }
            return http.fetchImplementation(url, init);
          },
        }),
      ).toBe(1);
      expect(calls).toBe(1);
      expect(output.stderr.join("")).not.toContain(token);
    }));

  it.each(["protocol", "lost-response", "timeout"])(
    "closes a negotiated session after %s failure without retrying",
    async (failure) =>
      fixture(async ({ args }) => {
        const output = io();
        const http = transport({});
        const methods: Array<string> = [];
        let calls = 0;
        expect(
          await runMcpShellCli([...args, "--timeout-ms", "50"], {
            ...output,
            fetchImplementation: async (url, init) => {
              methods.push(init?.method ?? "");
              if (init?.method === "DELETE") {
                expect(init.signal?.aborted).toBe(false);
                return http.fetchImplementation(url, init);
              }
              const body = JSON.parse(String(init?.body)) as { id: string; method: string };
              if (body.method !== "tools/call") return http.fetchImplementation(url, init);
              calls += 1;
              if (failure === "protocol")
                return new Response(JSON.stringify({ id: body.id, error: { message: token } }));
              if (failure === "lost-response") throw new Error(token);
              return new Promise((_resolve, reject) => {
                if (init?.signal?.aborted) reject(new Error(token));
                else
                  init?.signal?.addEventListener("abort", () => reject(new Error(token)), {
                    once: true,
                  });
              });
            },
          }),
        ).toBe(1);
        expect(methods.at(-1)).toBe("DELETE");
        expect(calls).toBe(1);
        expect(output.stderr.join("")).not.toContain(token);
      }),
  );

  it("keeps a successful result when session cleanup fails", async () =>
    fixture(async ({ args }) => {
      const output = io();
      const http = transport({ structuredContent: { accepted: true } });
      expect(
        await runMcpShellCli(args, {
          ...output,
          fetchImplementation: async (url, init) => {
            if (init?.method === "DELETE") throw new Error(token);
            return http.fetchImplementation(url, init);
          },
        }),
      ).toBe(0);
      expect(JSON.parse(output.stdout.join(""))).toEqual({ structuredContent: { accepted: true } });
      expect(output.stderr).toEqual([]);
    }));

  it("bounds stalled cleanup without changing a successful result", async () =>
    fixture(async ({ args }) => {
      const output = io();
      const http = transport({ structuredContent: { accepted: true } });
      expect(
        await runMcpShellCli(args, {
          ...output,
          fetchImplementation: async (url, init) => {
            if (init?.method === "DELETE") return new Promise(() => {});
            return http.fetchImplementation(url, init);
          },
        }),
      ).toBe(0);
      expect(JSON.parse(output.stdout.join(""))).toEqual({ structuredContent: { accepted: true } });
      expect(output.stderr).toEqual([]);
    }));

  it("aborts a stalled transport at its bounded timeout", async () =>
    fixture(async ({ args }) => {
      const output = io();
      expect(
        await runMcpShellCli([...args, "--timeout-ms", "10"], {
          ...output,
          fetchImplementation: async (_url, init) =>
            new Promise((_resolve, reject) => {
              const signal = init?.signal;
              if (signal?.aborted) reject(new Error(token));
              else
                signal?.addEventListener("abort", () => reject(new Error(token)), { once: true });
            }),
        }),
      ).toBe(1);
      expect(output.stderr.join("")).toContain("timed out");
      expect(output.stderr.join("")).not.toContain(token);
    }));

  it("bounds a stdin wait and releases the input stream", async () =>
    fixture(async ({ args }) => {
      args[args.length - 1] = "-";
      const input = new NodeStream.PassThrough();
      const output = io();
      try {
        expect(await runMcpShellCli([...args, "--timeout-ms", "10"], { ...output, input })).toBe(2);
        expect(output.stderr.join("")).toContain("Timed out reading arguments");
        expect(input.isPaused()).toBe(true);
      } finally {
        input.destroy();
      }
    }));

  it("rejects invalid or oversized arguments before sending", async () =>
    fixture(async ({ args, argumentsFile }) => {
      for (const contents of ["{broken", "[]", "null", " ".repeat(1024 * 1024 + 1)]) {
        await NodeFSP.writeFile(argumentsFile, contents);
        const output = io();
        let calls = 0;
        expect(
          await runMcpShellCli(args, {
            ...output,
            fetchImplementation: async () => {
              calls += 1;
              throw new Error();
            },
          }),
        ).toBe(2);
        expect(calls).toBe(0);
      }
      args[args.length - 1] = "-";
      expect(
        await runMcpShellCli(args, {
          ...io(),
          input: NodeStream.Readable.from([Buffer.alloc(1024 * 1024 + 1)]),
        }),
      ).toBe(2);
    }));

  it("refuses public or symbolic-link token files", async () =>
    fixture(async ({ args, tokenFile, directory }) => {
      // oxlint-disable-next-line t3code/no-global-process-runtime -- This fixture uses actual host files; Windows does not provide POSIX file modes.
      if (NodeOS.platform() !== "win32") {
        await NodeFSP.chmod(tokenFile, 0o644);
        expect(await runMcpShellCli(args, io())).toBe(2);
        await NodeFSP.chmod(tokenFile, 0o600);
      }
      const link = NodePath.join(directory, "link");
      await NodeFSP.symlink(tokenFile, link);
      args[4] = link;
      expect(await runMcpShellCli(args, io())).toBe(2);
    }));

  it("rejects malformed credentials, endpoint secrets and invalid flags without echoing them", async () =>
    fixture(async ({ args, tokenFile }) => {
      for (const value of ["", `Bearer ${token}`, `${token}\nextra`, `${token}\u0000`]) {
        await NodeFSP.writeFile(tokenFile, value);
        const output = io();
        expect(await runMcpShellCli(args, output)).toBe(2);
        expect(output.stderr.join("")).not.toContain(token);
      }
      await NodeFSP.writeFile(tokenFile, token);
      for (const endpoint of [
        `https://user:${token}@fixture.invalid/mcp`,
        `https://fixture.invalid/mcp?token=${token}`,
        `https://fixture.invalid/mcp#${token}`,
        "http://remote.invalid/mcp",
        "file:///tmp/mcp",
      ]) {
        const invalid = [...args];
        invalid[2] = endpoint;
        const output = io();
        expect(await runMcpShellCli(invalid, output)).toBe(2);
        expect(output.stderr.join("")).not.toContain(token);
      }
      expect(await runMcpShellCli([...args, "--authorization", token], io())).toBe(2);
      expect(await runMcpShellCli([...args, "--timeout-ms", "0"], io())).toBe(2);
    }));

  it("bounds response bytes and rejects missing JSON-RPC results", async () =>
    fixture(async ({ args }) => {
      const output = io();
      expect(
        await runMcpShellCli(args, {
          ...output,
          ...transport({ content: "x".repeat(4 * 1024 * 1024) }),
        }),
      ).toBe(1);
      expect(output.stdout).toEqual([]);
      const http = transport({});
      expect(
        await runMcpShellCli(args, {
          ...io(),
          fetchImplementation: async (url, init) => {
            const body = JSON.parse(String(init?.body)) as { id: string; method: string };
            return body.method === "tools/call"
              ? new Response(JSON.stringify({ id: body.id }))
              : http.fetchImplementation(url, init);
          },
        }),
      ).toBe(1);
    }));

  it("shows help without reading a credential", async () => {
    const output = io();
    expect(await runMcpShellCli(["--help"], output)).toBe(0);
    expect(output.stdout.join("")).toContain("--token-file");
  });
});
