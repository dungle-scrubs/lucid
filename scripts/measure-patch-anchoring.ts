#!/usr/bin/env bun
/**
 * RFC-08 Open Question 1: does the agent know the current document well
 * enough to anchor against it?
 *
 * Every anchor must match the current version exactly once. The agent writes
 * it from its own picture of the document, and that picture can drift. When
 * it does the patch is refused and the turn costs a refusal plus a resend.
 * How often that happens decides the resend policy, and nothing in the RFC
 * can predict it.
 *
 * This drives a real conversation of many revisions against a live harness
 * and reports what actually happened. It is a measurement, not a test: it is
 * nondeterministic by construction and never gates CI.
 *
 *   bun scripts/measure-patch-anchoring.ts [--record NAME] [--revisions N]
 *
 * Everything it reports is read back out of the record afterwards. That is
 * the point: if the numbers can be recovered from the log alone, RFC-08's
 * Open Question 3 needs no new field on the artifact entry.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
};

const RECORD = arg("record", `measure-${Date.now().toString(36)}`);
const REVISIONS = Number(arg("revisions", "22"));
/** Kill and restart the driver after this many revisions, or 0 to never.
 *
 * The other half of Open Question 1. Within one session the agent wrote
 * every version itself and its context still holds them, and it anchored 17
 * for 17. A restart takes that context away: the state block names the
 * artifact and its current version but carries no bytes, so the agent is
 * asked to revise a document it cannot see.
 *
 * What is being measured is not only whether an anchor misses. It is whether
 * the agent NOTICES it cannot see the document and falls back to the whole
 * form, which is what the preamble tells it to do when it is unsure what the
 * current version holds. A refusal is a bad outcome; a correct fallback is a
 * good one; a patch that lands by luck is the one worth knowing about. */
const RESTART_AFTER = Number(arg("restart-after", "0"));
const BIN = join(import.meta.dir, "..", "dist", "lucid2");
const LOG = join(homedir(), ".lucid2", "records", RECORD, "log.ndjson");

/** Small, local changes: the kind a patch is for. Deliberately phrased the
 * way a person would, with no mention of patches or anchors, so what is
 * measured is the agent's own choice of form. */
const CHANGES = [
  "Change item 3 to be about laptop disk encryption.",
  "Make item 7 mention the on-call rota by name.",
  "Reword item 1 so it starts with a verb.",
  "Add the word 'briefly' to item 5.",
  "Change item 10 so it says two weeks instead of one.",
  "Make item 2 shorter, drop the second clause.",
  "Item 9 should mention the design system.",
  "Change 'repository' to 'repo' in item 4.",
  "Make item 12 about writing a first pull request.",
  "Item 6 should say 'pair with' instead of 'shadow'.",
  "Add 'and bookmark it' to the end of item 8.",
  "Change item 11 to be about the incident channel.",
  "Reword item 3 so it is one sentence, not two.",
  "Make item 7 say 'weekly' instead of 'regular'.",
  "Item 1 should mention the buddy system.",
  "Change 'onboarding' to 'first week' in item 12.",
  "Item 5 should name the staging environment.",
  "Add 'ask questions early' to item 2.",
  "Make item 10 mention a check-in with the manager.",
  "Item 4 should say 'clone' rather than 'download'.",
  "Reword item 9 to be about accessibility.",
  "Item 8 should mention the architecture decision records.",
  "Change item 6 to name a specific team.",
  "Make item 11 shorter by half.",
  "Item 3 should mention the recovery key.",
];

/** Kill the driver for this record and start a new one, the way losing the
 * process and reopening the record does. Not a graceful handover: the point
 * is that the agent's context is gone. */
