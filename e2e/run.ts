// Incident-reproduction runner. Derived from cc-stream-pack-template's
// e2e/run.ts, extended with: pack mounts, per-index/sourcetype breakdowns,
// and range expectations (for sampling scenarios).
//
// Usage: node --experimental-strip-types e2e/run.ts scenarios/s1 [scenarios/s2 ...]
// Scenario dir layout:
//   cribl/            -> /opt/cribl/local/cribl (inputs, outputs, route.yml, pipelines)
//   packs/<packId>    -> /opt/cribl/default/<packId>  (symlinks into ../../packs/ ok)
//   expect.json       -> { "<dest>": { "<index>/<sourcetype>": count | [min,max] } }
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const IMAGE = process.env.CRIBL_IMAGE ?? "cribl/cribl:latest";
const CONTAINER = "cribl-incident";
const API_PORT = 19000;
const TCP_PORT = 10070;
const EVENT_COUNT = Number(process.env.EVENT_COUNT ?? 1000);
const SOURCETYPES = ["zscalernss-web", "zscalernss-fw", "zscalernss-dns"];

const docker = (...args: string[]): string =>
  execFileSync("docker", args, { encoding: "utf8" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startCribl(scenarioDir: string, outDir: string): void {
  try {
    docker("rm", "-f", CONTAINER);
  } catch {
    /* not running */
  }
  // Config is COPIED in (docker cp) rather than bind-mounted: Cribl persists
  // config via rename(), which fails (EBUSY) over bind-mounted files — UI
  // edits would silently not persist and Cribl's internal git would fight
  // the mounts. With copies, Cribl fully owns its files and every scenario's
  // config can be committed in Cribl like a real change.
  docker(
    "create",
    "--name",
    CONTAINER,
    "-p",
    `${API_PORT}:9000`,
    "-p",
    `${TCP_PORT}:10070`,
    "-v",
    `${outDir}:/tmp/out`,
    IMAGE,
  );
  // Stage the whole local/cribl tree, then copy it in one shot (the image
  // has no /opt/cribl/local until first boot). Shared plumbing (inputs incl.
  // the syslog-zscaler datagen, destinations, passthrough pipeline) comes
  // from common/; each scenario contributes its route table and pack choices.
  const stage = mkdtempSync(join(tmpdir(), "cribl-local-"));
  const croot = join(stage, "cribl");
  mkdirSync(join(croot, "pipelines"), { recursive: true });
  cpSync("common/inputs.yml", join(croot, "inputs.yml"));
  cpSync("common/outputs.yml", join(croot, "outputs.yml"));
  cpSync("common/pipelines/passthrough", join(croot, "pipelines/passthrough"), {
    recursive: true,
  });
  cpSync(join(scenarioDir, "route.yml"), join(croot, "pipelines/route.yml"));
  // KEEP runs get the captured first-login state so the kept instance skips
  // the registration wizard and forced password change. Capture all three
  // from a registered container (the hash only validates alongside the SAME
  // instance's cribl.secret):
  //   for f in users.json cribl.secret 676f6174733432.dat; do
  //     docker cp cribl-incident:/opt/cribl/local/cribl/auth/$f common/first-login/; done
  // The dir is gitignored (email, instance secret, crackable hash — never
  // commit). With it in place admin/admin no longer works: set CRIBL_PASSWORD.
  if (process.env.KEEP === "1" && existsSync("common/first-login/users.json")) {
    cpSync("common/first-login", join(croot, "auth"), { recursive: true });
  }
  docker("cp", stage, `${CONTAINER}:/opt/cribl/local`);
  rmSync(stage, { recursive: true, force: true });
  docker("start", CONTAINER);
}

async function waitHealthy(timeoutSec = 90): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${API_PORT}/api/v1/health`);
      if (res.ok) {
        await sleep(6000); // workers finish loading inputs after health flips
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(2000);
  }
  throw new Error(`Cribl not healthy after ${timeoutSec}s`);
}

// Packs cannot be bind-mounted into /opt/cribl/default (breaks boot AND the
// failed boot's rollback deletes the mounted host files) — install via API.
async function installPacks(scenarioDir: string): Promise<void> {
  const packsDir = join(scenarioDir, "packs");
  const base = `http://localhost:${API_PORT}/api/v1`;
  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "admin",
      password: process.env.CRIBL_PASSWORD ?? "admin",
    }),
  });
  if (!login.ok)
    throw new Error(
      "Cribl API login failed — if common/first-login/ is mounted (KEEP=1), set CRIBL_PASSWORD to the admin password you chose during registration",
    );
  const { token } = (await login.json()) as { token: string };
  const auth = { Authorization: `Bearer ${token}` };
  for (const packId of existsSync(packsDir) ? readdirSync(packsDir) : []) {
    const dir = realpathSync(join(packsDir, packId));
    const crbl = execFileSync(
      "tar",
      ["-czf", "-", "-C", dir, ...readdirSync(dir)],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    const up = await fetch(`${base}/packs?filename=${packId}-1.0.0.crbl`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/octet-stream" },
      body: crbl,
    });
    const { source } = (await up.json()) as { source: string };
    const res = await fetch(`${base}/packs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ id: packId, source }),
    });
    if (!res.ok)
      throw new Error(`pack install ${packId} failed: ${await res.text()}`);
  }
  // Commit the scenario's full config in Cribl's internal git before any
  // data flows — same discipline as a real change (no uncommitted state).
  const commit = await fetch(`${base}/version/commit`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ message: `scenario ${basename(scenarioDir)}` }),
  });
  if (!commit.ok)
    throw new Error(`cribl config commit failed: ${await commit.text()}`);
  // Routes referencing pack:<id> bound before the pack existed stay
  // unresolved — restart so the route table re-binds to the installed packs.
  docker("restart", CONTAINER);
  await waitHealthy();
}

type EventShape = Record<string, unknown>;

// Fixed, deterministic distribution: seq round-robins the three sourcetypes,
// every event index=zscaler — mirroring "index/sourcetype set at collection".
function makeEvents(count: number): EventShape[] {
  return Array.from({ length: count }, (_, seq) => ({
    _raw: `zscaler event ${seq}`,
    index: "zscaler",
    sourcetype: SOURCETYPES[seq % SOURCETYPES.length],
    seq,
  }));
}

function sendOnce(events: EventShape[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(TCP_PORT, "127.0.0.1", () => {
      for (const e of events) sock.write(`${JSON.stringify(e)}\n`);
      sock.end();
    });
    sock.on("close", (hadError) =>
      hadError ? reject(new Error("socket closed with error")) : resolve(),
    );
    sock.on("error", () => {
      /* surfaced via close(hadError) */
    });
  });
}

async function sendEvents(events: EventShape[], retries = 10): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await sendOnce(events);
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(3000);
    }
  }
}

function ndjsonFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return ndjsonFiles(p);
    return name.startsWith("events") && name.endsWith(".json") ? [p] : [];
  });
}

function readDest(outDir: string, dest: string): EventShape[] {
  return ndjsonFiles(join(outDir, dest)).flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EventShape),
  );
}

// Controlled events carry a numeric seq; live-generator (datagen) events
// don't. Verdicts count only controlled events so every one is accountable.
const isControlled = (e: EventShape): boolean => typeof e.seq === "number";

// Unique-seq counts per "index/sourcetype" within one destination.
function breakdown(events: EventShape[]): Record<string, number> {
  const seqs = new Map<string, Set<unknown>>();
  for (const e of events.filter(isControlled)) {
    const key = `${e.index}/${e.sourcetype}`;
    if (!seqs.has(key)) seqs.set(key, new Set());
    seqs.get(key)?.add(e.seq);
  }
  return Object.fromEntries([...seqs].map(([k, v]) => [k, v.size]));
}

async function waitForFlush(
  outDir: string,
  dests: string[],
  timeoutSec = 90,
): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  let prev = "";
  while (Date.now() < deadline) {
    await sleep(5000);
    // Stability is judged on controlled (seq-numbered) events only — the
    // live datagen writes continuously and would never let raw counts settle.
    const counts = dests
      .map((d) => readDest(outDir, d).filter(isControlled).length)
      .join(",");
    if (counts === prev && counts !== dests.map(() => 0).join(",")) return;
    prev = counts;
  }
}

type Expectation = number | [number, number];

function matches(actual: number, expected: Expectation): boolean {
  return Array.isArray(expected)
    ? actual >= expected[0] && actual <= expected[1]
    : actual === expected;
}

export interface ScenarioResult {
  scenario: string;
  title: string;
  setup?: Record<string, string>;
  description: string;
  sent: number;
  dests: Record<
    string,
    {
      actual: Record<string, number>;
      expected: Record<string, Expectation>;
      live: number;
    }
  >;
  pass: boolean;
}

export async function runScenario(scenarioDir: string): Promise<ScenarioResult> {
  const expect = JSON.parse(
    readFileSync(join(scenarioDir, "expect.json"), "utf8"),
  ) as {
    title?: string;
    setup?: Record<string, string>;
    description: string;
    dests: Record<string, Record<string, Expectation>>;
  };
  const destNames = Object.keys(expect.dests);
  const outDir = mkdtempSync(join(tmpdir(), "cribl-incident-"));
  startCribl(scenarioDir, outDir);
  try {
    await waitHealthy();
    await installPacks(scenarioDir);
    // Live-generator events emitted before the committed config finished
    // loading are excluded by timestamp (deleting them instead would rip
    // open files out from under Cribl's filesystem destination).
    const cutoff = Date.now() / 1000;
    const events = makeEvents(EVENT_COUNT);
    await sendEvents(events);
    await waitForFlush(outDir, destNames);
    let pass = true;
    const dests: ScenarioResult["dests"] = {};
    for (const d of destNames) {
      const destEvents = readDest(outDir, d);
      const actual = breakdown(destEvents);
      const expected = expect.dests[d];
      dests[d] = {
        actual,
        expected,
        live: destEvents.filter(
          (e) => !isControlled(e) && (e._time as number) >= cutoff,
        ).length,
      };
      const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
      for (const k of keys) {
        if (!matches(actual[k] ?? 0, expected[k] ?? 0)) pass = false;
      }
    }
    return {
      scenario: basename(scenarioDir),
      title: expect.title ?? basename(scenarioDir),
      setup: expect.setup,
      description: expect.description,
      sent: events.length,
      dests,
      pass,
    };
  } finally {
    // KEEP=1 leaves the last scenario's container running so you can log in
    // at http://localhost:19000 and inspect routes/pipelines.
    // The next scenario (or run) still recycles it via `docker rm -f`.
    if (process.env.KEEP === "1") {
      console.error(
        `container ${CONTAINER} kept alive — Cribl UI: http://localhost:${API_PORT}`,
      );
    } else {
      try {
        docker("rm", "-f", CONTAINER);
      } catch {
        /* already gone */
      }
    }
  }
}

