import * as Effect from "effect/Effect";
import { Argument, Command, Flag } from "effect/cli";

import { runMcpShellCli } from "../mcp/McpShellCli.ts";

export const mcpCallCommand = Command.make("mcp-call", {
  tool: Argument.String("tool"),
  endpoint: Flag.String("endpoint"),
  tokenFile: Flag.String("token-file"),
  argumentsFile: Flag.String("arguments-file"),
  timeoutMs: Flag.String("timeout-ms").pipe(Flag.withDefault("120000")),
}).pipe(
  Command.withDescription("Call an existing T3 tool with a private bearer token file."),
  Command.withHandler(({ tool, endpoint, tokenFile, argumentsFile, timeoutMs }) =>
    Effect.promise(async () => {
      process.exitCode = await runMcpShellCli([
        tool,
        "--endpoint",
        endpoint,
        "--token-file",
        tokenFile,
        "--arguments-file",
        argumentsFile,
        "--timeout-ms",
        timeoutMs,
      ]);
    }),
  ),
);
