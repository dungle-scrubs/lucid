import { stdoutSink } from "../server/observe.ts";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Anchor } from "../anchors/anchor.ts";
import { readLastAttendant, writeAttendantSidecar } from "../core/attendant.ts";
import { parseCursor, renderCursor } from "../core/cursor.ts";
import { deliver } from "../core/deliver.ts";
import { shellArg } from "../core/escape.ts";
import { foldLog, type ForkRecord } from "../core/fold.ts";
import { readEvents } from "../core/log.ts";
import { sessionPaths, type SessionPaths } from "../core/paths.ts";
import type { PayloadImage, WaitPayload } from "../core/payload.ts";
import { openSession } from "../core/session.ts";
import { runWait } from "../core/wait.ts";
import { openBrowser, spawnServer, waitForServer } from "../cli/self.ts";
import { resolveView, wantsBrowserWindow } from "../server/view.ts";
import { discoverLiveServer, removeServerDescriptor } from "../server/discovery.ts";
import {
  buildArgv,
  resolveRecipe,
  type HarnessRegistry,
  type RecipeVar,
  type SpawnRecipe,
} from "./recipes.ts";
import { safeForkId, writeForkSeed } from "./seed.ts";

/**
 * The fork launcher (Phase 2). An opt-in, foreground process the human runs
 * alongside a review. It is the one component permitted to spawn agents - a
 * deliberate, human-initiated exception to D-064 (the review server still only
 * appends to a log) - and it stays agent-agnostic by running the harness's
 * declared recipe, never a hardcoded launch command.
 *
 * Shape C: the launcher itself holds the listening presence on a forked child
 * (via `runWait`, which registers as an agent listener) and spawns a
 * short-lived agent only when feedback arrives - no idle agent process per
 * artifact. It yields a child the moment a human attaches their own harness
 * (single-attendant invariant).
 */

/** Sidecar harness name the launcher records for its own attendance, so a human
 *  attendant is distinguishable and the launcher knows to yield. */
export const LAUNCHER_HARNESS = "lucid-launcher";

export interface LaunchOptions {
  /** Poll interval for new forks on the parent (ms). */
  readonly pollMs?: number;
  /** Open a browser tab for a child the launcher had to open as a fallback. */
  readonly openBrowser?: boolean;
  /** Stop the loop cooperatively. */
  readonly signal?: AbortSignal;
  /** Activity sink (human-readable lines). Defaults to stdout. */
  readonly log?: (message: string) => void;
  /** Override how a child viewer is ensured live (seam for tests, which cannot
   *  spawn a detached CLI). Defaults to the detached per-session daemon. */
  readonly openChild?: (child: SessionPaths, browser: boolean) => Promise<boolean>;
}

export type ChildStatus = "created" | "no-recipe" | "author-failed";

export interface CreatedChild {
  readonly forkId: string;
  readonly childArtifact: string;
  readonly childSessionId: string;
  readonly harness: string | null;
  readonly status: ChildStatus;
}

const DEFAULT_POLL_MS = 1500;
/** Consecutive failed resume turns before the launcher gives up on a batch
 *  (advances past it) rather than retrying forever on a broken recipe. */
const MAX_RESUME_FAILS = 3;

const handledPath = (parent: SessionPaths): string =>
  join(parent.sessionDir, "forks", "handled.json");

/**
 * The set of forks already acted on. A missing file means "nothing handled"
 * (first run); a PRESENT-but-corrupt file throws rather than silently resetting
 * to empty - because an empty set re-spawns every prior fork, the exact
 * duplicate-agent outcome the mark-before-spawn design exists to avoid.
 */
const loadHandled = async (parent: SessionPaths): Promise<Set<string>> => {
  let raw: string;
  try {
    raw = await readFile(handledPath(parent), "utf8");
  } catch {
    return new Set(); // absent = first run
  }
  const arr = JSON.parse(raw) as unknown; // a parse error is loud, never swallowed
  if (!Array.isArray(arr)) throw new Error(`corrupt handled.json at ${handledPath(parent)}`);
  return new Set(arr.filter((x): x is string => typeof x === "string"));
};

/** Persist the handled set atomically (temp + rename) so a crash mid-write can
 *  never leave a truncated file that reads back as "nothing handled". */
