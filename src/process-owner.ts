import { readFileSync, readlinkSync } from "node:fs";
import type { ProcessOwner } from "./protocol/process-owner.js";

/** All recorded terminal owners must be gone before managed takeover. */
export function terminalPresence(
  participations: readonly { readonly owner?: ProcessOwner }[],
  probe: (owner: ProcessOwner | undefined) => boolean | undefined,
): boolean | undefined {
  let unknown = false;
  for (const participation of participations) {
    const state = probe(participation.owner);
    if (state === true) return true;
    if (state === undefined) unknown = true;
  }
  return unknown ? undefined : false;
}

export interface ProcessSnapshot extends ProcessOwner {
  readonly parentPid: number;
}

/** null is confirmed absent; undefined means that inspection is unavailable. */
type ProcessProbe = (pid: number) => ProcessSnapshot | null | undefined;

function absentOrUnknown(pid: number): null | undefined {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return null;
  }
  return undefined;
}

function processProbe(): ProcessProbe {
  if (process.platform === "linux") {
    let bootId: string | undefined;
    return (pid) => {
      try {
        bootId ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
        const stat = (): string[] => {
          const text = readFileSync(`/proc/${pid}/stat`, "utf8");
          // The parenthesized command can itself contain spaces or a closing parenthesis.
          return text
            .slice(text.lastIndexOf(")") + 2)
            .trim()
            .split(/\s+/);
        };
        const fields = stat();
        const parentPid = Number(fields[1]);
        const ticks = fields[19];
        if (!Number.isSafeInteger(parentPid) || !ticks || !/^\d+$/.test(ticks)) return undefined;
        const executable = readlinkSync(`/proc/${pid}/exe`);
        if (stat()[19] !== ticks) return undefined;
        return { executable, parentPid, pid, startedAt: `${bootId}:${ticks}` };
      } catch {
        return absentOrUnknown(pid);
      }
    };
  }
  if (process.platform === "darwin") {
    try {
      const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
      const library = dlopen("/usr/lib/libproc.dylib", {
        proc_pidinfo: {
          args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
        proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      });
      // Darwin proc_bsdinfo ABI (sys/proc_info.h), checked against the SDK:
      // 136 bytes; ppid at 16, start seconds at 120, microseconds at 128.
      const infoBytes = 136;
      const bsdInfo = 3;
      return (pid) => {
        const info = Buffer.alloc(infoBytes);
        if (library.symbols.proc_pidinfo(pid, bsdInfo, 0, ptr(info), infoBytes) !== infoBytes)
          return absentOrUnknown(pid);
        if (info.readUInt32LE(12) !== pid) return undefined;
        const startedAt = `${info.readBigUInt64LE(120)}:${info.readBigUInt64LE(128)}`;
        const parentPid = info.readUInt32LE(16);
        const path = Buffer.alloc(4096);
        if (library.symbols.proc_pidpath(pid, ptr(path), path.length) <= 0)
          return absentOrUnknown(pid);
        const executable = path.subarray(0, path.indexOf(0)).toString("utf8");
        // Refuse a PID replacement between the identity and executable reads.
        if (
          library.symbols.proc_pidinfo(pid, bsdInfo, 0, ptr(info), infoBytes) !== infoBytes ||
          `${info.readBigUInt64LE(120)}:${info.readBigUInt64LE(128)}` !== startedAt
        )
          return undefined;
        return { executable, parentPid, pid, startedAt };
      };
    } catch {
      // An unavailable backend is not evidence that an owner departed.
    }
  }
  return () => undefined;
}

const probe = processProbe();

/** Read identity fields only. null means gone; undefined means unknown. */
export function readProcessOwner(pid: number): ProcessSnapshot | null | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return undefined;
  return probe(pid);
}

export function ownerPresence(owner: ProcessOwner): boolean | undefined {
  const current = readProcessOwner(owner.pid);
  if (current === undefined) return undefined;
  return (
    current !== null &&
    current.startedAt === owner.startedAt &&
    current.executable === owner.executable
  );
}
