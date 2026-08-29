/**
 * Choosing the driver over the endpoint (RFC-12).
 *
 * The endpoint writes one file and spawns nothing. Validation is shape
 * only, in the RFC's pinned order - json, harness, fields, unknown keys -
 * and membership in a harness's vocabulary is hcn's to judge at spawn, so
 * no test here expects the endpoint to refuse a model hcn does not know.
 *
 * What a person chose reaches the page through the poll the client already
 * makes, as `driverPreference`, beside the `driver` in force - the two are
 * never one field.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServe } from "../../src/cli/serve.js";
import { readDriverPreference } from "../../src/store/driver-preference.js";
import { createConversationRecord } from "../../src/store/store.js";

const CONV = "drv-1";

const rig = async (): Promise<{
  post: (body: string, token?: string) => Promise<Response>;
  poll: () => Promise<Response>;
  dir: string;
  stop: () => Promise<void>;
}> => {
  const root = mkdtempSync(join(tmpdir(), "lucid-driver-api-"));
  createConversationRecord(root, CONV);
  const server = await startServe({ rootDir: root, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    dir: join(root, CONV),
    stop: () => server.close(),
    post: (body, token = server.token) =>
      fetch(`${base}/api/conversations/${CONV}/driver`, {
        method: "POST",
        headers: { "x-lucid-token": token, "content-type": "application/json" },
        body,
      }),
    poll: () =>
      fetch(`${base}/api/conversations/${CONV}`, {
        headers: { "x-lucid-token": server.token },
      }),
  };
};

describe("writing a preference", () => {
  test("stores it and answers with what the file now holds", async () => {
    const r = await rig();
    const res = await r.post('{"harness":"pi","model":"qwen3.6-35b-a3b-mlx","effort":"high"}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      v: 1,
      harness: "pi",
      model: "qwen3.6-35b-a3b-mlx",
      effort: "high",
    });
    expect(readDriverPreference(r.dir)).toEqual({
      v: 1,
      harness: "pi",
      model: "qwen3.6-35b-a3b-mlx",
      effort: "high",
    });
    await r.stop();
  });

  test("the file lands 0o600, beside meta.json, never in the log", async () => {
    const r = await rig();
    await r.post('{"harness":"claude"}');
    expect(statSync(join(r.dir, "driver.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(r.dir, "log.ndjson"), "utf8")).toBe("");
    await r.stop();
  });

  test("the whole preference is replaced, not patched", async () => {
    const r = await rig();
    await r.post('{"harness":"codex","model":"o4-mini","effort":"low"}');
    await r.post('{"harness":"codex"}');
    expect(readDriverPreference(r.dir)).toEqual({ v: 1, harness: "codex" });
    await r.stop();
  });

  test("a conversation with no record yet is created, as an input creates one", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-driver-fresh-"));
    const server = await startServe({ rootDir: root, port: 0 });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/conversations/fresh/driver`, {
      method: "POST",
      headers: { "x-lucid-token": server.token, "content-type": "application/json" },
      body: '{"harness":"muse"}',
    });
    expect(res.status).toBe(200);
    expect(readDriverPreference(join(root, "fresh"))).toEqual({ v: 1, harness: "muse" });
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("an alias is not one of the four", async () => {
    const r = await rig();
    const res = await r.post('{"harness":"claude-code"}');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid-harness");
    expect(existsSync(join(r.dir, "driver.json"))).toBe(false);
    await r.stop();
  });
});

describe("the endpoint refuses, before anything is written", () => {
  test("a body that is not JSON", async () => {
    const r = await rig();
    const res = await r.post("not json");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid-json");
    await r.stop();
  });

  test("a missing or unknown harness", async () => {
    const r = await rig();
    for (const body of ['{"model":"opus"}', "{}", "[]", '"claude"']) {
      const res = await r.post(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid-harness");
    }
    await r.stop();
  });

  test("a field that is not a bounded, control-free string", async () => {
    const r = await rig();
    for (const body of [
      `{"harness":"pi","model":"${"x".repeat(129)}"}`,
      '{"harness":"pi","provider":"lm\\nstudio"}',
      '{"harness":"pi","effort":""}',
      '{"harness":"pi","effort":5}',
    ]) {
      const res = await r.post(body);
      expect(res.status).toBe(400);
      const err = (await res.json()) as { error: string; field: string; max: number };
      expect(err.error).toBe("invalid-field");
      expect(err.max).toBe(128);
    }
    expect(existsSync(join(r.dir, "driver.json"))).toBe(false);
    await r.stop();
  });

  test("a field outside the five, mode and profile among them", async () => {
    const r = await rig();
    for (const body of [
      '{"harness":"pi","mode":"interactive"}',
      '{"harness":"pi","profile":"headless-turn"}',
      '{"harness":"pi","sandbox":"workspace-write"}',
    ]) {
      const res = await r.post(body);
      expect(res.status).toBe(400);
      const err = (await res.json()) as { error: string; field: string };
      expect(err.error).toBe("unknown-field");
      expect(typeof err.field).toBe("string");
    }
    await r.stop();
  });

  test("the order is the RFC's: harness before unknown fields", async () => {
    // A body that fails two rules answers with the first one in the pinned
    // order - no harness is invalid-harness, not unknown-field.
    const r = await rig();
    const res = await r.post('{"mode":"interactive"}');
    expect(((await res.json()) as { error: string }).error).toBe("invalid-harness");
    await r.stop();
  });

  test("v is a known field, whatever it says", async () => {
    const r = await rig();
    const res = await r.post('{"v":1,"harness":"pi"}');
    expect(res.status).toBe(200);
    await r.stop();
  });
});

describe("the endpoint is gated like every write", () => {
  test("no token is refused", async () => {
    const r = await rig();
    const res = await r.post('{"harness":"pi"}', "");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
    await r.stop();
  });

  test("a wrong token is refused, and nothing is written", async () => {
    const r = await rig();
    const res = await r.post('{"harness":"pi"}', "not-the-token");
    expect(res.status).toBe(401);
    expect(existsSync(join(r.dir, "driver.json"))).toBe(false);
    await r.stop();
  });

  test("an invalid conversation id is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-driver-id-"));
    const server = await startServe({ rootDir: root, port: 0 });
    const res = await fetch(
      `http://127.0.0.1:${server.port}/api/conversations/..%2Fsecret/driver`,
      {
        method: "POST",
        headers: { "x-lucid-token": server.token, "content-type": "application/json" },
        body: '{"harness":"pi"}',
      },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid-conversation-id");
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("what the poll carries", () => {
  test("a preference surfaces beside the driver in force", async () => {
    const r = await rig();
    await r.post('{"harness":"pi","provider":"lmstudio","model":"qwen3.6-35b-a3b-mlx"}');
    const body = (await r.poll().then((res) => res.json())) as {
      driver: Record<string, unknown>;
      driverPreference: Record<string, unknown>;
    };
    // Nothing is driving: the two fields differ, and neither stands in for
    // the other.
    expect(body.driver).toEqual({});
    expect(body.driverPreference).toEqual({
      v: 1,
      harness: "pi",
      provider: "lmstudio",
      model: "qwen3.6-35b-a3b-mlx",
    });
    await r.stop();
  });

  test("no preference is null, and a cleared one returns to null's shape", async () => {
    const r = await rig();
    const before = (await r.poll().then((res) => res.json())) as {
      driverPreference: Record<string, unknown> | null;
    };
    expect(before.driverPreference).toBeNull();
    await r.post('{"harness":"claude","model":"opus"}');
    const after = (await r.poll().then((res) => res.json())) as {
      driverPreference: Record<string, unknown> | null;
    };
    expect(after.driverPreference).toEqual({ v: 1, harness: "claude", model: "opus" });
    await r.stop();
  });

  test("a record that does not exist says null, not an error", async () => {
    const root = mkdtempSync(join(tmpdir(), "lucid-driver-none-"));
    const server = await startServe({ rootDir: root, port: 0 });
    const res = await fetch(`http://127.0.0.1:${server.port}/api/conversations/nothing-yet`, {
      headers: { "x-lucid-token": server.token },
    });
    const body = (await res.json()) as { status: string; driverPreference: unknown };
    expect(body.status).toBe("no record");
    expect(body.driverPreference).toBeNull();
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
});