const saveHandled = async (parent: SessionPaths, handled: Set<string>): Promise<void> => {
  await mkdir(join(parent.sessionDir, "forks"), { recursive: true });
  const target = handledPath(parent);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify([...handled], null, 2)}\n`);
  await rename(tmp, target);
};

/** Deterministic child artifact path: same dir as the parent, keyed by the FULL
 *  sanitized fork id so a re-run never mints a second file for the same fork and
 *  distinct forks never collide onto one path. */
export const childArtifactPath = (parent: SessionPaths, forkId: string): string =>
  join(parent.artifactDir, `${parent.name}-fork-${safeForkId(forkId)}.html`);

const createPrompt = (seedPath: string, artifact: string): string =>
  [
    "You are picking up a spun-off task from a Lucid review.",
    `Read the fork seed at ${seedPath}.`,
    `Author the artifact it describes as a single self-contained HTML file written to exactly ${artifact}.`,
    "Then open it for review by running:",
    `  lucid open ${shellArg(artifact)}`,
    `Write only ${artifact}; do not modify other files.`,
  ].join("\n");

/** The revise instruction for a feedback batch, or null when the batch carries
 *  nothing to act on (e.g. only an approval) - so no caller ever drives an
 *  empty resume turn. Mirrors the signals `runWait` counts as feedback. Shared
 *  with the hub's attend engine: one wording for every headless revise Lucid
 *  drives, launcher or hub. */
export const revisePrompt = (payload: WaitPayload, artifact: string): string | null => {
  const lines: string[] = [];
  // Attachments ride as absolute paths the agent can read. A screenshot with
  // no words is a whole piece of feedback; dropping it turned an image-only
  // item into an empty bullet, or into "nothing to act on".
  const withImages = (text: string, images?: readonly PayloadImage[]): string =>
    images && images.length > 0
      ? `${text}${text ? " " : ""}(images: ${images.map((i) => i.path).join(", ")})`
      : text;
  // One clipped location per anchor. A multi-target annotation lists every
  // spot its note covers; dropping the tail would apply the note to only the
  // first of the places the human pointed at.
  const clip = (t: Anchor): string =>
    (t.kind === "range" ? t.quote.exact : t.snippet).replace(/\s+/g, " ").trim().slice(0, 100);
  for (const a of payload.annotations) {
    const where = (a.targets ?? [a.target]).map(clip).join("; ");
    lines.push(`- ${withImages(a.note, a.images)} (at: ${where})`);
  }
  for (const m of payload.messages) {
    if (m.role !== "human") continue;
    const text = withImages(m.text, m.images);
    if (text) lines.push(`- ${text}`);
  }
  for (const r of payload.reverts ?? []) lines.push(`- revert to v${r.targetVersion}: ${r.why}`);
  for (const q of payload.questions ?? []) {
    if (!q.answered || q.skipped) continue;
    // A re-ask is an instruction, not an answer: the human did not understand.
    // Reading it as an answer delivered their confusion note AS the decision,
    // and a bare one (no note) made the whole turn look non-actionable.
    if (q.unclear) {
      const note = q.answer ? ` They said: "${q.answer}".` : "";
      lines.push(
        `- the question "${q.text}" was UNCLEAR to the human.${note} Ask it again with lucid ask - the same question, shorter and plainer. Do not treat this as an answer.`,
      );
      continue;
    }
    // Chosen options ARE the answer when the human picked rather than typed;
    // reading only the free text silently dropped the whole reply.
    const answer = [...(q.answerOptions ?? []), ...(q.answer ? [q.answer] : [])].join("; ");
    // Pinned regions are part of the answer too - a pin says WHERE the words
    // apply, and a pin alone is a whole answer (pointing instead of typing).
    const pins = q.answerAnchors ?? (q.answerAnchor ? [q.answerAnchor] : []);
    const pinned = pins.length > 0 ? `(pinned: ${pins.map(clip).join("; ")})` : "";
    const said = withImages(answer, q.answerImages);
    if (said || pinned) {
      lines.push(`- answer to "${q.text}": ${[said, pinned].filter(Boolean).join(" ")}`);
    }
  }
  if (lines.length === 0) return null;
  return [
    `Review feedback arrived on ${artifact}. Apply it and save the file (the viewer live-reloads):`,
    ...lines,
    `Edit only ${artifact}.`,
    // The turn is the ONLY party that can know whether this feedback produces
    // an edit or an answer - whoever spawned it delivered the feedback without
    // reading it. This prompt is the whole instruction a driven turn gets, so
    // the skill's version of this line cannot reach it: without this the
    // viewer can never say "Updating the artifact…" truthfully, and says only
    // "Agent responding…" for every turn.
    // shellArg on every command line the agent will paste into a shell: a
    // path with a space otherwise splits into two arguments and the command
    // targets a file that does not exist.
    `First, declare which is coming: \`lucid intent ${shellArg(artifact)} revise\` if you are going to change the file, or \`lucid intent ${shellArg(artifact)} reply\` if you are only answering. Then do the work.`,
    // Same reasoning one level down: only the turn knows WHICH phase it is in,
    // and a long headless revise is otherwise a several-minute spinner with
    // nothing to read. Each report also refreshes the working window, so a
    // long narrated turn cannot go stale mid-edit.
    `As you work, report each phase as you enter it: \`lucid progress ${shellArg(artifact)} --label "<what you are doing, in a few words>"\` - for example "reading the feedback", "rewriting the capabilities table", "verifying the result". The human watches these one-liners while they wait.`,
  ].join("\n");
};

