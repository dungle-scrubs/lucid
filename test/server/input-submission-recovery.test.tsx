import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createInputSubmission } from "../../src/server/client/input-submission.js";
import { InputRecovery } from "../../src/server/client/input-submission-recovery.js";

test("ordinary sends do not flash a recovery card; uncertain sends and retries remain recoverable", async () => {
  const values = new Map<string, string>();
  let complete: (response: Response) => void = () => {};
  const submission = createInputSubmission({
    conversationId: "flash-reproduction",
    mintId: () => "one-request",
    send: () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
    storage: {
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => {
        values.delete(key);
      },
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
  });
  const render = (busy: boolean, reason: string | null): string =>
    renderToStaticMarkup(
      <InputRecovery
        busy={busy}
        dead={false}
        onDiscard={() => {}}
        onRetry={() => {}}
        reason={reason}
        state={submission.current()}
      />,
    );
  const pending = submission.submit("A new prompt");
  expect(values.size).toBe(1);
  expect(render(true, null)).toBe("");
  complete(new Response("unreadable response", { status: 502 }));
  await pending;
  expect(render(false, "The send result is unknown.")).toContain("Retry send");
  const retry = submission.retry();
  expect(render(true, "Checking this saved send.")).toContain("Checking…");
  complete(Response.json({ inputId: "one-request", verdict: "accepted" }));
  await retry;
  expect(values.size).toBe(0);
  expect(render(false, null)).toBe("");
});
