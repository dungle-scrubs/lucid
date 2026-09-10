import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SYNTHETIC_HCN_IDENTITY = "synthetic";

import { encodeAnnotationBatch } from "../../src/protocol/annotations.js";
import { readRecordMetadata } from "../../src/store/record-identity.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";

test("independent worker processes serialize ownership and complete isolated naming through fake hcn", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-worker-process-"));
  const trace = join(root, "calls.ndjson"),
    executable = join(root, "fake-hcn");
  // Inline synthetic hcn protocol, not a recording or native harness fixture.
  writeFileSync(
    executable,
    `#!/usr/bin/env bun\nimport {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('${SYNTHETIC_HCN_IDENTITY}');process.exit(0);}
if(args[0]==='inspect'){console.log(JSON.stringify({name:'claude',sessionMode:{},verifiedAgainst:'fake',vocabulary:{models:['concrete-opus'],efforts:['high'],extensible:false}}));process.exit(0);}
appendFileSync(${JSON.stringify(trace)},JSON.stringify({args,cwd:process.cwd()})+'\\n');
console.log(JSON.stringify({kind:'message',role:'assistant',text:'Stable generated title'}));console.log(JSON.stringify({kind:'done',cause:'clean',exitCode:0}));
`,
    { mode: 0o700 },
  );
  try {
    for (const id of ["first", "second", "third"]) {
      const { paths } = createConversationRecord(root, id, {
        preference: {
          v: 1,
          harness: "claude",
          model: "concrete-opus",
          effort: "high",
          profile: "headless-turn",
          revision: 1,
        },
      });
      const host = openConversation(paths.dir, {
        now: () => 1,
        presence: () => false,
        executorLease: () => false,
        onEffect: () => {},
        onRecord: () => {},
      });
      let beforeText: string | undefined;
      if (id === "first") {
        host.enqueueInput({
          id: "attachment",
          mode: "queue",
          text: encodeAnnotationBatch({
            artifactId: "doc",
            version: 1,
            notes: [
              {
                note: "",
                spots: [],
                files: [
                  {
                    hash: "a".repeat(64),
                    bytes: 12,
                    contentType: "text/plain",
                    name: "example.txt",
                  },
                ],
              },
            ],
          }),
        });
        beforeText = readFileSync(paths.metaPath, "utf8");
      }
      host.enqueueInput({ id: "input", text: "Improve project search", mode: "queue" });
      // Crash window: the first text is durable but its metadata replacement was lost.
      if (beforeText) writeFileSync(paths.metaPath, beforeText);
    }
    const children = Array.from({ length: 2 }, () =>
      Bun.spawn([process.execPath, "src/cli/main.ts", "_name-titles", root], {
        cwd: process.cwd(),
        env: { ...process.env, LUCID_HCN: executable },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const outputs = await Promise.all(
      children.map(async (child) => ({
        code: await child.exited,
        error: await new Response(child.stderr).text(),
      })),
    );
    expect(outputs).toEqual([
      { code: 0, error: "" },
      { code: 0, error: "" },
    ]);
    const calls = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.args).toContain("--isolation");
      expect(call.args).not.toContain("--resume");
      expect(call.cwd).toContain("lucid-naming-");
    }
    for (const id of ["first", "second", "third"])
      expect(readRecordMetadata(join(root, id))).toMatchObject({
        conversationTitle: "Stable generated title",
        titleGeneration: { attempts: 1, status: "finished" },
      });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test("internal naming dispatch uses its explicit root without constructing unrelated record addressing", async () => {
  const { dispatch } = await import("../../src/cli/dispatch.js");
  const roots: string[] = [];
  expect(
    await dispatch(["_name-titles", "/tmp/synthetic-naming-root"], {
      namingWorkerFn: async (root) => {
        roots.push(root);
      },
      conversationsFactory: () => {
        throw new Error("Internal worker must not resolve ambient record root");
      },
    }),
  ).toEqual({ kind: "name-titles" });
  expect(roots).toEqual(["/tmp/synthetic-naming-root"]);
});
