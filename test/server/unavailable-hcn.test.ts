import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNodeHarness } from "../../src/harness/node-deps.js";
import { startServer } from "../../src/server/server.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";

test("pending startup inspection does not delay records and defaults shares the settled warning", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-pending-hcn-"));
  const executable = join(root, "hcn");
  const release = join(root, "release");
  const probes = join(root, "probes");
  writeFileSync(
    executable,
    `#!/bin/sh\n[ "$1" = "--version" ] || exit 2\necho probe >> '${probes}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\nprintf '0.6.6\\n'\n`,
    { mode: 0o700 },
  );
  createConversationRecord(root, "pending");
  const startup = prepareNodeHarness({ env: executable });
  const server = await startServer({ rootDir: root, port: 0, harnessStartup: startup });
  const headers = { "x-lucid-token": server.token };
  try {
    const response = await fetch(`${server.url}/api/conversations/pending`, { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).compatibility).toEqual([]);
    writeFileSync(release, "ready");
    const defaults = await Promise.all(
      [1, 2].map(async () => (await fetch(`${server.url}/api/defaults`, { headers })).json()),
    );
    expect(defaults[0].compatibility).toMatchObject([
      { code: "hcn-version-drift", severity: "warning", hcn: { path: executable } },
    ]);
    expect(defaults[1].compatibility).toEqual(defaults[0].compatibility);
    expect(readFileSync(probes, "utf8")).toBe("probe\n");
  } finally {
    writeFileSync(release, "ready");
    await startup;
    await server.close();
    rmSync(root, { force: true, recursive: true });
  }
});

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
  await fetch(server.url + '/api/defaults', { headers: { 'x-lucid-token': server.token } });
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

test("a rejected startup observation leaves record reads and safe defaults available", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-rejected-startup-"));
  createConversationRecord(root, "record");
  const server = await startServer({
    rootDir: root,
    port: 0,
    harnessStartup: Promise.reject(new Error("synthetic-private-probe-output")),
  });
  try {
    const headers = { "x-lucid-token": server.token };
    const defaults = await fetch(`${server.url}/api/defaults`, { headers });
    expect(defaults.status).toBe(200);
    const body = await defaults.json();
    expect(body.compatibility).toMatchObject([
      { code: "inspection-unavailable", severity: "error", origin: "runtime-start" },
    ]);
    expect(JSON.stringify(body)).not.toContain("synthetic-private-probe-output");
    expect((await fetch(`${server.url}/api/conversations/record`, { headers })).status).toBe(200);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
