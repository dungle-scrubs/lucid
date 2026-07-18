#!/usr/bin/env bun
// A stand-in "harness" for launcher tests: reads the fork seed and writes a
// minimal child artifact, so the create path is exercised without a real LLM.
// argv: <seed> <artifact>
const [, , seedPath, artifactPath] = process.argv;
if (!seedPath || !artifactPath) process.exit(2);
const seed = await Bun.file(seedPath).text();
const directive = seed.match(/\*\*Directive:\*\* (.*)/)?.[1] ?? "forked artifact";
await Bun.write(
  artifactPath,
  `<!doctype html><html><head><title>${directive}</title></head><body><h1 data-lucid-id="t">${directive}</h1></body></html>`,
);
