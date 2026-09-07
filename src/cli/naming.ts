import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHcnRunner } from "../harness/hcn-runner.js";
import { nodeHarnessDeps } from "../harness/node-deps.js";
import { createHubSettings } from "../server/hub-settings.js";
import { runNamingJob } from "../server/naming-worker.js";
import { atomicSidecar } from "../store/atomic-file.js";
import { namingJob, pendingNamingJob } from "../store/conversation-naming.js";
import { DiscoveryIndex } from "../store/discovery.js";
import { pathsForDir } from "../store/errors.js";
import { acquireAppendLock, LockError } from "../store/flock.js";
import { recoverConversationNaming } from "../store/log.js";
import { readRecordMetadata } from "../store/record-identity.js";
import { LUCID_RECORD_DIR, LUCID_TURN_ID, selfInvocation } from "./record-addressing.js";

const wakePath = (root: string): string => join(root, ".naming-wake");
const wakeVersion = (root: string): string => {
  try {
    return readFileSync(wakePath(root), "utf8");
  } catch {
    return "";
  }
};

/** A durable wake hint and a detached coordinator, never a model in the submitting process. */
export function requestNaming(root: string): void {
  try {
    mkdirSync(root, { recursive: true });
    atomicSidecar(wakePath(root), crypto.randomUUID());
    const [binary, ...args] = selfInvocation(["_name-titles", root]);
    if (!binary) return;
    const env: NodeJS.ProcessEnv = { ...process.env, LUCID_ROOT: root };
    delete env[LUCID_RECORD_DIR];
    delete env[LUCID_TURN_ID];
    const child = spawn(binary, args, {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Submission already owns a durable marker. A later wake or server restart retries discovery.
  }
}

/** One coordinator per root, at most two isolated jobs, and no standing idle daemon. */
export async function runNamingWorker(root: string): Promise<void> {
  let lock: ReturnType<typeof acquireAppendLock>;
  try {
    lock = acquireAppendLock(join(root, ".naming-worker"), { timeoutMs: 0 });
  } catch (error) {
    if (error instanceof LockError && error.code === "lock-timeout") return;
    throw error;
  }
  let observed = wakeVersion(root);
  try {
    const runner = createHcnRunner(nodeHarnessDeps());
    const settings = createHubSettings(root, undefined, runner, true);
    const index = new DiscoveryIndex(root);
    const recoveryPath = join(root, ".naming-recovery");
    const recovered = new Map<string, string>();
    try {
      const saved: unknown = JSON.parse(readFileSync(recoveryPath, "utf8"));
      if (Array.isArray(saved))
        for (const entry of saved) {
          if (
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === "string" &&
            typeof entry[1] === "string"
          )
            recovered.set(entry[0], entry[1]);
        }
    } catch {
      /* Derived cache is safe to rebuild. */
    }
    let scanNeeded = true;
    let idleUntil = Date.now() + 3000;
    do {
      const wake = wakeVersion(root);
      if (wake !== observed) {
        observed = wake;
        idleUntil = Date.now() + 3000;
        scanNeeded = true;
      }
      if (!scanNeeded) {
        await Bun.sleep(250);
        continue;
      }
      scanNeeded = false;
      const records = index.scan().records;
      const present = new Set(records.map((record) => record.dir));
      let recoveryChanged = false;
      for (const dir of recovered.keys())
        if (!present.has(dir)) {
          recovered.delete(dir);
          recoveryChanged = true;
        }
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(2, records.length) }, async () => {
          for (;;) {
            const record = records[next++];
            if (!record) return;
            try {
              let meta = index.scannedMetadata(record.dir);
              if (!meta) continue;
              if (
                (meta.titleRevision === undefined && meta.conversationTitle === undefined) ||
                namingJob(meta)?.status === "waiting-input"
              ) {
                const log = statSync(pathsForDir(record.dir).logPath);
                const fingerprint = [log.dev, log.ino, log.size, log.mtimeMs, log.ctimeMs].join(
                  ":",
                );
                if (recovered.get(record.dir) !== fingerprint) {
                  await recoverConversationNaming(record.dir, record.conversationId);
                  recovered.set(record.dir, fingerprint);
                  recoveryChanged = true;
                  meta = readRecordMetadata(record.dir);
                }
              }
              const before = pendingNamingJob(meta);
              if (!before) continue;
              await runNamingJob(
                record.dir,
                record.conversationId,
                runner,
                async () => (await settings.project(record.dir)).conversationSettings.selected,
              );
              const after = pendingNamingJob(readRecordMetadata(record.dir));
              if (after?.status === "repair" && after.attempts > before.attempts) scanNeeded = true;
            } catch {
              // A damaged or disappearing record cannot stop the other jobs.
            }
          }
        }),
      );
      if (recoveryChanged) atomicSidecar(recoveryPath, [...recovered]);
      if (scanNeeded) idleUntil = Date.now() + 3000;
      if (Date.now() < idleUntil) await Bun.sleep(250);
    } while (Date.now() < idleUntil);
  } finally {
    lock.release();
    // Close the wake/exit race: a wake before release is retried here; one after it starts a successor.
    if (wakeVersion(root) !== observed) requestNaming(root);
  }
}
