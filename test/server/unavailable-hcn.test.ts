import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareNodeHarness } from "../../src/harness/node-deps.js";
import { startServer } from "../../src/server/server.js";
import { createConversationRecord, openConversation } from "../../src/store/store.js";

test("a missing HCN fails at inspection while healthy and damaged records stay readable", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-unavailable-hcn-"));
  const executable = join(root, "missing-hcn");
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
    host.close();
    if (id === "damaged") appendFileSync(paths.logPath, "invalid log line\n");
  }
  const startup = await prepareNodeHarness({ env: executable });
  expect(startup.deps?.bin).toBe(executable);
  expect(startup.diagnostics).toEqual([]);
  const server = await startServer({
    rootDir: root,
    port: 0,
    configLocation: { home: root, xdgConfigHome: root },
    harnessStartup: Promise.resolve(startup),
    wakeNaming: () => {},
  });
  const headers = { "x-lucid-token": server.token };
  try {
    const defaults = await (await fetch(`${server.url}/api/defaults`, { headers })).json();
    expect(defaults.error).toContain("inspection");
    expect(defaults.compatibility).toMatchObject([{ code: "inspection-unavailable" }]);
    for (const id of ["healthy", "damaged", "healthy"]) {
      const response = await fetch(`${server.url}/api/conversations/${id}`, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.damaged).toBe(id === "damaged");
      if (id === "healthy")
        expect(JSON.stringify(body)).toContain("Keep this conversation readable");
      expect(JSON.stringify(body)).not.toMatch(/hcn-version|harness-version|below the .* minimum/);
    }
  } finally {
    await server.close();
    rmSync(root, { force: true, recursive: true });
  }
});

test("a failed executable resolution leaves record reads and safe defaults available", async () => {
  const root = mkdtempSync(join(tmpdir(), "lucid-rejected-startup-"));
  createConversationRecord(root, "record");
  const server = await startServer({
    rootDir: root,
    port: 0,
    configLocation: { home: root, xdgConfigHome: root },
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