const restartDriver = async (harness: string): Promise<void> => {
  const attachesBefore = attachCount();
  // -9. A plain signal does not reliably end this process, and a run whose
  // "restart" left the original driver alive measures nothing at all - the
  // second half rides the same session as the first, and every anchor
  // resolves from context that was never lost.
  await new Promise<void>((resolve) => {
    const p = spawn("pkill", ["-9", "-f", `lucid2 run ${RECORD}`], { stdio: "ignore" });
    p.on("close", () => resolve());
    p.on("error", () => resolve());
  });
  await sleep(3_000);
  // Through a shell with nohup, and to a real log file. A detached spawn
  // with stdio ignored died immediately, and so did nohup redirected to
  // /dev/null; with somewhere to write, the driver starts and stays up. The
  // log is also the only place a failed restart says why, which a
  // measurement needs more than a tidy console does.
  const driverLog = join(homedir(), ".lucid2", "records", RECORD, "driver.log");
  const next = spawn(
    "sh",
    ["-c", `nohup ${BIN} run ${RECORD} --harness ${harness} >> ${driverLog} 2>&1 &`],
    { stdio: "ignore" },
  );
  next.unref();
  // A new driver appends its own attach frame. Waiting for that rather than
  // for a fixed delay is what makes the restart a fact in the record instead
  // of an assumption in this script.
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    await sleep(2_000);
    if (attachCount() > attachesBefore) return;
  }
  throw new Error("the restarted driver never attached; the run would measure nothing");
};

const run = (args: string[]): Promise<number> =>
  new Promise((resolve) => {
    const p = spawn(BIN, args, { stdio: "ignore" });
    p.on("close", (code) => resolve(code ?? 1));
    p.on("error", () => resolve(1));
  });

const rows = (): Record<string, unknown>[] => {
  try {
    return readFileSync(LOG, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
};

const versionCount = (id: string): number => rows().filter((d) => d.artifactId === id).length;

const eventCount = (kind: string): number =>
  rows().filter((d) => {
    const ev = ((d.frame as Record<string, unknown>)?.event ?? {}) as Record<string, unknown>;
    return ev.kind === kind;
  }).length;

const errorCount = (): number => eventCount("error");
/** Attach frames. A driver appends one when it takes the record, so this
 * counts how many times a driver has picked this conversation up. */
const attachCount = (): number =>
  rows().filter((d) => (d.frame as Record<string, unknown> | undefined)?.kind === "attach").length;
/** Turns that have reached a terminal event. A turn that finishes without
 * writing anything means the agent answered in prose - most often because it
 * judged the change already made, which is right and is not a stall. */
const doneCount = (): number => eventCount("done");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const log = (m: string): void => {
  process.stdout.write(`${m}\n`);
};

/** Wait until either a new version or a new refusal appears, or time runs
 * out. A refusal is a result, not a failure of the measurement. */
const settle = async (
  id: string,
  versionsBefore: number,
  errorsBefore: number,
  donesBefore: number,
  timeoutMs = 180_000,
): Promise<"version" | "refusal" | "declined" | "silence"> => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await sleep(2_000);
    if (versionCount(id) > versionsBefore) return "version";
    if (errorCount() > errorsBefore) return "refusal";
    // Checked last: a turn that wrote a version also emits `done`, so this
    // must not win the race against the two outcomes that mean something.
    if (doneCount() > donesBefore) return "declined";
  }
  return "silence";
};

console.log(`record ${RECORD}, ${REVISIONS} revisions, binary ${BIN}`);
console.log("start the driver first:");
console.log(`  ${BIN} run ${RECORD} --harness claude`);
console.log("");

await run([
  "send",
  RECORD,
  "Make me a checklist document for onboarding a new engineer, id 'onboarding'. Twelve items, each a full sentence of about 25 words. Number them so they can be referred to.",
]);
const seeded = await settle("onboarding", 0, 0, 0);
if (seeded !== "version") {
  console.error(`the first document never landed (${seeded}); is the driver running?`);
  process.exit(1);
}
console.log("v1 landed\n");

let declines = 0;
/** How many versions existed when the driver was restarted, so the report
 * can split before from after. */
let restartedAt = -1;
/** When the restart happened, so the report can split the run by it. */
let restartedMs = 0;
for (let i = 0; i < REVISIONS; i++) {
  const change = CHANGES[i % CHANGES.length] as string;
  const v = versionCount("onboarding");
  const e = errorCount();
  const dn = doneCount();
  await run(["send", RECORD, change]);
  const outcome = await settle("onboarding", v, e, dn);
  process.stdout.write(`  ${String(i + 1).padStart(2)} ${outcome.padEnd(9)} ${change}\n`);
  declines += outcome === "declined" ? 1 : 0;
  if (RESTART_AFTER > 0 && i + 1 === RESTART_AFTER) {
    log(`restarting the driver after ${RESTART_AFTER} revisions`);
    await restartDriver(arg("harness", "claude"));
    restartedAt = versionCount("onboarding");
    restartedMs = Date.now();
  }
  // Only real silence ends the run. A decline is the agent judging the
  // change already made, which is a result and not a stall.
  if (outcome === "silence") break;
  // A refusal leaves the turn open for a retry the agent makes itself; give
  // it a moment before piling the next request on top.
  if (outcome === "refusal") await settle("onboarding", v, errorCount(), doneCount(), 60_000);
}

