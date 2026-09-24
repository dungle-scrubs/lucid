/**
 * Live proof: a chat reference travels in the served page.
 *
 * Spins the real server over a record holding one artifact version and one
 * agent message carrying a reference fence. Opens the reading view in a
 * real browser, waits for the chat link, clicks it, and confirms the frame
 * reports the focus on the referenced block. Uses chrome-devtools-axi
 * against the served page.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServe } from "../../src/cli/serve.js";
import { createConversationHost } from "../../src/store/conversation-host.js";
import { createConversationRecord } from "../../src/store/store.js";

const CONV = "chat-ref-live";
const ARTIFACT = "field-notes";
const BYTES = `<!doctype html><html><head><title>Field notes</title></head><body>
<h1>Field notes</h1>
<p>The upper catchment holds water longer than the open pasture.</p>
<h2>Next survey</h2>
<p>Keep the next survey focused on the stream edge.</p>
</body></html>`;

const root = mkdtempSync(join(tmpdir(), "lucid-chatref-"));
const { secret } = createConversationRecord(root, CONV);
const host = createConversationHost(join(root, CONV), {
  now: () => Date.now(),
  presence: () => undefined,
  executorLease: () => false,
  onEffect: () => {},
  onRecord: () => {},
});
const BYTES_V2 = BYTES.replace("stream edge.", "stream edge. A second pass follows at dusk.");
for (const [version, bytes] of [
  [1, BYTES],
  [2, BYTES_V2],
] as const) {
  const accepted = await host.writeArtifact({
    artifactId: ARTIFACT,
    version,
    author: "agent",
    contentType: "text/html",
    bytes,
  });
  if (accepted.verdict !== "accepted") throw new Error(`artifact write refused at v${version}`);
}
const attachResult = host.handleFrame(
  JSON.stringify({
    kind: "attach",
    conversationId: CONV,
    profile: "headless-turn",
    harness: "claude",
    secret,
    version: 1,
  }),
);
console.log(`ATTACH ${JSON.stringify(attachResult.verdict)}`);
const sendRef = (n: number, version: number, label: string) =>
  host.handleFrame(
    JSON.stringify({
      kind: "event",
      epoch: 1,
      n,
      turnId: "t-1",
      event: {
        kind: "message",
        text: `See the [${label}] for the revised plan.\n\`\`\`lucid-references\n${JSON.stringify({
          artifactId: ARTIFACT,
          version,
          refs: [{ quote: "Next survey", label }],
        })}\n\`\`\``,
      },
    }),
  );
const eventResult = sendRef(1, 1, "Next survey section");
const eventResult2 = sendRef(2, 2, "Survey heading");
console.log(`EVENT2 ${JSON.stringify(eventResult2.verdict)}`);
console.log(`EVENT ${JSON.stringify(eventResult.verdict)}`);
host.close();

const server = await startServe({ rootDir: root, port: 0 });
const url = `${server.url}/c/${CONV}/${ARTIFACT}?conversation-panel=open`;
console.log(`LIVE-URL ${url}`);
console.log(`LIVE-TOKEN ${server.token}`);

// Keep the server alive for the browser run. The driver script stops it.
await new Promise(() => {});
