import { expect, test } from "bun:test";

test("the native terminal process inherits caller I/O and keeps control on fd 3", async () => {
  const adapter = new URL("../../src/harness/node-deps.ts", import.meta.url).href;
  // Synthetic process I/O, not a captured harness or native session.
  const childProgram = `
    import { readSync, writeSync } from "node:fs";
    writeSync(1, "NATIVE_STDOUT\\n");
    writeSync(2, "NATIVE_STDERR\\n");
    const input = Buffer.alloc(5);
    readSync(0, input);
    writeSync(3, JSON.stringify({ input: input.toString() }) + "\\n");
  `;
  const callerProgram = `
    import { nodeSpawnInteractiveHcn } from ${JSON.stringify(adapter)};
    const child = nodeSpawnInteractiveHcn([process.execPath, "-e", ${JSON.stringify(childProgram)}], { cwd: ${JSON.stringify(import.meta.dir)} });
    let control = "";
    for await (const chunk of child.control) control += chunk;
    const exitCode = await child.exited;
    child.disposeControl();
    console.log(JSON.stringify({ control, exitCode }));
  `;
  const caller = Bun.spawn([process.execPath, "-e", callerProgram], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    caller.stdin.write("HELLO");
    caller.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(caller.stdout).text(),
      new Response(caller.stderr).text(),
      caller.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("NATIVE_STDERR\n");
    const lines = stdout.trim().split("\n");
    expect(lines[0]).toBe("NATIVE_STDOUT");
    expect(JSON.parse(lines[1] ?? "null")).toEqual({ control: '{"input":"HELLO"}\n', exitCode: 0 });
  } finally {
    caller.kill();
    await caller.exited;
  }
});
