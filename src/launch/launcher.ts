import { stdoutSink } from "../server/observe.ts";
import { closeSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import {
  classifyObservedIdentity,
  classifySessionFailure,
  classifySpawnResult,
  mintLaunchId,
  SessionIdentityDecoder,
  type NativeSessionIdentity,
  type SessionIdentityRecipe,
  type SpawnResult,
} from "./session-identity.ts";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Anchor } from "../anchors/anchor.ts";
import {
  mergeAttendantSidecar,
  readLastAttendant,
  recordPendingIdentity,
  recordSessionInvalidation,
  type Attendant,
} from "../core/attendant.ts";
import { parseCursor, renderCursor } from "../core/cursor.ts";
import { deliver, promotePendingBindings } from "../core/deliver.ts";
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
  requireSessionIdentity,
  resolveRecipe,
  registryPath,
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

/** What a spawner tells runSpawn about the launch's identity arrangement. */
export interface SpawnIdentity {
  readonly harness: string;
  /** The id Lucid assigns (caller-assigned recipes) or the parent-known id a
   *  legacy recipe still exports. Discovered recipes leave it unset - the
   *  harness mints its own and announces it on stdout. */
  readonly sessionId?: string;
  readonly model?: string;
  readonly effort?: string;
  /** The hub request that caused this spawn (M1.3): stamped into the child
   *  env so the turn's own hub calls carry the click's id. Absent for a
   *  spawn no request caused (attend's poll) - and then CLEARED, so a
   *  stale inherited id cannot claim the wrong click. */
  readonly requestId?: string;
  /** The TURN this spawn IS (plan 08, D-013). Minted by the caller so it
   *  can name the same turn when it appends the terminator on exit, and
   *  exported so the child's own acks carry it - a turn nobody can name is
   *  a turn nobody can end. Cleared when absent, like requestId. */
  readonly turnId?: string;
  /** The hub doing the spawning (plan 08, finding #21). The create prompt
   *  ends by telling the turn to run `lucid open`, and `open` finds a hub
   *  through LUCID_HUB_PORT - so a hub anywhere but the default port spawned
   *  turns that opened their artifact into whatever else was listening
   *  there. Left ALONE when absent: not every spawner is a hub, and
   *  inventing a port would route a turn at one that does not exist. */
  readonly hubPort?: number;
  /** Lucid-owned correlation for THIS launch (plan 03): exported as
   *  LUCID_LAUNCH_ID so the child's stamps carry it, and required before any
   *  discovered identity can be persisted against the launch that found it.
   *  Never enters resume argv - correlation, not identity. */
  readonly launchId?: string;
  /** How this harness establishes native identity. Absent = legacy recipe:
   *  no discovery, no authority export, the pre-identity env behavior. */
  readonly strategy?: SessionIdentityRecipe;
  /** Called on the FIRST valid identity announcement while the child is
   *  still running, so discovery can be persisted before the turn ends. */
  readonly onIdentityDiscovered?: (identity: NativeSessionIdentity) => void | Promise<void>;
}

/**
 * How long a spawned turn may produce NOTHING before it is treated as wedged.
 *
 * A turn has no natural deadline - real work runs for minutes - so this bounds
 * silence, not duration. A child writing progress, prose or errors is alive
 * whatever its clock says; one that has written nothing at all for this long
 * is not coming back, and the artifact it holds cannot start another turn
 * until it stops.
 */
export interface SpawnDeadline {
  /** Milliseconds of NO output before the child is killed. */
  readonly idleMs: number;
}

/**
 * Kill a child that has gone silent for `idleMs`.
 *
 * Silence is measured off the OUT-LOG, not the parent's stdout tap: a
 * caller-assigned harness writes straight to the log fd, so the parent never
 * sees a chunk and has nothing else to measure. The file's size is the one
 * signal both arrangements share.
 *
 * This exists because a wedged child holds its artifact forever. `runSpawn`
 * awaited `proc.exited` with no bound, and the attend engine treats a live
 * child as a delivery in flight - so one hung process silently queued every
 * later piece of feedback behind it, with the panel still reporting an older
 * turn as though it were the live one. Measured on a real session: 53 minutes,
 * no output, six pieces of feedback undelivered.
 */
