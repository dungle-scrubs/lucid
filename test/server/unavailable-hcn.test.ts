import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationRecord, openConversation } from "../../src/store/store.js";

test("an outdated hcn leaves healthy and damaged conversations readable without repeated probes", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-unavailable-hcn-"));
  const executable = join(root, "fake-hcn");
  const probes = join(root, "probes");
  // Synthetic version probe only. This process cannot launch a model.
  writeFileSync(
    executable,
    `#!/usr/bin/env bun\nimport { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(probes)}, 'probe\\n');
console.log('0.6.3');
`,
    { mode: 0o700 },
  );
  for (const id of ["healthy", "damaged"]) {
    const { paths } = createConversationRecord(root, id);
    const host = openConversation(paths.dir, {
      executorLease: () => false,
      now: () => 1,
      onEffect: () => {},
      onRecord: () => {},
      presence: () => false,
    });
    host.enqueueInput({ id: "input", mode: "queue", text: "Keep this conversation readable" });
    if (id === "damaged") appendFileSync(paths.logPath, "invalid log line\n");
  }
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
import { startServer } from './src/server/server.ts';
const server = await startServer({ rootDir: ${JSON.stringify(root)}, port: 0, wakeNaming: () => {} });
try {
  const results = [];
  for (const id of ['healthy', 'damaged', 'healthy']) {
    const response = await fetch(server.url + '/api/conversations/' + id, {
      headers: { 'x-lucid-token': server.token },
    });
    results.push({ status: response.status, type: response.headers.get('content-type'), body: await response.text() });
  }
  console.log(JSON.stringify(results));
} finally { await server.close(); }
`,
    ],
    {
      env: { ...process.env, LUCID_HCN: executable },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  try {
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
    const results = JSON.parse(output) as { status: number; type: string; body: string }[];
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.type).toContain("application/json");
      expect(JSON.parse(result.body).driverChoices).toEqual({
        harnesses: ["claude", "codex", "pi", "muse"],
        vocabulary: {},
      });
    }
    expect(JSON.parse(results[0]?.body ?? "")).toMatchObject({
      conversationSettings: {
        selected: null,
        error: expect.stringContaining("Harness inspection is unavailable"),
      },
      damaged: false,
    });
    expect(results[0]?.body).toContain("Keep this conversation readable");
    expect(JSON.parse(results[1]?.body ?? "").damaged).toBe(true);
    expect(readFileSync(probes, "utf8")).toBe("probe\n");
  } finally {
    child.kill();
    await child.exited;
    rmSync(root, { force: true, recursive: true });
  }
}, 10000);
