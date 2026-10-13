// Linux/systemd live regression proof; creates and reaps only its own detached sleeper.
// Usage: node scripts/verify-agent-scope.mjs <native-monitor-binary>
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as ProcessRunner from "../apps/server/src/processRunner.ts";
import { make } from "../apps/server/src/process/agentScope.ts";

const binary = process.argv[2];
if (process.platform !== "linux" || !binary) {
  throw new Error(
    "Usage on Linux with a systemd user manager: node scripts/verify-agent-scope.mjs <native-monitor-binary>",
  );
}
const execute = promisify(execFile);
await Effect.runPromise(
  Effect.gen(function* () {
    const scopes = yield* make;
    const launch = yield* scopes.wrap({
      command: "/bin/sh",
      name: "perf-fixture",
      args: ["-c", "setsid /bin/sleep 60 </dev/null >/dev/null 2>&1 & echo $!"],
    });
    if (!launch.cleanup) throw new Error("Systemd agent scopes are unavailable");
    yield* Effect.addFinalizer(() => launch.cleanup);
    // Direct spawn is deliberate: ProcessRunner itself reaps descendants on release.
    const output = yield* Effect.promise(() =>
      execute(launch.command, [...launch.args], { timeout: 5_000 }),
    );
    const pid = Number(output.stdout.trim());
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Fixture did not report a PID");
    const sample = () =>
      Effect.promise(async () => {
        const output = await execute(
          process.execPath,
          [fileURLToPath(new URL("./perf-diagnostics.mjs", import.meta.url)), binary, String(pid)],
          { timeout: 8_000 },
        );
        return JSON.parse(output.stdout);
      });
    const before = yield* sample();
    yield* launch.cleanup;
    const after = yield* sample();
    if (
      !before.reports.every((entry) => entry.processCount === 1) ||
      !after.reports.every((entry) => entry.processCount === 0)
    ) {
      throw new Error("Detached scope cleanup did not converge from one process to zero");
    }
    console.log(JSON.stringify({ before, after }, null, 2));
  }).pipe(Effect.scoped, Effect.provide(ProcessRunner.layer), Effect.provide(NodeServices.layer)),
);