console.log("\n--- what the record says\n");
const all = rows();
const versions = all.filter((d) => d.artifactId === "onboarding");
const messages = all.flatMap((d) => {
  const f = (d.frame ?? {}) as Record<string, unknown>;
  const ev = (f.event ?? {}) as Record<string, unknown>;
  return ev.kind === "message" && ev.role === "assistant"
    ? [{ at: Number(d.at ?? 0), turnId: String(f.turnId), text: String(ev.text ?? "") }]
    : [];
});
const errors = all.flatMap((d) => {
  const ev = (((d.frame ?? {}) as Record<string, unknown>).event ?? {}) as Record<string, unknown>;
  return ev.kind === "error" ? [String(ev.message ?? "")] : [];
});

const isPatch = (t: string): boolean => /"form"\s*:\s*"patch"/.test(t);
const patches = messages.filter((m) => isPatch(m.text));
const wholes = messages.filter((m) => !isPatch(m.text) && m.text.includes("lucid-artifact"));

const byCode = new Map<string, number>();
for (const e of errors) {
  const m = /E-PATCH-\d+/.exec(e);
  byCode.set(m?.[0] ?? "other", (byCode.get(m?.[0] ?? "other") ?? 0) + 1);
}

const avg = (ns: number[]): number =>
  ns.length === 0 ? 0 : Math.round(ns.reduce((a, b) => a + b, 0) / ns.length);

const docSize =
  versions.length === 0 ? 0 : String(versions[versions.length - 1]?.bytes ?? "").length;

console.log(`versions stored          ${versions.length}`);
console.log(`document size at the end ${docSize} chars`);
console.log(`emissions: patch ${patches.length}, whole ${wholes.length}`);
console.log(
  `average emitted: patch ${avg(patches.map((m) => m.text.length))}, whole ${avg(wholes.map((m) => m.text.length))}`,
);
if (restartedAt >= 0) {
  console.log(`driver restarted after      version ${restartedAt}`);
}
console.log(`declined as unnecessary  ${declines}`);
console.log(`refusals                 ${errors.length}`);
for (const [code, n] of [...byCode.entries()].sort()) console.log(`  ${code}  ${n}`);
const attempts = patches.length;
const misses = byCode.get("E-PATCH-02") ?? 0;
console.log(
  `anchor miss rate         ${attempts === 0 ? "n/a" : `${((misses / attempts) * 100).toFixed(1)}% (${misses}/${attempts})`}`,
);
const wholeAvg = avg(wholes.map((m) => m.text.length));
const patchAvg = avg(patches.map((m) => m.text.length));
console.log(
  `output saving            ${patchAvg === 0 || wholeAvg === 0 ? "n/a" : `${(wholeAvg / patchAvg).toFixed(1)}x`}`,
);
if (restartedMs > 0) {
  // The whole point of the run. Before the restart the agent wrote every
  // version itself; after it, the state block names the artifact and its
  // current version and carries no bytes, so a patch is written against a
  // document the agent cannot see.
  const errAfter = all.filter((d) => {
    const ev = (((d.frame ?? {}) as Record<string, unknown>).event ?? {}) as Record<
      string,
      unknown
    >;
    return ev.kind === "error" && Number(d.at ?? 0) >= restartedMs;
  }).length;
  for (const after of [false, true]) {
    const ms = messages.filter((m) => (after ? m.at >= restartedMs : m.at < restartedMs));
    const pat = ms.filter((m) => isPatch(m.text)).length;
    const who = ms.filter((m) => !isPatch(m.text) && m.text.includes("lucid-artifact")).length;
    const prose = ms.length - pat - who;
    console.log(
      `${after ? "after " : "before"} restart: ${pat} patch, ${who} whole, ${prose} prose` +
        (after ? `, ${errAfter} refusals` : ""),
    );
  }
}

console.log(`\nrecord: ${LOG}`);