const watchForStall = (
  proc: { readonly kill: (signal?: number) => void },
  logFile: string,
  deadline: SpawnDeadline | undefined,
): { readonly stop: () => void } => {
  if (!deadline || deadline.idleMs <= 0) return { stop: () => {} };
  const sizeOf = (): number => {
    try {
      return statSync(logFile).size;
    } catch {
      return -1;
    }
  };
  let lastSize = sizeOf();
  let lastChangeAt = Date.now();
  // Checked several times per window rather than once at the end: the point is
  // to notice silence promptly, not to add a second timeout of its own.
  const every = Math.max(1_000, Math.floor(deadline.idleMs / 4));
  const timer = setInterval(() => {
    const size = sizeOf();
    if (size !== lastSize) {
      lastSize = size;
      lastChangeAt = Date.now();
      return;
    }
    if (Date.now() - lastChangeAt < deadline.idleMs) return;
    clearInterval(timer);
    // SIGTERM, as a human would: the child gets its chance to flush and exit,
    // and the exit classification below reports the turn as failed either way.
    proc.kill();
  }, every);
  // The interval must not hold the process open when nothing else is pending.
  (timer as unknown as { unref?: () => void }).unref?.();
  return { stop: () => clearInterval(timer) };
};

/** Run a recipe argv to completion, typed. A spawn that cannot even start
 *  (missing executable -> synchronous throw) is `spawn-failed` rather than a
 *  throw, so one bad recipe never crashes the caller. Shared by the fork
 *  launcher, the hub's create, and the attend engine so every spawner carries
 *  the same identity + logging discipline. */