function fmtExpected(e: Expectation): string {
  return Array.isArray(e) ? `${e[0]}–${e[1]}` : String(e);
}

// Human-friendly destination labels for the plain-language report.
const DEST_LABELS: Record<string, string> = {
  prod: "Production (Splunk)",
  s3: "Archive (S3)",
  dev: "Dev / test (Splunk)",
  default: "Lost — matched no route",
};

const total = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((a, b) => a + b, 0);

// One flow picture per scenario: events in on the left, where they ended up
// on the right. Renders natively on GitHub — no tooling needed to read it.
function mermaidFlow(r: ScenarioResult): string {
  const lines = [
    "```mermaid",
    "flowchart LR",
    `  IN(["${r.sent.toLocaleString("en-US")} events sent"]) --> C{"Cribl routing"}`,
  ];
  for (const [dest, { actual, expected, live }] of Object.entries(r.dests)) {
    const got = total(actual);
    const ok = Object.keys({ ...actual, ...expected }).every((k) =>
      matches(actual[k] ?? 0, expected[k] ?? 0),
    );
    const liveNote = live > 0 ? ` (+${live.toLocaleString("en-US")} live)` : "";
    lines.push(
      `  C -->|"${got.toLocaleString("en-US")}${liveNote}"| ${dest}["${ok ? "" : "⚠️ "}${DEST_LABELS[dest] ?? dest}"]`,
      `  style ${dest} ${ok ? (dest === "default" ? "fill:#eee,stroke:#999" : "fill:#d3f9d8,stroke:#2b8a3e") : "fill:#ffe3e3,stroke:#c92a2a"}`,
    );
  }
  lines.push("```");
  return lines.join("\n");
}

