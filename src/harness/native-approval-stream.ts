import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventKind } from "../protocol/events.js";
import { parseApprovalDecision } from "../protocol/native-approval-codec.js";
import type { HarnessEvent } from "./events.js";
import { decodeHarnessLine } from "./events.js";
import type { HarnessDeps, HcnProcess } from "./process.js";
import { flag, lines, terminateHcn } from "./process.js";
import type { NativeApprovalEvents, StreamTurnOptions } from "./runner.js";
import { HarnessRefusal } from "./runner.js";

class ApprovalChannelError extends Error {
  readonly code = "approval-channel-lost";
}

/** One owned HCN process; native RPCs and permission interpretation remain inside HCN. */
export function nativeApprovalStream(
  deps: HarnessDeps,
  opts: StreamTurnOptions,
  project: (event: HarnessEvent) => HarnessEvent,
): AsyncIterable<HarnessEvent> {
  const approval = opts.nativeApprovals;
  if (
    !approval ||
    !opts.resume ||
    !opts.cwd ||
    opts.model !== undefined ||
    opts.effort !== undefined ||
    opts.provider !== undefined ||
    opts.isolation !== undefined
  )
    throw new HarnessRefusal(
      "invalid-native-approval-turn",
      "Native approval continuation requires its saved session, folder and fingerprint without setting overrides.",
    );
  const { cwd, resume } = opts;
  let started = false;
  return {
    async *[Symbol.asyncIterator]() {
      if (started)
        throw new HarnessRefusal(
          "native-turn-already-started",
          "This native turn already started.",
        );
      started = true;
      const dir = mkdtempSync(join(tmpdir(), "lucid-native-prompt-"));
      const path = join(dir, "prompt.txt");
      let proc: HcnProcess | undefined;
      let receiver: NativeApprovalEvents | undefined;
      let live = false;
      let cancelled = false;
      let drained = false;
      let termination: Promise<void> | undefined;
      const terminate = (): void => {
        cancelled = true;
        live = false;
        const child = proc;
        if (!child) return;
        termination ??= (async () => {
          const grace = deps.refusalGraceMs ?? 12_000;
          await terminateHcn(child, grace);
          // An escalation deadline is not process-exit evidence. Keep the
          // owning source and its executor lease until this process is reaped.
          await child.exited;
          child.disposeOutput();
        })();
      };
      try {
        if (opts.signal?.aborted) throw new HarnessRefusal("aborted", "The turn was canceled");
        writeFileSync(path, opts.prompt, { encoding: "utf8", flag: "wx", mode: 0o600 });
        receiver = approval.connect({
          alive: () => live && !opts.signal?.aborted,
          cancel: terminate,
          answer: (decision) => {
            const parsed = parseApprovalDecision(decision);
            const child = proc;
            if (!child || !live || opts.signal?.aborted || !parsed)
              throw new ApprovalChannelError("The native answer channel is unavailable.");
            try {
              child.write(`${JSON.stringify({ ...parsed, op: "approval", v: 1 })}\n`);
            } catch (cause) {
              terminate();
              throw new ApprovalChannelError("Native answer submission failed.", { cause });
            }
          },
        });
        if (cancelled || opts.signal?.aborted)
          throw new HarnessRefusal("aborted", "The turn was canceled before process creation");
        const child = deps.spawn(
          [
            deps.bin,
            "run",
            opts.harness,
            "--json",
            "--native-approvals",
            "--resume",
            resume,
            "--cwd",
            cwd,
            "--native-settings-fingerprint",
            approval.fingerprint,
            ...flag(
              "--timeout",
              opts.timeoutSeconds === undefined ? undefined : String(opts.timeoutSeconds),
            ),
            "--prompt-file",
            path,
          ],
          { cwd },
        );
        proc = child;
        live = true;
        deps.log?.({ event: "hcn_run", harness: opts.harness, turnId: opts.turnId });
        opts.signal?.addEventListener("abort", terminate, { once: true });
        if (opts.signal?.aborted) terminate();
        void child.inputError?.then(terminate);
        void child.exited.then(
          () => {
            live = false;
          },
          () => {
            live = false;
          },
        );
        const stderr = (async () => {
          for await (const _chunk of child.stderr) {
          }
        })().catch(() => {});
        for await (const line of lines(child.stdout)) {
          const event = decodeHarnessLine(line);
          if (!event) continue;
          if (
            event.kind === EventKind.approvalRequest ||
            event.kind === EventKind.approvalDisposition ||
            event.kind === EventKind.approvalCleared
          )
            receiver.event(event);
          else yield project(event);
        }
        await child.exited;
        await stderr;
        drained = true;
      } finally {
        live = false;
        opts.signal?.removeEventListener("abort", terminate);
        try {
          if (!drained) terminate();
          await termination;
        } finally {
          try {
            receiver?.closed();
          } finally {
            proc?.disposeOutput();
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    },
  };
}