export const runSpawn = async (
  argv: string[],
  cwd: string,
  logFile: string,
  identity?: SpawnIdentity,
  deadline?: SpawnDeadline,
): Promise<SpawnResult> => {
  const discovered = identity?.strategy?.source === "stdout-jsonl";
  // The child is its OWN harness session: inheriting the launcher's
  // LUCID_SESSION_ID would stamp the child's events as the parent
  // conversation (D18 misattribution). Model/effort follow the same rule -
  // the child stamps what IT runs (the applied selection), never what the
  // spawning process happened to inherit. A DISCOVERED harness goes one
  // further: even a caller-supplied id is cleared, because the harness mints
  // its own and a pre-minted UUID in the child's env is exactly the synthetic
  // identity that poisoned resume.
  const env = identity
    ? {
        ...process.env,
        LUCID_HARNESS: identity.harness,
        LUCID_SESSION_ID: discovered ? undefined : identity.sessionId,
        LUCID_SESSION_ID_AUTHORITY:
          !discovered && identity.strategy && identity.sessionId ? "assigned" : undefined,
        LUCID_LAUNCH_ID: identity.launchId,
        LUCID_MODEL: identity.model,
        LUCID_EFFORT: identity.effort,
        LUCID_REQUEST_ID: identity.requestId,
        LUCID_TURN_ID: identity.turnId,
        // Set, not defaulted: an inherited value is another hub's address, and
        // a turn that opens its artifact into somebody else's hub is the
        // failure this closes. Absent means "no hub spawned me", so whatever
        // the environment says stands.
        ...(identity.hubPort !== undefined ? { LUCID_HUB_PORT: String(identity.hubPort) } : {}),
      }
    : {
        ...process.env,
        LUCID_HARNESS: undefined,
        LUCID_SESSION_ID: undefined,
        LUCID_SESSION_ID_AUTHORITY: undefined,
        LUCID_LAUNCH_ID: undefined,
        LUCID_MODEL: undefined,
        LUCID_EFFORT: undefined,
        LUCID_REQUEST_ID: undefined,
        LUCID_TURN_ID: undefined,
      };
  // The out-log is machine-local (plan 02); its `run/` parent may not exist
  // yet when a fork's create turn spawns. mkdir defensively - idempotent.
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  let observed: NativeSessionIdentity | undefined;
  let callbackDone: Promise<void> | undefined;
  // Wrapped so a SYNCHRONOUS throw from the callback is a settled rejection
  // (Promise.resolve(fn()) would let it escape into the tee loop), and so the
  // swallow is in one place.
  const fireDiscovery = (found: NativeSessionIdentity): void => {
    observed = found;
    callbackDone = (async () => identity?.onIdentityDiscovered?.(found))()
      .then(() => undefined)
      .catch(() => {});
  };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd,
      env,
      stdin: "ignore",
      // Discovery taps stdout THROUGH the parent: the same bytes continue to
      // the log fd untouched, chunk boundaries and all. Stderr stays wired
      // straight to the log - it is logged evidence, never identity.
      stdout: discovered ? "pipe" : fd,
      stderr: fd,
    });
  } catch {
    // ONLY a spawn that could not start (missing executable) is spawn-failed:
    // this catch is deliberately narrow, because labeling a mid-stream error
    // "spawn-failed" told the caller to retry against a child that was still
    // running - two concurrent turns driving one conversation.
    try {
      closeSync(fd);
    } catch {
      /* fd already closed */
    }
    return { code: 127, status: "spawn-failed" };
  }
  try {
    if (discovered && identity?.strategy?.source === "stdout-jsonl" && proc.stdout) {
      try {
        const decoder = new SessionIdentityDecoder(identity.harness, identity.strategy);
        const text = new TextDecoder();
        for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
          writeSync(fd, chunk);
          if (observed) continue; // first announcement wins; the rest is output
          // stream:true so a multibyte character split across chunks decodes
          // whole instead of as replacement bytes inside a JSONL line.
          for (const event of decoder.push(text.decode(chunk, { stream: true }))) {
            if (!observed) fireDiscovery(event.identity);
          }
        }
        if (!observed) {
          const event = decoder.finish()[0];
          if (event) fireDiscovery(event.identity);
        }
      } catch {
        // The TEE broke (out-log ENOSPC, stream error) - not the child. The
        // child cannot be left running with nobody draining its stdout: kill
        // it, and let the exit classification below tell the truth about a
        // turn this parent had to abandon.
        proc.kill();
      }
    }
    const stalled = watchForStall(proc, logFile, deadline);
    await proc.exited;
    stalled.stop();
    // The callback's work is bounded elsewhere too (sidecar locks time out),
    // but its HTTP leg is not - and a wedged hub must not wedge every future
    // turn of this session behind an await that cannot settle.
    if (callbackDone) {
      await Promise.race([callbackDone, new Promise((r) => setTimeout(r, 10_000))]);
    }
    // A signal-killed child has no exit code; it is anything but clean.
    const code = proc.exitCode ?? (proc.signalCode !== null ? 1 : 0);
    if (identity?.strategy) return classifySpawnResult(code, identity.strategy, observed);
    // Legacy recipe: no declaration, no discovery - a clean exit is complete
    // (nothing was promised), a bad one is a process failure.
    return code === 0 ? { code: 0, status: "completed" } : { code, status: "process-failed" };
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* fd already closed */
    }
  }
};

/**
 * The ONE discovery-persistence callback (plan 03, M3): every spawner that
 * taps stdout hands runSpawn this, so what happens to an announced identity
 * cannot differ by call site. A CREATE launch takes whatever arrives; a
 * RESUME launch guards with the mismatch policy first - an announcement that
 * names a DIFFERENT session than requested is HSI005, and binding it would
 * attach the review to a conversation that never saw the artifact. The
 * refusal is silent here; the failure surface (warning codes, quarantine)
 * is the recovery milestone's.
 */
export const discoveryPersistence =
  (
    target: SessionPaths,
    harness: string,
    launchId: string,
    guard?: { readonly requestedSessionId: string; readonly allowRotation: boolean },
  ): ((identity: NativeSessionIdentity) => Promise<void>) =>
  async (identity) => {
    if (guard) {
      const outcome = classifyObservedIdentity(
        guard.requestedSessionId,
        identity,
        guard.allowRotation,
      );
      if (outcome.status === "mismatch") return;
    }
    await recordPendingIdentity(target, {
      harness,
      sessionId: identity.sessionId,
      sessionIdAuthority: identity.authority,
      launchId,
    });
    // Promotion is live-aware and idempotent: if the session is already open
    // the binding lands NOW through the locked path; if not, the sidecar
    // keeps owing it and the child's own `lucid open` promotes.
    await promotePendingBindings(target).catch(() => {});
  };

