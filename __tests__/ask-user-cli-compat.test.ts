/**
 * CLI compatibility: does pi actually start with Flows + another ask_user owner,
 * in either extension order, and does an UNRELATED name collision stay fatal?
 *
 * See change: fix-ask-user-fallback (F8-F9). Real pi in RPC mode, no model call.
 * Cases (A) Flows→Durable fixture, (B) Durable fixture→Flows, (S) Flows alone,
 * (D) Flows + unrelated duplicate. F8 (A)/(B) fail on today's code with the
 * startup conflict; F8 (S) and F9 pass.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piBin = join(repoRoot, "node_modules", ".bin", "pi");
const flowsEntry = join(repoRoot, "extensions", "index.ts");
const fixture = (name: string) => join(repoRoot, "__tests__", "fixtures", name);

const DURABLE_SCHEMA_FINGERPRINT = "49fe5adc63bac38e4ae3d42dd5affa1892749bf3e40b2495cf5203b3e381e134";
const FLOWS_SCHEMA_FINGERPRINT = "015680146c83fd4ccc7a5bbfe9e427aadda4d5384b21c7df35a0390a362600b7";

const HARNESS_TIMEOUT_MS = 45_000;

interface ProbeReport {
  fired: boolean;
  askUserCount: number;
  tools: string[];
}

interface SchemaReport {
  count: number;
  fingerprint: string | null;
  shape: { properties: string[]; required: string[] };
}

interface CliRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** true once the get_state response arrives on stdout */
  ready: boolean;
  probe: ProbeReport | null;
  schema: SchemaReport | null;
}

/** Run the repo-local pi binary in RPC mode against a set of extensions. */
function runPiCli(extensionPaths: string[]): Promise<CliRun> {
  const dir = mkdtempSync(join(tmpdir(), "pi-flows-ask-user-cli-"));
  const probeOut = join(dir, "probe.json");
  const schemaOut = join(dir, "schema.json");

  // Strip this session's PI_* so the child only sees what the harness sets.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("PI_")) env[key] = value;
  }
  Object.assign(env, {
    HOME: dir,
    PI_CODING_AGENT_DIR: join(dir, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PROBE_OUT: probeOut,
    PROBE_SCHEMA_OUT: schemaOut,
  });

  const args = [
    "--mode", "rpc",
    "--no-extensions",
    ...extensionPaths.flatMap((p) => ["-e", p]),
    "--no-skills",
    "--no-approve",
  ];

  return new Promise<CliRun>((resolveRun) => {
    const child = spawn(piBin, args, { cwd: repoRoot, env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const finish = () => {
      const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
      let ready = false;
      for (const line of lines) {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "response" && msg.command === "get_state" && msg.success === true) ready = true;
      }
      resolveRun({
        code: child.exitCode,
        signal: child.signalCode,
        timedOut,
        stdout,
        stderr,
        ready,
        probe: readJson(probeOut) as ProbeReport | null,
        schema: readJson(schemaOut) as SchemaReport | null,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, HARNESS_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      stderr += String(err);
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolveRun({ code: null, signal: null, timedOut: false, stdout, stderr, ready: false, probe: null, schema: null });
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(); // reads the probe files, then…
      rmSync(dir, { recursive: true, force: true }); // …never leaves a temp dir behind
    });

    child.stdin.write('{"type":"get_state"}\n');
    child.stdin.end();
  });
}

function readJson(path: string): unknown | null {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

const probesLast = (...exts: string[]) => [...exts, fixture("session-start-probe.ts"), fixture("ask-user-schema-probe.ts")];

const cases = [
  {
    name: "A: Flows then the Durable-shaped owner",
    exts: probesLast(flowsEntry, fixture("durable-shaped-ask-user.ts")),
    durableOwner: true,
  },
  {
    name: "B: the Durable-shaped owner then Flows",
    exts: probesLast(fixture("durable-shaped-ask-user.ts"), flowsEntry),
    durableOwner: true,
  },
  { name: "S: Flows alone", exts: probesLast(flowsEntry), durableOwner: false },
];

describe("pi CLI: Flows alongside another ask_user owner", () => {
  for (const testCase of cases) {
    it(`F8 ${testCase.name}`, async () => {
      const run = await runPiCli(testCase.exts);

      // Startup completes: the get_state response is the ready marker.
      expect(run.timedOut, `pi did not finish starting within ${HARNESS_TIMEOUT_MS} ms`).toBe(false);
      expect(run.ready, `no get_state response; stderr: ${run.stderr}`).toBe(true);
      expect(run.code).toBe(0);

      // No conflict about ask_user — and none suppressed either.
      expect(run.stderr, `startup diagnostic: ${run.stderr}`).not.toContain("conflicts with");

      expect(run.probe?.fired).toBe(true);
      expect(run.probe?.askUserCount).toBe(1);
      expect(run.schema?.count).toBe(1);

      if (testCase.durableOwner) {
        // The external owner's schema is the one that survived, unchanged.
        expect(run.schema?.fingerprint).toBe(DURABLE_SCHEMA_FINGERPRINT);
        expect(run.schema?.shape).toEqual({ properties: ["question"], required: ["question"] });
      } else {
        // Standalone: Flows' own structured schema.
        expect(run.schema?.fingerprint).toBe(FLOWS_SCHEMA_FINGERPRINT);
        expect(run.schema?.shape).toEqual({
          properties: ["allowCustom", "defaultValue", "multiSelect", "options", "question", "type"],
          required: ["question", "type"],
        });
      }

      // The rest of the Flows tool surface is still there next to ask_user.
      for (const name of ["flow_results", "flow_agents", "flow_write"]) {
        expect(run.probe?.tools).toContain(name);
      }
    }, 120_000);
  }
});

describe("pi CLI: an unrelated duplicate tool name still fails startup", () => {
  it("F9 flow_results collision is reported and exits non-zero", async () => {
    const run = await runPiCli(
      probesLast(flowsEntry, fixture("unrelated-duplicate.ts")),
    );

    expect(run.timedOut).toBe(false);
    expect(run.code).not.toBe(0);
    expect(run.code).toBe(1);
    // stderr is never swallowed: the ordinary diagnostic is what we get.
    expect(run.stderr).toContain("conflicts with");
    expect(run.stderr).toContain("flow_results");
  }, 120_000);
});
