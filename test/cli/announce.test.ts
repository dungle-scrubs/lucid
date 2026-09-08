import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HCN_MIN_VERSION } from "../../src/harness/version.js";
import { createConversationRecord, openWriter } from "../../src/store/store.js";

test("the SessionStart hook records the native identity and corroborated parent process", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-announce-"));
  const { paths } = createConversationRecord(root, "hook-record", { workingDirectory: root });
  const hcn = join(root, "fake-hcn");
  // Synthetic descriptor: the test process stands in for the native parent.
  writeFileSync(
    hcn,
    `#!/usr/bin/env bun
if(process.argv.includes('--version')) console.log('${HCN_MIN_VERSION}');
else if(process.argv.includes('--runtime')) console.log(JSON.stringify({v:1,argv:['claude','[prompt]'],executable:{path:${JSON.stringify(process.execPath)},version:'fake'},resume:{status:'unknown',reason:'Synthetic adapter'}}));
else console.log(JSON.stringify({name:'claude',bin:'claude',sessionMode:{},verifiedAgainst:'fake'}));
`,
    { mode: 0o700 },
  );
  try {
    const child = Bun.spawn([process.execPath, "src/cli/main.ts", "announce"], {
      cwd: process.cwd(),
      env: { ...process.env, LUCID_RECORD_DIR: paths.dir, LUCID_HCN: hcn },
      stdin: new Blob([
        JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: "native-hook-session",
          transcript_path: join(root, "native.jsonl"),
          cwd: root,
          source: "startup",
        }),
      ]),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    const host = openWriter(paths.dir);
    try {
      expect(host.state().nativeSessions.claude).toMatchObject({
        sessionId: "native-hook-session",
        profile: "interactive",
        owner: { pid: process.pid },
      });
    } finally {
      host.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook attachment intent is stable for explicit starts and absent for compaction", async () => {
  const { announcementIntent } = await import("../../src/cli/hooks/announce.js");
  const { readProcessOwner } = await import("../../src/process-owner.js");
  const owner = readProcessOwner(process.pid);
  if (!owner) throw new Error("Test owner unavailable");
  const intent = announcementIntent("startup", "native", owner);
  expect(intent).toMatchObject({ attachmentOrigin: "explicit" });
  expect(announcementIntent("startup", "native", owner)).toEqual(intent);
  expect(announcementIntent("compact", "native", owner)).toEqual({ attachmentOrigin: "automatic" });
  expect(announcementIntent("unknown", "native", owner)).toEqual({ attachmentOrigin: "automatic" });
  expect(announcementIntent("resume", "native", undefined)).toEqual({
    attachmentOrigin: "automatic",
  });
});