/**
 * The ONE spawn-identity setup (plan 03, M3): resolve the adapter's declared
 * strategy (HSI001 before any process exists when there is none), mint the
 * launch correlation, assign the native id when the strategy is
 * caller-assigned, and bind the persistence callback that records discovered
 * identity against the target session. Fork create and hub create ride it
 * whole; the resume paths (attend, child revise) mint per-turn launches but
 * share `discoveryPersistence`, so the part that can poison a record - what
 * happens to an announced identity - has exactly one implementation.
 */
export const prepareSpawnIdentity = (
  harness: string,
  recipe: SpawnRecipe | undefined,
  registryFile: string,
): {
  readonly launchId: string;
  readonly strategy: SessionIdentityRecipe;
  /** The `{id}` argv substitution for caller-assigned strategies; discovered
   *  harnesses mint their own and get none from us. */
  readonly assignedSessionId?: string;
  /** The runSpawn identity for a launch targeting `target`, with discovery
   *  persistence wired: an announced identity lands in the target's sidecar
   *  (pending) and is promoted through the locked path immediately - the
   *  sidecar knows before the turn can end. */
  readonly identityFor: (target: SessionPaths, extra?: Partial<SpawnIdentity>) => SpawnIdentity;
  /** Record a caller-assigned identity as pending against the target BEFORE
   *  spawning - it is known already, and a child that crashes pre-open must
   *  still leave a resumable record. No-op for discovered strategies. */
  readonly recordAssigned: (target: SessionPaths) => Promise<void>;
} => {
  const strategy = requireSessionIdentity(harness, recipe, registryFile);
  const launchId = mintLaunchId();
  const assignedSessionId = strategy.source === "caller-assigned" ? crypto.randomUUID() : undefined;
  const identityFor = (target: SessionPaths, extra?: Partial<SpawnIdentity>): SpawnIdentity => ({
    harness,
    launchId,
    strategy,
    ...(assignedSessionId ? { sessionId: assignedSessionId } : {}),
    onIdentityDiscovered: discoveryPersistence(target, harness, launchId),
    ...extra,
  });
  /** An ASSIGNED identity is known before the process exists: record it
   *  pending immediately, so even a child that crashes pre-open leaves a
   *  resumable record - and the same promotion path lands its binding. */
  const recordAssigned = async (target: SessionPaths): Promise<void> => {
    if (!assignedSessionId) return;
    await recordPendingIdentity(target, {
      harness,
      sessionId: assignedSessionId,
      sessionIdAuthority: "assigned",
      launchId,
    });
  };
  return {
    launchId,
    strategy,
    ...(assignedSessionId ? { assignedSessionId } : {}),
    identityFor,
    recordAssigned,
  };
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

  const spawnIdentity = prepareSpawnIdentity(resolved.name, resolved.recipe, registryPath());
  const argv = buildArgv(
    resolved.recipe.spawn,
    substitutions({
      // Caller-assigned recipes take the id Lucid minted; discovered recipes
      // declared no {id} in spawn (the registry validated that), so the empty
      // substitution never lands in an argv.
      id: spawnIdentity.assignedSessionId ?? "",
      seed: seedPath,
      artifact: childArtifact,
      cwd: parent.artifactDir,
      prompt: createPrompt(seedPath, childArtifact),
    }),
    resolved.recipe.tools,
  );
  const short = safeForkId(fork.id).slice(0, 8);
  log(`fork ${short}: spawning "${resolved.name}" -> ${childArtifact}`);
  await spawnIdentity.recordAssigned(childPaths);
  const result = await runSpawn(
    argv,
    parent.artifactDir,
    join(forkDir, "run", "create.out.log"),
    spawnIdentity.identityFor(childPaths),
  );
  if (result.code !== 0) {
    log(`fork ${short}: create turn exited ${result.code} (see ${forkDir}/run/create.out.log)`);
  } else if (result.status === "identity-missing") {
    // The artifact (if authored) survives; the launch is simply not resumable
    // (HSI002) - said HERE, where the launch record is, not discovered later
    // as a resume that starts a stranger.
    log(`fork ${short}: turn completed but announced no session identity (HSI002)`);
  }

  const open = opts.openChild ?? ensureChildOpen;
  if (!(await open(childPaths, opts.openBrowser ?? true))) {
    log(`fork ${short}: agent did not author ${childArtifact}`);
    return { forkId: fork.id, childArtifact, childSessionId, harness, status: "author-failed" };
  }
  log(`fork ${short}: opened ${childPaths.name}`);
  // The child's `lucid open` ran mid-turn, possibly before discovery fired:
  // promote anything still pending now that the log exists.
  await promotePendingBindings(childPaths).catch(() => {});
  // The id the attend loop resumes: assigned, or whatever the harness
  // announced. Neither means one-shot - the loop refuses to resume nothing.
  const resumableId =
    spawnIdentity.assignedSessionId ??
    ("identity" in result ? result.identity?.sessionId : undefined);
  if (resumableId) {
    // Shape-C liveness runs for the loop's lifetime; a failure here never
    // aborts the parent watch, but it must be observable rather than
    // silently swallowed.
    void attendChild(childPaths, resumableId, resolved.recipe, opts, resolved.name).catch((err) =>
      log(`${childPaths.name}: attend loop errored: ${(err as Error).message}`),
    );
  } else {
    log(`${childPaths.name}: no native identity to resume - artifact is one-shot`);
  }
  return {
    forkId: fork.id,
    childArtifact,
    childSessionId: resumableId ?? "",
    harness,
    status: "created",
  };
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

/**
 * Has somebody OTHER than this launcher taken delivery of the child?
 *
 * `nextCursor` is what makes a sidecar an ATTENDANCE record: it says a reader
 * consumed the log up to a point. A sidecar without one is an identity record
 * - the launcher's own `recordAssigned`/discovery write, naming the harness it
 * is about to spawn - and reading that as "a human attached" made the loop
 * yield to itself on its first pass, leaving every forked artifact one-shot.
 */
export const attendedByAnother = (attendant: Attendant): boolean =>
  attendant.nextCursor !== undefined && attendant.harness !== LAUNCHER_HARNESS;

/** Shape-C attend loop for one child: hold the listening presence, re-drive the
 *  same session on each feedback batch, yield to a human who attaches. */
export const attendChild = async (
  child: SessionPaths,
  initialSessionId: string,
  recipe: SpawnRecipe,
  opts: LaunchOptions,
  harnessName = "agent",
): Promise<void> => {
  const log = opts.log ?? stdoutSink;
  if (!recipe.resume) {
    log(`${child.name}: recipe has no resume argv - forked artifact is one-shot`);
    return;
  }
  // Reassignable: an ALLOWED rotation moves the loop to the thread the
  // harness announced, so later turns resume what actually exists.
  let sessionId = initialSessionId;
  // Start from now: a fresh child has no prior feedback to re-apply.
  let cursor = renderCursor(foldLog((await readEvents(child.logPath)).events).highSeq);
  let fails = 0;
  for (;;) {
    if (opts.signal?.aborted) return;
    // Single-attendant: yield the moment a non-launcher harness attends.
    const attendant = await readLastAttendant(child);
    if (attendant && attendedByAnother(attendant)) {
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
    if (owner && attendedByAnother(owner)) {
      log(`${child.name}: yielding to "${owner.harness}" before driving batch`);
      return;
    }
    const prompt = revisePrompt(payload, child.artifactPath);
    if (prompt === null) {
      cursor = payload.nextCursor; // feedback with nothing to apply: skip the turn
      continue;
    }
    await mergeAttendantSidecar(child, {
      harness: LAUNCHER_HARNESS,
      nextCursor: payload.nextCursor,
      at: new Date().toISOString(),
    });
    // What this turn takes delivery of (D20) - the batch just read, not
    // whatever has landed by the time the ack appends.
    const covers = parseCursor(payload.nextCursor);
    // Named so the terminator below can close THIS turn (D-013): an ack whose
    // turn nobody can name is a working window nobody can close.
    const reviseTurnId = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await deliver(child, {
      t: "agent_ack",
      id: crypto.randomUUID(),
      turnId: reviseTurnId,
      // No intent, same reason as the hub's ack: an order to revise is not an
      // outcome, and the turn declares what it is actually doing.
      ...(covers !== undefined ? { covers } : {}),
      // The CHILD session's identity (D18): the launcher acts on its behalf.
      attendant: { harness: harnessName, sessionId, cwd: child.artifactDir },
    }).catch(() => {});
    const argv = buildArgv(
      recipe.resume,
      {
        id: sessionId,
        artifact: child.artifactPath,
        cwd: child.artifactDir,
        prompt,
      },
      recipe.tools,
    );
    log(`${child.name}: applying feedback via resume`);
    // Every resume turn is its OWN launch: fresh correlation, the recipe's
    // declared strategy, and guarded discovery persistence - a resume that
    // announces the SAME thread re-binds under this launch; one that names a
    // stranger is refused (HSI005), never adopted.
    const reviseLaunchId = mintLaunchId();
    // Where THIS run's output starts: the log is opened in append mode, so
    // classifying the whole file would let an earlier turn's not-found banner
    // durably quarantine a live session (the hub slices for the same reason).
    const reviseLog = join(child.sessionDir, "revise.out.log");
    const outputFrom = await stat(reviseLog).then(
      (st) => st.size,
      () => 0,
    );
    const allowRotation =
      recipe.sessionIdentity?.source === "stdout-jsonl" &&
      recipe.sessionIdentity.allowRotation === true;
    const result = await runSpawn(argv, child.artifactDir, reviseLog, {
      harness: harnessName,
      sessionId,
      launchId: reviseLaunchId,
      ...(recipe.sessionIdentity ? { strategy: recipe.sessionIdentity } : {}),
      onIdentityDiscovered: discoveryPersistence(child, harnessName, reviseLaunchId, {
        requestedSessionId: sessionId,
        allowRotation,
      }),
    });
    const code = result.code;
    // The same three identity rules the hub's attend engine applies, because
    // a child driven here and an artifact attended there must not disagree
    // about what a harness said (plan 03, D-012).
    const announced = "identity" in result ? result.identity?.sessionId : undefined;
    /** The turn is over, whatever it produced: the claim this loop made must
     *  not outlive it. Without a terminator the batch sits marked delivered
     *  with nothing to show for it, which is what the hub's own turn-ended
     *  append exists to prevent. */
    const endTurn = async (reason: "failed", code_: string): Promise<void> => {
      await deliver(child, {
        t: "agent_turn_ended",
        turnId: reviseTurnId,
        reason,
        code: code_,
        attendant: { harness: harnessName, sessionId, cwd: child.artifactDir },
      }).catch(() => {});
    };
    if (announced && announced !== sessionId && !allowRotation) {
      // HSI005: a different conversation answered. Do not bind, do not
      // invalidate, do not advance - the feedback stays the human's.
      await endTurn("failed", "hsi005_session_mismatch");
      log(`${child.name}: resume announced a different session (HSI005); stopping this batch`);
      return;
    }
    if (code !== 0) {
      // THIS run's output only, sliced like the hub's.
      const runOutput = (await readFile(reviseLog, "utf8").catch(() => "")).slice(outputFrom);
      if (classifySessionFailure(harnessName, runOutput) === "HSI004") {
        // A verdict, not a flake: quarantine the id durably and stop driving
        // this child - there is no second candidate to try down here.
        await recordSessionInvalidation(child, harnessName, sessionId).catch(() => {});
        await endTurn("failed", "hsi004_session_not_found");
        log(`${child.name}: harness says session ${sessionId} does not exist here (HSI004)`);
        return;
      }
    }
    if (announced && announced !== sessionId && allowRotation) {
      // An allowed rotation: the loop follows the harness to its new thread.
      sessionId = announced;
    }
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
