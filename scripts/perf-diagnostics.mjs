// Read-only, bounded sampling with the same native counter binary as Settings > Diagnostics.
// Usage: node scripts/perf-diagnostics.mjs <monitor-binary> <server-pid> [desktop-pid]
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

const [binary, serverArg, desktopArg] = process.argv.slice(2);
const serverPid = Number(serverArg);
const desktopPid = desktopArg === undefined ? undefined : Number(desktopArg);
if (
  !binary ||
  !Number.isSafeInteger(serverPid) ||
  serverPid <= 1 ||
  (desktopPid !== undefined && (!Number.isSafeInteger(desktopPid) || desktopPid <= 1))
) {
  throw new Error(
    "Usage: node scripts/perf-diagnostics.mjs <monitor-binary> <server-pid> [desktop-pid]",
  );
}

const child = NodeChildProcess.spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"] });
const samples = [];
const send = (version, command) =>
  child.stdin.write(`${JSON.stringify({ version, ...command })}\n`);
const deadline = setTimeout(() => {
  child.kill();
  process.exitCode = 1;
}, 8_000);
child.on("error", (error) => {
  clearTimeout(deadline);
  console.error(error.message);
  process.exitCode = 1;
});
try {
  for await (const line of NodeReadline.createInterface({ input: child.stdout })) {
    const event = JSON.parse(line);
    if (event.type === "hello") {
      send(event.version, {
        type: "configure",
        rootPid: serverPid,
        sampleIntervalMs: 1_000,
        externalProcesses: desktopPid === undefined ? [] : [{ pid: desktopPid }],
      });
      send(event.version, { type: "setStreaming", enabled: true });
    }
    if (event.type === "error") throw new Error(`Monitor error: ${event.code}`);
    if (event.type !== "snapshot") continue;
    // Discard the first observation: CPU counters need a previous sample.
    samples.push(event);
    if (samples.length < 4) continue;
    send(event.version, { type: "shutdown" });
    const retained = samples.slice(1);
    const reports = retained.map((sample) => {
      const byPid = new Map(sample.processes.map((entry) => [entry.pid, entry]));
      const belongsToBackend = (entry) => {
        const visited = new Set();
        while (entry && !visited.has(entry.pid)) {
          if (entry.pid === serverPid) return true;
          visited.add(entry.pid);
          entry = byPid.get(entry.ppid);
        }
        return false;
      };
      const groups = new Map();
      for (const entry of sample.processes) {
        // Command arguments may contain private data; report executable names only.
        const key = `${belongsToBackend(entry) ? "backend" : "desktop"}: ${entry.name}`;
        const total = groups.get(key) ?? { count: 0, cpuPercent: 0, rssBytes: 0 };
        total.count++;
        total.cpuPercent += entry.cpuPercent;
        total.rssBytes += entry.residentBytes;
        groups.set(key, total);
      }
      return {
        sampledAt: sample.sampledAtUnixMs,
        processCount: sample.processes.length,
        cpuPercent: sample.processes.reduce((sum, entry) => sum + entry.cpuPercent, 0),
        rssBytes: sample.processes.reduce((sum, entry) => sum + entry.residentBytes, 0),
        groups: [...groups]
          .map(([name, totals]) => ({ name, ...totals }))
          .sort((a, b) => b.rssBytes - a.rssBytes),
      };
    });
    console.log(
      JSON.stringify({ serverPid, desktopPid, sampleCount: reports.length, reports }, null, 2),
    );
    break;
  }
  if (samples.length < 4) throw new Error("Native monitor exited before sampling completed");
} finally {
  clearTimeout(deadline);
  child.stdin.end();
  // Only this utility's sidecar can be terminated; never signal observed processes.
  if (child.exitCode === null) child.kill();
}