function plainVerdict(r: ScenarioResult): string {
  const prodGot = total(r.dests.prod?.actual ?? {});
  const lost = total(r.dests.default?.actual ?? {});
  if (!r.pass) return "❌ **Something unexpected happened — see the numbers below.**";
  if (lost > 0) return `⚠️ ${lost} events matched no route.`;
  return `✅ **No production data was lost.** Production received ${prodGot.toLocaleString("en-US")} of ${r.sent.toLocaleString("en-US")} events sent.`;
}

export function reportMarkdown(results: ScenarioResult[]): string {
  const lines: string[] = [
    "# Cribl routing test results",
    "",
    `In every test below, exactly **${results[0]?.sent.toLocaleString("en-US") ?? "1,000"} events** were sent into a real Cribl`,
    "instance, and we counted exactly where every single event ended up.",
    "A live traffic generator (`syslog-zscaler`) also runs the whole time so",
    "the instance behaves like a real environment — its events are shown as",
    "“+N live” but only the 1,000 tracked events decide pass/fail.",
    "Each test's configuration is committed in Cribl before any data flows.",
    "Each test uses a different routing configuration — the point is to see",
    "whether the dev/test route can ever make production lose data.",
    "",
    "## At a glance",
    "",
    "| Test | Question it answers | Result |",
    "| --- | --- | --- |",
    ...results.map(
      (r) =>
        `| [${r.scenario}](#${r.scenario.replaceAll(".", "")}) | ${r.title} | ${r.pass ? "✅ pass" : "❌ FAIL"} |`,
    ),
    "",
  ];
  for (const r of results) {
    const SETUP_LABELS: Record<string, string> = {
      dev: "Dev/test route",
      sampling: "Dev sampling",
      rename: "Dev renames index/sourcetype",
      guard: "Guard on the rename",
    };
    lines.push(
      `## ${r.scenario}`,
      "",
      `**${r.title}**`,
      "",
      r.description,
      "",
      ...(r.setup
        ? [
            "| Setting | This test |",
            "| --- | --- |",
            ...Object.entries(r.setup).map(
              ([k, v]) => `| ${SETUP_LABELS[k] ?? k} | ${v} |`,
            ),
            "",
          ]
        : []),
      plainVerdict(r),
      "",
      mermaidFlow(r),
      "",
      "<details><summary>Detailed counts (click to expand)</summary>",
      "",
      `Sent: ${r.sent} events (index=zscaler, sourcetypes round-robin ${SOURCETYPES.join(", ")})`,
      "",
      "| Destination | index/sourcetype | Actual | Expected |",
      "| --- | --- | --- | --- |",
    );
    for (const [dest, { actual, expected }] of Object.entries(r.dests)) {
      const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
      if (keys.length === 0) lines.push(`| ${dest} | (none) | 0 | 0 |`);
      for (const k of keys) {
        const ok = matches(actual[k] ?? 0, expected[k] ?? 0);
        lines.push(
          `| ${dest} | ${k} | ${actual[k] ?? 0}${ok ? "" : " ⚠️"} | ${fmtExpected(expected[k] ?? 0)} |`,
        );
      }
    }
    lines.push("", "</details>", "");
  }
  return lines.join("\n");
}

const isMain = process.argv[1]?.endsWith("run.ts");
if (isMain) {
  const scenarioDirs = process.argv.slice(2);
  if (scenarioDirs.length === 0) {
    console.error("usage: node e2e/run.ts <scenarioDir...>");
    process.exit(2);
  }
  const results: ScenarioResult[] = [];
  for (const dir of scenarioDirs) {
    console.error(`running ${dir} ...`);
    const r = await runScenario(dir);
    console.error(`  ${r.scenario}: ${r.pass ? "pass" : "FAIL"}`);
    results.push(r);
    writeFileSync(
      join("results", `${r.scenario}.json`),
      `${JSON.stringify(r, null, 2)}\n`,
    );
  }
  const md = reportMarkdown(results);
  writeFileSync("REPORT.md", `${md}\n`);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}