/** Run a recipe argv to completion. Returns the exit code; a spawn that cannot
 *  even start (missing executable -> synchronous throw) returns 127 rather than
 *  throwing, so one bad recipe never crashes the caller. Shared with the hub's
 *  attend engine so both spawners carry the same identity + logging discipline. */
export const runSpawn = async (
  argv: string[],
  cwd: string,
  logFile: string,
  identity?: {
    harness: string;
    sessionId: string;
    model?: string;
    effort?: string;
    /** The hub request that caused this spawn (M1.3): stamped into the child
     *  env so the turn's own hub calls carry the click's id. Absent for a
     *  spawn no request caused (attend's poll) - and then CLEARED, so a
     *  stale inherited id cannot claim the wrong click. */
    requestId?: string;
    /** The TURN this spawn IS (plan 08, D-013). Minted by the caller so it
     *  can name the same turn when it appends the terminator on exit, and
     *  exported so the child's own acks carry it - a turn nobody can name is
     *  a turn nobody can end. Cleared when absent, like requestId. */
    turnId?: string;
  },
): Promise<number> => {
  // The child is its OWN harness session: inheriting the launcher's
  // LUCID_SESSION_ID would stamp the child's events as the parent
  // conversation (D18 misattribution). Model/effort follow the same rule -
  // the child stamps what IT runs (the applied selection), never what the
  // spawning process happened to inherit.
  const env = identity
    ? {
        ...process.env,
        LUCID_HARNESS: identity.harness,
        LUCID_SESSION_ID: identity.sessionId,
        LUCID_MODEL: identity.model,
        LUCID_EFFORT: identity.effort,
        LUCID_REQUEST_ID: identity.requestId,
        LUCID_TURN_ID: identity.turnId,
      }
    : {
        ...process.env,
        LUCID_HARNESS: undefined,
        LUCID_SESSION_ID: undefined,
        LUCID_MODEL: undefined,
        LUCID_EFFORT: undefined,
        LUCID_REQUEST_ID: undefined,
        LUCID_TURN_ID: undefined,
      };
  // The out-log is machine-local (plan 02); its `run/` parent may not exist
  // yet when a fork's create turn spawns. mkdir defensively - idempotent.
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    const proc = Bun.spawn(argv, {
      cwd,
      env,
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
    });
    await proc.exited;
    return proc.exitCode ?? 0;
  } catch {
    return 127; // could not spawn (e.g. executable not found)
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* fd already closed */
    }
  }
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/** Ensure a child artifact has a live viewer (the recipe's agent should have run
 *  `lucid open`; this is the fallback when it did not). No stdout print - the
 *  launcher owns its own output stream. */
const ensureChildOpen = async (childPaths: SessionPaths, browser: boolean): Promise<boolean> => {
  if (await discoverLiveServer(childPaths)) return true;
  if (!(await fileExists(childPaths.artifactPath))) return false;
  await openSession(childPaths);
  await removeServerDescriptor(childPaths);
  spawnServer(childPaths);
  const identity = await waitForServer(childPaths, 8000);
  // The view governs every launch, not only `open`'s (plan 06): a fork spawned
  // from inside a chat app's pane must not pop a window over the human's
  // conversation. The URL is already the solo one here - a fork's child gets
  // its own dedicated server - so only the launch is in question.
  if (identity && wantsBrowserWindow(browser, resolveView(process.env))) {
    openBrowser(`http://127.0.0.1:${identity.port}/__lucid/viewer`);
  }
  return identity !== undefined;
};

const substitutions = (v: {
  id: string;
  seed: string;
  artifact: string;
  cwd: string;
  prompt: string;
}): Partial<Record<RecipeVar, string>> => v;

