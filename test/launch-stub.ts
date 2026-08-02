#!/usr/bin/env bun
// A stand-in "harness" for launcher tests: reads the fork seed and writes a
// minimal child artifact, so the create path is exercised without a real LLM.
// A DISCOVERED harness: with --json it announces its own session identity on
// stdout the way Codex does, split across two writes like a real pipe.
// argv: [--json] <seed> <artifact>
const args = process.argv.slice(2).filter((a) => a !== "--json");
if (process.argv.includes("--json")) {
  process.stdout.write('{"type":"thread.started","thread_');
  await new Promise((r) => setTimeout(r, 20));
  process.stdout.write('id":"stub-thread-0001"}\n');
}
const [seedPath, artifactPath] = args;
if (!seedPath || !artifactPath) process.exit(2);
const seed = await Bun.file(seedPath).text();
const directive = seed.match(/\*\*Directive:\*\* (.*)/)?.[1] ?? "forked artifact";
await Bun.write(
  artifactPath,
  `<!doctype html><html><head><title>${directive}</title></head><body><h1 data-lucid-id="t">${directive}</h1></body></html>`,
);