const createChild = async (
  parent: SessionPaths,
  fork: ForkRecord,
  registry: HarnessRegistry,
  opts: LaunchOptions,
): Promise<CreatedChild> => {
  const log = opts.log ?? stdoutSink;
  const childArtifact = childArtifactPath(parent, fork.id);
  const childPaths = sessionPaths(childArtifact);
  const childSessionId = crypto.randomUUID();
  const { seedPath, forkDir } = await writeForkSeed(parent, fork);
  const harness = (await readLastAttendant(parent))?.harness ?? null;
  const resolved = resolveRecipe(registry, harness ?? undefined);

  if (!resolved) {
    // No recipe for this harness: degrade to the copy-command (D-064), so the
    // human can drive the fork by hand rather than the launcher guessing.
    const cmd = `# no spawn recipe for harness ${harness ?? "(unknown)"} - drive this fork manually:\n# 1) author ${childArtifact} from the seed: ${seedPath}\n# 2) lucid open ${childArtifact}\n`;
    await writeFile(join(forkDir, "COMMAND.txt"), cmd);
    log(
      `fork ${fork.id.slice(0, 8)}: no recipe for "${harness ?? "unknown"}" -> wrote manual command`,
    );
    return { forkId: fork.id, childArtifact, childSessionId, harness, status: "no-recipe" };
  }

  const argv = buildArgv(
    resolved.recipe.spawn,
    substitutions({
      id: childSessionId,
      seed: seedPath,
      artifact: childArtifact,
      cwd: parent.artifactDir,
      prompt: createPrompt(seedPath, childArtifact),
    }),
  );
  const short = safeForkId(fork.id).slice(0, 8);
  log(`fork ${short}: spawning "${resolved.name}" -> ${childArtifact}`);
  const code = await runSpawn(argv, parent.artifactDir, join(forkDir, "run", "create.out.log"), {
    harness: resolved.name,
    sessionId: childSessionId,
  });
  if (code !== 0)
    log(`fork ${short}: create turn exited ${code} (see ${forkDir}/run/create.out.log)`);

  const open = opts.openChild ?? ensureChildOpen;
  if (!(await open(childPaths, opts.openBrowser ?? true))) {
    log(`fork ${short}: agent did not author ${childArtifact}`);
    return { forkId: fork.id, childArtifact, childSessionId, harness, status: "author-failed" };
  }
  log(`fork ${short}: opened ${childPaths.name}`);
  // Shape-C liveness runs for the loop's lifetime; a failure here never aborts
  // the parent watch, but it must be observable rather than silently swallowed.
  void attendChild(childPaths, childSessionId, resolved.recipe, opts, resolved.name).catch((err) =>
    log(`${childPaths.name}: attend loop errored: ${(err as Error).message}`),
  );
  return { forkId: fork.id, childArtifact, childSessionId, harness, status: "created" };
};

/**
 * One pass over the parent's forks: create a child for each not-yet-handled
 * fork. A fork is marked handled BEFORE spawning (idempotency over retry): a
 * duplicate child - two agent runs, two artifacts - is worse than a dropped
 * fork the human can re-request.
 */
export const handleForks = async (
  parent: SessionPaths,
  registry: HarnessRegistry,
  opts: LaunchOptions = {},
): Promise<CreatedChild[]> => {
  const log = opts.log ?? stdoutSink;
  const state = foldLog((await readEvents(parent.logPath)).events);
  const handled = await loadHandled(parent);
  const fresh = state.forks.filter((f) => !handled.has(f.id));
  if (fresh.length === 0) return [];
  // Mark handled before spawning (idempotency over retry), persisted once for
  // the whole batch. Then create concurrently: a slow create must not serialize
  // the batch, and one fork's failure must never abort the others or the watch.
  for (const f of fresh) handled.add(f.id);
  await saveHandled(parent, handled);
  return Promise.all(
    fresh.map((fork) =>
      createChild(parent, fork, registry, opts).catch((err) => {
        log(`fork ${safeForkId(fork.id).slice(0, 8)}: create failed: ${(err as Error).message}`);
        return {
          forkId: fork.id,
          childArtifact: childArtifactPath(parent, fork.id),
          childSessionId: "",
          harness: null,
          status: "author-failed" as const,
        };
      }),
    ),
  );
};

/** Shape-C attend loop for one child: hold the listening presence, re-drive the
 *  same session on each feedback batch, yield to a human who attaches. */
export const attendChild = async (
  child: SessionPaths,
  sessionId: string,
  recipe: SpawnRecipe,
  opts: LaunchOptions,
  harnessName = "agent",
): Promise<void> => {
  const log = opts.log ?? stdoutSink;
  if (!recipe.resume) {
    log(`${child.name}: recipe has no resume argv - forked artifact is one-shot`);
    return;
  }
  // Start from now: a fresh child has no prior feedback to re-apply.
  let cursor = renderCursor(foldLog((await readEvents(child.logPath)).events).highSeq);
  let fails = 0;
  for (;;) {
    if (opts.signal?.aborted) return;
    // Single-attendant: yield the moment a non-launcher harness attends.
    const attendant = await readLastAttendant(child);
    if (attendant && attendant.harness !== LAUNCHER_HARNESS) {
      log(`${child.name}: yielding to "${attendant.harness}" (human attached)`);
      return;
    }
    let payload: WaitPayload;
    try {
      payload = await runWait(child, { since: cursor, timeoutMs: 30_000 });
    } catch {
      return; // session gone
    }
    if (payload.status === "ended" || payload.status === "suspended") {
      log(`${child.name}: ${payload.status}, stopping attend`);
      return;
    }
    if (payload.status !== "feedback") {
      cursor = payload.nextCursor; // version-only / waiting: advance and re-block
      continue;
    }
    if (payload.reviewResolved) {
      log(`${child.name}: review approved, stopping attend`);
      return;
    }
    // Re-check ownership right before driving: a human who attached while we were
    // blocked in wait must preempt THIS batch, not only the next. An advisory
    // sidecar can't lock, but re-checking here closes the common race window; do
    // NOT advance the cursor, so the human owns the unconsumed batch.
    const owner = await readLastAttendant(child);
    if (owner && owner.harness !== LAUNCHER_HARNESS) {
      log(`${child.name}: yielding to "${owner.harness}" before driving batch`);
      return;
    }
    const prompt = revisePrompt(payload, child.artifactPath);
    if (prompt === null) {
      cursor = payload.nextCursor; // feedback with nothing to apply: skip the turn
      continue;
    }
    await writeAttendantSidecar(child, {
      harness: LAUNCHER_HARNESS,
      nextCursor: payload.nextCursor,
      at: new Date().toISOString(),
    });
    // What this turn takes delivery of (D20) - the batch just read, not
    // whatever has landed by the time the ack appends.
    const covers = parseCursor(payload.nextCursor);
    await deliver(child, {
      t: "agent_ack",
      id: crypto.randomUUID(),
      // No intent, same reason as the hub's ack: an order to revise is not an
      // outcome, and the turn declares what it is actually doing.
      ...(covers !== undefined ? { covers } : {}),
      // The CHILD session's identity (D18): the launcher acts on its behalf.
      attendant: { harness: harnessName, sessionId, cwd: child.artifactDir },
    }).catch(() => {});
    const argv = buildArgv(recipe.resume, {
      id: sessionId,
      artifact: child.artifactPath,
      cwd: child.artifactDir,
      prompt,
    });
    log(`${child.name}: applying feedback via resume`);
    const code = await runSpawn(argv, child.artifactDir, join(child.sessionDir, "revise.out.log"), {
      harness: harnessName,
      sessionId,
    });
    // Consume the batch (advance the cursor) only on a clean turn, so a failed
    // resume is retried rather than silently dropping the feedback. Bounded, so a
    // persistently broken recipe can't spin forever.
    if (code === 0) {
      cursor = payload.nextCursor;
      fails = 0;
      continue;
    }
    fails += 1;
    if (fails >= MAX_RESUME_FAILS) {
      log(`${child.name}: resume failed ${fails}x (exit ${code}); giving up on this batch`);
      cursor = payload.nextCursor;
      fails = 0;
    } else {
      log(`${child.name}: resume exited ${code} (attempt ${fails}); will retry the batch`);
    }
  }
};

/** The foreground launcher loop: poll the parent for forks until the parent
 *  session ends or the signal aborts. */
export const runLaunch = async (
  parent: SessionPaths,
  registry: HarnessRegistry,
  opts: LaunchOptions = {},
): Promise<void> => {
  const log = opts.log ?? stdoutSink;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  log(`launcher watching ${parent.name} for forks (Ctrl-C to stop)`);
  for (;;) {
    if (opts.signal?.aborted) return;
    const state = foldLog((await readEvents(parent.logPath)).events);
    if (state.status === "ended") {
      log(`${parent.name}: session ended, launcher stopping`);
      return;
    }
    await handleForks(parent, registry, opts);
    await new Promise((r) => setTimeout(r, pollMs));
  }
};
