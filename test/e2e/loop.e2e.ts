import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { makeCli, PLAN_V1, PLAN_V2, type Cli } from "./helpers.ts";

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

const surfaceOf = (page: Page): FrameLocator =>
  page.frameLocator('iframe[title="artifact surface"]');

const openViewer = async (page: Page): Promise<{ nextCursor: string }> => {
  cli = await makeCli(PLAN_V1);
  const session = (await cli.run(["open", cli.artifact])) as { url: string; nextCursor: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
  return { nextCursor: session.nextCursor };
};

test("Enter sends the message, which is what the composer's placeholder promises", async ({
  page,
}) => {
  // The box says "Enter to send, Shift+Enter for a new line". Nothing tested
  // it, so a regression there would only ever be found by a human typing.
  await openViewer(page);
  const input = page.locator('[data-test="message-input"]:visible');
  await input.fill("sent with the enter key");
  await input.press("Enter");

  await expect(page.locator('[data-role="human"]')).toContainText("sent with the enter key");
  // And the box is empty again, rather than holding the text plus a newline.
  await expect(input).toHaveValue("");

  // Shift+Enter is the other half of the promise: a newline, not a send.
  await input.fill("first line");
  await input.press("Shift+Enter");
  await input.pressSequentially("second line");
  await expect(input).toHaveValue("first line\nsecond line");
  await expect(page.locator('[data-role="human"]')).toHaveCount(1);
});

test("full loop: render -> annotate element -> wait -> revise -> live reload", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  // Click an element in the artifact -> overlay picks it -> chrome composer opens.
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await expect(page.locator('textarea[placeholder^="What should change here?"]')).toBeVisible();

  await page
    .locator('textarea[placeholder^="What should change here?"]')
    .fill("Backfill in one batch, not nightly - nightly will take weeks.");
  await page.locator('[data-test="add-to-queue"]').click();
  await expect(page.locator('[data-test="send-queue"]')).toBeVisible();
  await page.locator('[data-test="send-queue"]').click();

  // The annotation echoes back via SSE and renders in the chrome list.
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(1);

  // The agent receives located feedback via wait.
  const feedback = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    "8",
  ])) as {
    status: string;
    annotations: { note: string; resolved: boolean; target: { snippet: string } }[];
    nextCursor: string;
  };
  expect(feedback.status).toBe("feedback");
  expect(feedback.annotations).toHaveLength(1);
  expect(feedback.annotations[0]?.note).toContain("one batch");
  expect(feedback.annotations[0]?.resolved).toBe(true);
  expect(feedback.annotations[0]?.target.snippet).toContain("Backfill");

  // The agent revises the artifact; the watcher commits v2 and the viewer live-reloads.
  await cli.write(PLAN_V2);
  await expect(surface.locator("h1")).toContainText("revised");
  await expect(page.locator('[data-test="version"]')).toContainText("v2");

  // A version-only delta returns `waiting`, not feedback (D-062).
  const afterRevise = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    feedback.nextCursor,
    "--timeout",
    "4",
  ])) as {
    status: string;
    version: number;
  };
  expect(afterRevise.status).toBe("waiting");
  expect(afterRevise.version).toBe(2);
});

test("lucid progress renders a distinct fan-out indicator that output clears", async ({ page }) => {
  await openViewer(page);

  // The agent farms the revision out to parallel subagents and self-reports.
  await cli.run(["progress", cli.artifact, "--label", "auditing 7 screens", "--total", "7"]);
  const fanout = page.locator('[data-test="agent-working"][data-fanout="true"]');
  await expect(fanout).toBeVisible();
  await expect(fanout).toContainText("7 agents in progress");
  await expect(fanout).toContainText("0/7 reported");
  await expect(fanout).toContainText("auditing 7 screens");

  // A later report bumps the count in place.
  await cli.run([
    "progress",
    cli.artifact,
    "--label",
    "auditing 7 screens",
    "--total",
    "7",
    "--done",
    "3",
  ]);
  await expect(fanout).toContainText("3/7 reported");

  // Real output (a new version) closes the window entirely.
  await cli.write(PLAN_V2);
  await expect(page.locator('[data-test="agent-working"]')).toHaveCount(0);
});

test("context usage renders a header ring that updates live", async ({ page }) => {
  await openViewer(page);

  // No report yet -> no ring.
  await expect(page.locator('[data-test="context-ring"]')).toHaveCount(0);

  // The harness (its statusline) reports usage; the ring appears via SSE.
  await cli.run(["context", cli.artifact, "--used", "142000", "--total", "200000"]);
  const ring = page.locator('[data-test="context-ring"]');
  await expect(ring).toBeVisible();
  await expect(ring).toHaveAttribute("data-pct", "71");
  // The detail lives in the panel's own tooltip now, not a native title.
  await ring.hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(/71% used.*142k\/200k/);

  // A later report updates the same ring in place.
  await cli.run(["context", cli.artifact, "--pct", "90"]);
  await expect(ring).toHaveAttribute("data-pct", "90");
});

test("structured question: choose an option and pin an artifact region as the answer", async ({
  page,
}) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  // The agent forwards a multiple-choice question through Lucid.
  await cli.run([
    "ask",
    cli.artifact,
    "--text",
    "Which store for the cutover?",
    "--option",
    "Postgres|managed, boring",
    "--option",
    "SQLite|embedded, WAL",
  ]);

  // The drawer rises over the surface with the choices as rows.
  await expect(page.locator('[data-test="question-drawer"]')).toBeVisible();
  const choices = page.locator('[data-test="choice"]');
  await expect(choices).toHaveCount(2);
  await choices.first().click();
  await expect(choices.first()).toHaveAttribute("aria-checked", "true");

  // Pin a region of the artifact as the answer's referent - the surface stays
  // live under the drawer, which is the point of a drawer rather than a modal.
  await page.locator('[data-test="pin-region"]').click();
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await expect(page.locator('[data-test="answer-anchor"]')).toBeVisible();

  // Send the answer; it reaches wait with the chosen option and the pinned region.
  await page.locator('[data-test="answer"]').click();
  // Answered -> the drawer lowers (nothing outstanding) and the exchange enters
  // the record. An options-only answer has no free text, so the card has to read
  // the chosen labels or it would print an empty answer over a real decision.
  await expect(page.locator('[data-test="question-drawer"]')).toHaveCount(0);
  await expect(page.locator('[data-test="qa-answer"]')).toContainText("Postgres");
  const payload = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    "8",
  ])) as {
    questions?: {
      answered: boolean;
      answerOptions?: string[];
      answerAnchor?: { snippet: string };
    }[];
  };
  const q = payload.questions?.[0];
  expect(q?.answered).toBe(true);
  expect(q?.answerOptions).toEqual(["Postgres"]);
  expect(q?.answerAnchor?.snippet).toContain("Backfill");
});

test("multi-select question: options are numbered and more than one can be chosen", async ({
  page,
}) => {
  const { nextCursor } = await openViewer(page);

  // A --multi question lets the human accept more than one answer.
  await cli.run([
    "ask",
    cli.artifact,
    "--text",
    "Which axes should day-one score?",
    "--multi",
    "--option",
    "Category|rubric",
    "--option",
    "Owner|actual replier",
    "--option",
    "Spam|marked-spam label",
  ]);

  await expect(page.locator('[data-test="question-drawer"]')).toBeVisible();
  const options = page.locator('[data-test="choice"]');
  await expect(options).toHaveCount(3);
  // Options carry a numeral (1..N) so a prose note can reference a choice by
  // number; the third choice is "3".
  await expect(options.nth(2)).toContainText("3");

  // Pick two - both stay selected (single-select would have replaced the first).
  await options.nth(0).click();
  await options.nth(2).click();
  await expect(options.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(options.nth(2)).toHaveAttribute("aria-checked", "true");

  // Enter from a focused option submits the options-only answer (rather than
  // re-toggling the option) - no note or Answer-button click needed.
  await options.nth(2).press("Enter");
  await expect(page.locator('[data-test="question-drawer"]')).toHaveCount(0);

  const payload = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    "8",
  ])) as { questions?: { answered: boolean; answerOptions?: string[] }[] };
  const q = payload.questions?.[0];
  expect(q?.answered).toBe(true);
  expect(q?.answerOptions).toEqual(["Category", "Spam"]);
});

test("a question can be skipped: it leaves the panel and the agent is told", async ({ page }) => {
  const { nextCursor } = await openViewer(page);

  await cli.run(["ask", cli.artifact, "--text", "Do you have the API keys?"]);
  await expect(page.locator('[data-test="question-drawer"]')).toBeVisible();

  // Decline without answering.
  await page.locator('[data-test="skip"]').click();
  await expect(page.locator('[data-test="question-drawer"]')).toHaveCount(0);

  // The agent learns it was declined, not answered with content.
  const fb = (await cli.run(["wait", cli.artifact, "--since", nextCursor, "--timeout", "8"])) as {
    questions?: { answered: boolean; skipped?: boolean; answer?: string }[];
  };
  expect(fb.questions?.[0]?.answered).toBe(true);
  expect(fb.questions?.[0]?.skipped).toBe(true);
  expect(fb.questions?.[0]?.answer).toBeUndefined();
});

test("a question renders as Markdown and can be handed back for a clearer re-ask", async ({
  page,
}) => {
  const { nextCursor } = await openViewer(page);

  await cli.run([
    "ask",
    cli.artifact,
    "--text",
    [
      "Which harness runs the phase?",
      "",
      "The subcommand validates the artifact against the schema:",
      "",
      "```",
      "lucid ask plan.html --text 'batch or nightly?'",
      "```",
    ].join("\n"),
  ]);
  const q = page.locator('[data-test="question-text"]');
  await expect(q).toBeVisible();
  // Markdown, not literal source: the fence became a code block and its
  // backticks are gone from the text.
  await expect(q.locator("pre code")).toContainText("lucid ask plan.html");
  await expect(q).not.toContainText("```");

  // Short question, no disclosure: the fold only exists for walls.
  await expect(page.locator('[data-test="question-fold"]')).toHaveCount(0);

  // "I don't understand this" - the note says what was confusing. A bare
  // --text ask renders as a free-text field in the drawer.
  await page.locator('[data-test="free-text"]').fill("which schema do you mean?");
  await page.locator('[data-test="reask"]').click();
  await expect(page.locator('[data-test="question-drawer"]')).toHaveCount(0);

  // The agent is told to ask again rather than that it was answered or declined.
  const fb = (await cli.run(["wait", cli.artifact, "--since", nextCursor, "--timeout", "8"])) as {
    questions?: { answered: boolean; unclear?: boolean; skipped?: boolean; answer?: string }[];
  };
  expect(fb.questions?.[0]?.answered).toBe(true);
  expect(fb.questions?.[0]?.unclear).toBe(true);
  expect(fb.questions?.[0]?.skipped).toBeUndefined();
  expect(fb.questions?.[0]?.answer).toContain("which schema");
});

test("a wall-of-text question renders whole; the drawer caps and scrolls instead", async ({
  page,
}) => {
  await openViewer(page);

  const wall = Array.from(
    { length: 12 },
    (_, i) =>
      `Paragraph ${i + 1}: the phase invokes its agent, writes the outbound artifact to a path, and the subcommand validates that file against the schema before the gate lets it through.`,
  ).join("\n\n");
  await cli.run(["ask", cli.artifact, "--text", wall]);

  // No disclosure step: the reader always needs the whole question, so the
  // full text renders and the DRAWER is what bounds height (60% cap,
  // internal scroll).
  const text = page.locator('[data-test="question-text"]');
  await expect(text).toBeVisible();
  await expect(page.locator('[data-test="question-fold"]')).toHaveCount(0);
  await expect(text).toContainText("Paragraph 12");

  const drawer = page.locator('[data-test="question-drawer"]');
  const surfaceBox = await page.locator('iframe[title="artifact surface"]').boundingBox();
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox?.height ?? Infinity).toBeLessThanOrEqual((surfaceBox?.height ?? 0) * 0.62);
  const scrollable = await drawer.evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(scrollable).toBe(true);

  // However tall the question, the drawer never eats the composer that answers it.
  await expect(page.locator('[data-test="message-input"]')).toBeVisible();
});

test("fork button spins the selection off; the request reaches wait as a fork", async ({
  page,
}) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  // Pick a region, type the directive, and Fork instead of annotating in place.
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await page
    .locator('textarea[placeholder^="What should change here?"]')
    .fill("Turn the backfill into its own implementation plan.");
  await page.locator('[data-test="fork"]').click();

  // The composer clears (a fork is sent on click, not queued) and nothing lands
  // in the annotation list.
  await expect(page.locator('textarea[placeholder^="What should change here?"]')).toHaveCount(0);
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(0);

  // The agent receives the fork - not an annotation - via wait.
  const feedback = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    "8",
  ])) as {
    status: string;
    annotations: unknown[];
    forks?: { note: string; resolved: boolean; target: { snippet: string } }[];
  };
  expect(feedback.status).toBe("feedback");
  expect(feedback.annotations).toHaveLength(0);
  expect(feedback.forks).toHaveLength(1);
  expect(feedback.forks?.[0]?.note).toContain("implementation plan");
  expect(feedback.forks?.[0]?.resolved).toBe(true);
  expect(feedback.forks?.[0]?.target.snippet).toContain("Backfill");
});

test("Fork with an empty note still forks (default directive), and confirms", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  // Pick a region and click Fork WITHOUT typing a directive - the region is the
  // seed, so this must still send (regression: it used to silently no-op).
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await expect(page.locator('textarea[placeholder^="What should change here?"]')).toBeVisible();
  await page.locator('[data-test="fork"]').click();

  // A neutral confirmation appears and the composer clears.
  await expect(page.getByText(/Fork(ed)?/)).toBeVisible();
  await expect(page.locator('textarea[placeholder^="What should change here?"]')).toHaveCount(0);

  // The fork reached wait with the default directive.
  const feedback = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    "8",
  ])) as { status: string; forks?: { note: string }[] };
  expect(feedback.forks).toHaveLength(1);
  expect(feedback.forks?.[0]?.note.length).toBeGreaterThan(0);
});

test("Esc discards the annotation being composed", async ({ page }) => {
  await openViewer(page);
  const surface = surfaceOf(page);

  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  const composer = page.locator('textarea[placeholder^="What should change here?"]');
  await expect(composer).toBeVisible();
  await composer.fill("never mind this one");
  await composer.press("Escape");

  // The composer is dismissed and nothing was queued.
  await expect(composer).toHaveCount(0);
  await expect(page.locator('[data-test="send-queue"]')).toHaveCount(0);
});

test("cmd+enter queues the open note and sends the whole queue", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  // Queue one annotation, then start a second and flush both with cmd+enter -
  // the shortcut folds the in-progress note into the queue before sending.
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await page
    .locator('textarea[placeholder^="What should change here?"]')
    .fill("Batch the backfill.");
  await page.locator('[data-test="add-to-queue"]').click();
  await expect(page.locator('[data-test="send-queue"]')).toBeVisible();

  await surface.locator("#note").click();
  const composer = page.locator('textarea[placeholder^="What should change here?"]');
  await composer.fill("Cut over on a weekend.");
  await composer.press("ControlOrMeta+Enter");

  // Both annotations echo back via SSE and the queue clears.
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(2);
  await expect(page.locator('[data-test="send-queue"]')).toHaveCount(0);

  const feedback = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    "8",
  ])) as {
    status: string;
    annotations: { note: string }[];
  };
  expect(feedback.status).toBe("feedback");
  expect(feedback.annotations).toHaveLength(2);
  const notes = feedback.annotations.map((a) => a.note).join(" ");
  expect(notes).toContain("Batch the backfill.");
  expect(notes).toContain("Cut over on a weekend.");
});

test("agent reply appears in the conversation log", async ({ page }) => {
  await openViewer(page);
  await cli.run([
    "wait",
    cli.artifact,
    "--reply",
    "I reordered and batched the backfill.",
    "--timeout",
    "1",
  ]);
  await expect(page.locator('[data-role="agent"]')).toContainText("reordered and batched");
});

test("human message (non-located) reaches the agent as feedback", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  await page
    .locator('textarea[placeholder^="Message the agent"]')
    .fill("Overall: tighten the wording.");
  await page.locator('[data-test="send-message"]').click();
  await expect(page.locator('[data-role="human"]')).toContainText("tighten the wording");

  const fb = (await cli.run(["wait", cli.artifact, "--since", nextCursor, "--timeout", "8"])) as {
    status: string;
    messages: { role: string; text: string }[];
  };
  expect(fb.status).toBe("feedback");
  expect(fb.messages.some((m) => m.role === "human" && m.text.includes("tighten"))).toBe(true);
});

test("approve/resolve closes the loop and reopen clears it", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  await page.locator('[data-test="approve"]').click();
  await expect(page.locator('[data-test="resolved-bar"]')).toBeVisible();

  const resolved = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    "6",
  ])) as {
    reviewResolved: boolean;
    nextCursor: string;
  };
  expect(resolved.reviewResolved).toBe(true);

  // Reopen clears the resolved state (D-059).
  await page.locator('[data-test="reopen"]').click();
  await expect(page.locator('[data-test="resolved-bar"]')).toHaveCount(0);
});

test("reopen with nobody listening says feedback is record-only", async ({ page }) => {
  // No agent ever connects in this test, so the listening count is
  // deterministically zero - the exact state approval leaves behind.
  await openViewer(page);
  await page.locator('[data-test="approve"]').click();
  await expect(page.locator('[data-test="resolved-bar"]')).toBeVisible();

  await page.locator('[data-test="reopen"]').click();
  await expect(page.locator('[data-test="resolved-bar"]')).toHaveCount(0);
  await expect(page.getByText("no agent is listening right now")).toBeVisible();
});

test("reopen on an ended session explains the way back instead of failing", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  await page.locator('[data-test="approve"]').click();
  await expect(page.locator('[data-test="resolved-bar"]')).toBeVisible();
  await cli.run(["wait", cli.artifact, "--since", nextCursor, "--timeout", "6"]);
  // The wait's delivery ack opens the working indicator...
  await expect(page.locator('[data-test="agent-working"]')).toBeVisible();
  await cli.run(["end", cli.artifact]);
  // ...and session_ended closes it - the observable proof the browser has
  // processed the ended state before we click.
  await expect(page.locator('[data-test="agent-working"]')).toHaveCount(0);

  // Reopen must not fire a doomed POST at a dead server and claim "try
  // again" would help.
  const reopen = page.locator('[data-test="reopen"]');
  await expect(reopen).toBeVisible();
  await reopen.click();
  await expect(page.getByText("needs the agent to run")).toBeVisible();
});

test("approve refuses while anything is unsent, so nothing is stranded", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);
  const approve = page.locator('[data-test="approve"]');
  await expect(approve).toBeEnabled();

  // A half-composed annotation already blocks: approving would abandon it.
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await page.locator('[data-test="annotation-note"]').fill("Backfill in one batch");
  await expect(approve).toBeDisabled();
  // The reason lives on the disabled button, not in the header bar.
  await expect(page.locator('[data-test="approve"]')).toBeDisabled();
  await page.locator('[data-test="approve-wrap"]').hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(
    "draft annotation first",
  );

  // Queued still blocks, and says how many.
  await page.locator('[data-test="add-to-queue"]').click();
  await expect(approve).toBeDisabled();
  await page.locator('[data-test="approve-wrap"]').hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText("1 queued annotation");

  // Sending clears the block...
  await page.locator('[data-test="send-queue"]').click();
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(1);
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.locator('[data-test="resolved-bar"]')).toBeVisible();

  // ...and the agent sees the annotation together with the approval, rather
  // than a stop with the feedback stranded behind it.
  const fb = (await cli.run(["wait", cli.artifact, "--since", nextCursor, "--timeout", "8"])) as {
    reviewResolved: boolean;
    annotations: { note: string }[];
  };
  expect(fb.reviewResolved).toBe(true);
  expect(fb.annotations).toHaveLength(1);
  expect(fb.annotations[0]?.note).toContain("one batch");
});

test("text-range selection produces a located annotation", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  const frame = page.frames().find((f) => /127\.0\.0\.1:\d+\/$/.test(f.url()));
  expect(frame).toBeTruthy();

  // Select the phrase "zero downtime" inside the note paragraph and fire mouseup.
  await frame!.evaluate(() => {
    const p = document.getElementById("note");
    if (!p?.firstChild) throw new Error("note not found");
    const text = p.firstChild as Text;
    const content = text.textContent ?? "";
    const start = content.indexOf("zero downtime");
    const range = document.createRange();
    range.setStart(text, start);
    range.setEnd(text, start + "zero downtime".length);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });

  await expect(page.locator('textarea[placeholder^="What should change here?"]')).toBeVisible();
  await page
    .locator('textarea[placeholder^="What should change here?"]')
    .fill("Is zero downtime really required?");
  await page.locator('[data-test="add-to-queue"]').click();
  await page.locator('[data-test="send-queue"]').click();
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(1);

  const fb = (await cli.run(["wait", cli.artifact, "--since", nextCursor, "--timeout", "8"])) as {
    annotations: { resolved: boolean; target: { kind: string; quote?: { exact: string } } }[];
  };
  expect(fb.annotations).toHaveLength(1);
  expect(fb.annotations[0]?.target.kind).toBe("range");
  expect(fb.annotations[0]?.target.quote?.exact).toBe("zero downtime");
  expect(fb.annotations[0]?.resolved).toBe(true);

  await page
    .screenshot({ path: "test/e2e/.artifacts/range-annotation.png", fullPage: false })
    .catch(() => {});
});

test("a queued annotation can be edited before it is sent", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  // Picking a target puts the caret in the note: the click already said where,
  // so the next thing you do is type.
  await expect(page.locator('textarea[placeholder^="What should change here?"]')).toBeFocused();
  await page.locator('textarea[placeholder^="What should change here?"]').fill("Frist draft, typo");
  await page.locator('[data-test="add-to-queue"]').click();

  // Cancel restores the original note, leaving the queue untouched.
  await page.locator('[data-test="edit-queued"]').click();
  // Edit puts the caret in the box: opening an editor you then have to click is
  // not an editor.
  await expect(page.locator('[data-test="edit-note"]')).toBeFocused();
  await page.locator('[data-test="edit-note"]').fill("Discarded rewrite");
  await page.locator('[data-test="cancel-edit"]').click();
  await expect(page.locator('[data-test="send-queue"]')).toBeVisible();
  await expect(page.locator("[data-annotation-id]")).toContainText("Frist draft, typo");

  // An empty note is refused - Save stays disabled.
  await page.locator('[data-test="edit-queued"]').click();
  await page.locator('[data-test="edit-note"]').fill("   ");
  await expect(page.locator('[data-test="save-edit"]')).toBeDisabled();

  // Save rewrites the note in place, and that is what reaches the agent.
  await page.locator('[data-test="edit-note"]').fill("Backfill in one batch, not nightly.");
  await page.locator('[data-test="save-edit"]').click();
  await expect(page.locator('[data-test="edit-note"]')).toHaveCount(0);
  await page.locator('[data-test="send-queue"]').click();
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(1);

  const fb = (await cli.run(["wait", cli.artifact, "--since", nextCursor, "--timeout", "8"])) as {
    annotations: { note: string }[];
  };
  expect(fb.annotations).toHaveLength(1);
  expect(fb.annotations[0]?.note).toBe("Backfill in one batch, not nightly.");
});

test("the record is chronological: queued cards hold their authored place", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  // Queue an annotation, THEN send a message. The message is newer, so it must
  // land BELOW the queued card - this was the reported bug: the queue was a
  // separate section pinned under the transcript, so every new message
  // appeared above the older queued item.
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await page.locator('[data-test="annotation-note"]').fill("Queued first");
  await page.locator('[data-test="add-to-queue"]').click();
  // Queueing hands focus to the message composer - the flow the panel is
  // built around: point, note, Enter, keep talking.
  await expect(page.locator('[data-test="message-input"]')).toBeFocused();
  await page.locator('[data-test="message-input"]').fill("typed second");
  await page.locator('[data-test="send-message"]').click();
  await expect(page.locator('[data-role="human"]')).toContainText("typed second");

  const order = () =>
    page.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          '[data-role], [data-test="annotation"], [data-test="queued-annotation"]',
        ),
      ).map((el) => (el as HTMLElement).dataset.role ?? (el as HTMLElement).dataset.test),
    );
  expect(await order()).toEqual(["queued-annotation", "human"]);

  // Sending must not reorder: the event carries authoredAt, so the located
  // card takes the queued card's place instead of leapfrogging to send time.
  await page.locator('[data-test="send-queue"]').click();
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(1);
  expect(await order()).toEqual(["annotation", "human"]);

  // And the agent sees the authorship time alongside the log time.
  const fb = (await cli.run(["wait", cli.artifact, "--since", nextCursor, "--timeout", "8"])) as {
    annotations: { note: string; authoredAt?: string; at: string }[];
  };
  const sent = fb.annotations[0];
  expect(sent?.authoredAt).toBeTruthy();
  if (sent?.authoredAt) expect(sent.authoredAt <= sent.at).toBe(true);
});

test("a sent annotation stays in send order, not pinned above the replies", async ({ page }) => {
  await openViewer(page);
  const surface = surfaceOf(page);
  const annotate = async (sel: string, note: string) => {
    await surface.locator(sel).click();
    await page.locator('textarea[placeholder^="What should change here?"]').fill(note);
    await page.locator('[data-test="add-to-queue"]').click();
    await page.locator('[data-test="send-queue"]').click();
  };

  await annotate('li[data-lucid-id="step-backfill"]', "first note");
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(1);
  await cli.run(["wait", cli.artifact, "--reply", "agent replied here", "--timeout", "1"]);
  await expect(page.locator('[data-role="agent"]')).toHaveCount(1);
  await annotate("#note", "second note");
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(2);

  // The record is chronological: the later annotation sits BELOW the reply that
  // preceded it, rather than jumping into a pile above the conversation.
  const order = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-role], [data-test="annotation"]')).map(
      (el) => (el as HTMLElement).dataset.role ?? "annotation",
    ),
  );
  expect(order).toEqual(["annotation", "agent", "annotation"]);
});

test("annotations on one element cascade instead of hiding each other", async ({ page }) => {
  await openViewer(page);
  const surface = surfaceOf(page);
  for (const note of ["first", "second"]) {
    await surface.locator("#note").click();
    await page.locator('textarea[placeholder^="What should change here?"]').fill(note);
    await page.locator('[data-test="add-to-queue"]').click();
  }
  await page.locator('[data-test="send-queue"]').click();
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(2);

  // Same anchor -> same rect. Without a cascade both badges land on the same
  // pixel and only the last is reachable.
  const lefts = await surface
    .locator(".badge")
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  expect(lefts).toHaveLength(2);
  expect(lefts[0]).not.toBe(lefts[1]);
  expect(Math.abs((lefts[1] ?? 0) - (lefts[0] ?? 0))).toBe(13); // steps, still overlapping
});

test("an image pasted onto an annotation reaches the agent, located", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await page.locator('[data-test="annotation-note"]').fill("Looks like this instead");
  await page.evaluate(async () => {
    const b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "shot.png", { type: "image/png" }));
    document
      .querySelector('[data-test="annotation-note"]')
      ?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  await expect(page.locator('[data-test="annotation-chip"]')).toHaveCount(1);

  // The image travels with the queued item, through to the sent card.
  await page.locator('[data-test="add-to-queue"]').click();
  await expect(page.locator('[data-test="annotation-chip"]')).toHaveCount(1);
  await page.locator('[data-test="send-queue"]').click();
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(1);
  await expect(page.locator('[data-test="annotation-thumb"]')).toHaveCount(1);

  // It decoded, rather than merely resolving.
  const width = await page.evaluate(
    () =>
      (document.querySelector('[data-test="annotation-thumb"] img') as HTMLImageElement)
        .naturalWidth,
  );
  expect(width).toBeGreaterThan(0);

  // The agent gets the anchor and the bytes together: an absolute path to read
  // and the note saying what is wrong.
  const fb = (await cli.run(["wait", cli.artifact, "--since", nextCursor, "--timeout", "8"])) as {
    annotations: { note: string; images?: { name: string; file: string; path: string }[] }[];
  };
  expect(fb.annotations).toHaveLength(1);
  expect(fb.annotations[0]?.images).toHaveLength(1);
  expect(fb.annotations[0]?.images?.[0]?.name).toBe("shot.png");
  expect(fb.annotations[0]?.images?.[0]?.path).toContain("/pasted/");
});

test("a pasted image still renders in the conversation after a reload", async ({ page }) => {
  await openViewer(page);

  // A 1x1 red PNG, pasted the way the browser delivers a real screenshot.
  await page.locator('textarea[placeholder^="Message the agent"]').click();
  await page.evaluate(async () => {
    const b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "shot.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const ta = document.querySelector('[data-test="message-input"]') as HTMLTextAreaElement;
    ta.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  await expect(page.locator('[data-test="image-chip"]')).toHaveCount(1);

  await page.locator('textarea[placeholder^="Message the agent"]').fill("look at this");
  await page.locator('[data-test="send-message"]').click();
  await expect(page.locator('[data-test="thumb"]')).toHaveCount(1);

  // Reload: messages now come from the wait payload rather than the live SSE
  // frame. The payload rewrites images for the agent, and used to drop the
  // filename the viewer needs - so the thumb 404'd only after a reload.
  await page.reload();
  await expect(page.locator('[data-test="thumb"]')).toHaveCount(1);
  const decoded = await page.evaluate(() => {
    const img = document.querySelector('[data-test="thumb"] img') as HTMLImageElement | null;
    return img ? { src: img.getAttribute("src") ?? "", width: img.naturalWidth } : null;
  });
  expect(decoded?.src).not.toContain("undefined");
  expect(decoded?.width).toBeGreaterThan(0); // it actually decoded, not just resolved
});

test("a large text paste folds to a placeholder; the agent still gets every line", async ({
  page,
}) => {
  const { nextCursor } = await openViewer(page);

  // Forty lines of terminal output, pasted the way the browser delivers it.
  const wall = Array.from({ length: 40 }, (_, i) => `log line ${i}`).join("\n");
  const ta = page.locator('[data-test="message-input"]');
  await ta.click();
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    const el = document.querySelector('[data-test="message-input"]') as HTMLTextAreaElement;
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, wall);

  // The composer holds the placeholder, not the wall, and typing continues
  // after it as if the paste were one token.
  await expect(ta).toHaveValue("[Pasted text #1 +40 lines]");
  await ta.pressSequentially(" - why did this fail?");
  await page.locator('[data-test="send-message"]').click();

  // The human's turn renders folded: the head shows, the rest waits behind
  // the toggle, and expanding brings in the last line.
  const bubble = page.locator('[data-role="human"]');
  await expect(page.locator('[data-test="fold-toggle"]')).toContainText("show 34 more lines");
  await expect(bubble).not.toContainText("log line 39");
  await page.locator('[data-test="fold-toggle"]').click();
  await expect(bubble).toContainText("log line 39 - why did this fail?");

  // The agent reads what was actually pasted, not the placeholder.
  const fb = (await cli.run(["wait", cli.artifact, "--since", nextCursor, "--timeout", "8"])) as {
    messages: { text: string }[];
    nextCursor: string;
  };
  expect(fb.messages).toHaveLength(1);
  expect(fb.messages[0]?.text).toContain("log line 0");
  expect(fb.messages[0]?.text).toContain("log line 39 - why did this fail?");
  expect(fb.messages[0]?.text).not.toContain("Pasted text #1");

  // A later message that literally quotes the placeholder must NOT expand -
  // the staged paste was spent by the send that used it.
  await ta.fill("what did [Pasted text #1 +40 lines] contain?");
  await page.locator('[data-test="send-message"]').click();
  const fb2 = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    fb.nextCursor,
    "--timeout",
    "8",
  ])) as { messages: { text: string }[] };
  expect(fb2.messages).toHaveLength(1);
  expect(fb2.messages[0]?.text).toBe("what did [Pasted text #1 +40 lines] contain?");
});

test("scrolled-up readers are not yanked; the floating button brings them back", async ({
  page,
}) => {
  await openViewer(page);

  // Enough transcript to genuinely overflow - a viewport that cannot scroll is
  // always "at bottom", which would pass every assertion here vacuously.
  const filler = "detail ".repeat(40);
  for (let i = 0; i < 12; i++) {
    await cli.run(["wait", cli.artifact, "--reply", `filler ${i}: ${filler}`, "--timeout", "1"]);
  }
  await expect(page.locator('[data-role="agent"]')).toHaveCount(12);
  const vp = page.locator('[data-test="thread-viewport"]');
  expect(await vp.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);

  // Pinned to the bottom, the button is disabled and hidden.
  await expect(page.locator('[data-test="scroll-bottom"]')).toBeDisabled();

  // Scroll up the way a reader does - with the wheel; a new agent reply must
  // NOT yank the reader down.
  await vp.hover();
  await page.mouse.wheel(0, -4000);
  await expect.poll(async () => vp.evaluate((el) => el.scrollTop)).toBeLessThan(50);
  await cli.run([
    "wait",
    cli.artifact,
    "--reply",
    "one more while you were reading",
    "--timeout",
    "1",
  ]);
  await expect(page.locator('[data-role="agent"]')).toHaveCount(13);
  await page.waitForTimeout(400); // any yank would have happened by now
  expect(await vp.evaluate((el) => el.scrollTop)).toBeLessThan(50);

  // The affordance is live while scrolled up, and returns the reader.
  const btn = page.locator('[data-test="scroll-bottom"]');
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect
    .poll(async () => vp.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
    .toBeLessThan(30);
  await expect(btn).toBeDisabled();
});

test("the working indicator opens when the agent takes delivery and closes on its reply", async ({
  page,
}) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  // No agent has taken anything yet.
  await expect(page.locator('[data-test="agent-working"]')).toHaveCount(0);

  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await page.locator('[data-test="annotation-note"]').fill("Backfill in one batch");
  await page.locator('[data-test="add-to-queue"]').click();
  await page.locator('[data-test="send-queue"]').click();
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(1);

  // The agent takes delivery: wait returns feedback and acks it. The viewer
  // flips to "agent is working".
  const fb = (await cli.run(["wait", cli.artifact, "--since", nextCursor, "--timeout", "8"])) as {
    status: string;
    nextCursor: string;
  };
  expect(fb.status).toBe("feedback");
  await expect(page.locator('[data-test="agent-working"]')).toBeVisible();
  await expect(page.locator('[data-test="agent-working"]')).toContainText("Agent responding");

  // The agent's reply closes the window.
  await cli.run(["wait", cli.artifact, "--reply", "Batched.", "--timeout", "1"]);
  await expect(page.locator('[data-test="agent-working"]')).toHaveCount(0);
  await expect(page.locator('[data-role="agent"]')).toContainText("Batched.");
});

test("the composer says whether an agent is listening", async ({ page }) => {
  await openViewer(page);
  const line = page.locator('[data-test="listener-line"]');

  // Nobody is waiting on a fresh session.
  await expect(line).toHaveAttribute("data-listening", "false");
  // The standalone viewer has no hub, so nothing spawns. The mode is named as
  // a term (the detail is on hover) rather than restating a sentence above the
  // composer on every turn.
  await expect(line).toContainText("recording only");

  // An agent blocks in wait: its waker connects and the line flips - live via
  // the synthetic listeners frame, no reload.
  const waiting = cli.run(["wait", cli.artifact, "--since", "evt_00001", "--timeout", "6"]);
  await expect(line).toHaveAttribute("data-listening", "true");
  await expect(line).toContainText("agent listening");

  // The wait window closes with nothing to deliver; the waker disconnects.
  await waiting;
  await expect(line).toHaveAttribute("data-listening", "false");
});

test("declared revise intent puts an update-on-the-way spinner on the surface", async ({
  page,
}) => {
  await openViewer(page);

  // Delivery, then declared intent - the shimmer names it and the surface
  // announces it where reading starts.
  await page.evaluate(() =>
    fetch("/__lucid/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "i-ack" }),
    }),
  );
  await expect(page.locator('[data-test="agent-working"]')).toContainText("Agent responding");
  await expect(page.locator('[data-test="surface-updating"]')).toHaveCount(0);

  await page.evaluate(() =>
    fetch("/__lucid/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "i-intent", intent: "revise" }),
    }),
  );
  await expect(page.locator('[data-test="surface-updating"]')).toBeVisible();
  await expect(page.locator('[data-test="agent-working"]')).toContainText("Updating the artifact");

  // Real output closes the window and the spinner with it.
  await cli.run(["wait", cli.artifact, "--reply", "done", "--timeout", "1"]);
  await expect(page.locator('[data-test="surface-updating"]')).toHaveCount(0);
  await expect(page.locator('[data-test="agent-working"]')).toHaveCount(0);
});

test("a dropped live connection shows a self-clearing indicator, not a warning pile", async ({
  page,
}) => {
  await openViewer(page);
  await expect(page.locator('[data-test="reconnecting"]')).toHaveCount(0);

  // Stop the server out from under the viewer.
  await cli.run(["end", cli.artifact]);
  await expect(page.locator('[data-test="reconnecting"]')).toBeVisible();

  // EventSource retries by itself, so this must never tell the human to reload,
  // and must never pile up one warning per failed attempt.
  await page.waitForTimeout(1500);
  await expect(page.locator('[data-test="reconnecting"]')).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText("reload to resume");

  // ...and it clears itself once the stream is back.
  await cli.run(["open", cli.artifact]);
  await expect(page.locator('[data-test="reconnecting"]')).toHaveCount(0, { timeout: 15_000 });
});

test("a message sent at a dead server is kept, not eaten, and delivers itself on reconnect", async ({
  page,
}) => {
  await openViewer(page);
  const composer = page.locator('textarea[placeholder^="Message the agent"]');
  const first = "Confirm the routing: Patch re-enters at Test, not Build.";
  const second = "Also: Land is the right name for the phase, not Merge.";

  // The server goes out from under the viewer - the failure this whole path
  // exists for. The composer keeps working; only the POST cannot land.
  await cli.run(["end", cli.artifact]);
  await expect(page.locator('[data-test="reconnecting"]')).toBeVisible();

  await composer.fill(first);
  await page.locator('[data-test="send-message"]').click();

  // assistant-ui empties the composer on Enter, so this card is the only place
  // the typing still exists. It must exist.
  await expect(page.locator('[data-test="unsent-message"]')).toContainText(first);
  await expect(composer).toHaveValue("");
  // ...and be recoverable by hand, not just by retry.
  await expect(page.locator('[data-test="copy-unsent"]')).toBeVisible();

  // A second message during the same outage gets its own card. Nothing may hide
  // behind the first: an invisible entry still blocks approval, with no way to
  // retry or discard it.
  await composer.fill(second);
  await page.locator('[data-test="send-message"]').click();
  await expect(page.locator('[data-test="unsent-message"]')).toHaveCount(2);

  // Approving would strand them behind a stop the agent has already acted on.
  await expect(page.locator('[data-test="approve"]')).toBeDisabled();
  await page.locator('[data-test="approve-wrap"]').hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(
    "2 undelivered messages",
  );

  // Durability is the claim, so prove it against a genuinely new JS instance
  // rather than the one that did the typing: leave the origin entirely, bring
  // the server back, and return. Nothing in memory survives that.
  await page.goto("about:blank");
  const reopened = (await cli.run(["open", cli.artifact])) as {
    url: string;
    nextCursor: string;
  };
  await page.goto(reopened.url);

  // The restored outbox drains on its own - no gesture from the human - and both
  // messages take their normal place in the record, in the order they were typed.
  await expect(page.locator('[data-test="unsent-message"]')).toHaveCount(0, { timeout: 20_000 });
  const humanTurns = page.locator('[data-role="human"]');
  await expect(humanTurns).toHaveCount(2);
  await expect(humanTurns.first()).toContainText("Patch re-enters at Test");
  await expect(humanTurns.last()).toContainText("Land is the right name");
  await expect(page.locator('[data-test="approve"]')).toBeEnabled();

  // And the agent actually receives them - the cards were never a consolation prize.
  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    reopened.nextCursor,
    "--timeout",
    "8",
  ])) as { status: string; messages: { role: string; text: string }[] };
  expect(fb.status).toBe("feedback");
  const delivered = fb.messages.filter((m) => m.role === "human").map((m) => m.text);
  expect(delivered.some((t) => t.includes("Patch re-enters at Test"))).toBe(true);
  expect(delivered.some((t) => t.includes("Land is the right name"))).toBe(true);
});

test("a stale viewer never posts its message into whichever session took its port", async ({
  page,
}) => {
  await openViewer(page);
  const stale = page.url();
  const composer = page.locator('textarea[placeholder^="Message the agent"]');

  // This session goes away, freeing its port back to the shared pool.
  await cli.run(["end", cli.artifact]);
  await expect(page.locator('[data-test="reconnecting"]')).toBeVisible();

  await composer.fill("Renumber the phases in the overview.");
  await page.locator('[data-test="send-message"]').click();
  await expect(page.locator('[data-test="unsent-message"]')).toHaveCount(1);

  // A DIFFERENT artifact opens and takes that address. The stale tab's stream
  // reconnects to it quite happily - but the message belongs to the old session,
  // and delivering it here would hand it to the wrong agent.
  const other = await makeCli(PLAN_V2);
  try {
    const otherSession = (await other.run(["open", other.artifact])) as {
      url: string;
      nextCursor: string;
    };
    test.skip(new URL(otherSession.url).port !== new URL(stale).port, "port was not reused");

    await expect(page.locator('[data-test="unsent-message"]')).toHaveCount(1);
    await expect(page.locator("body")).toContainText("A different session is running");

    // The other session's agent must see nothing at all.
    const fb = (await other.run([
      "wait",
      other.artifact,
      "--since",
      otherSession.nextCursor,
      "--timeout",
      "2",
    ])) as { messages?: { role: string }[] };
    expect(fb.messages?.some((m) => m.role === "human") ?? false).toBe(false);
  } finally {
    await other.cleanup();
  }
});

test("double-clicking the divider fits the surface to the document", async ({ page }) => {
  await openViewer(page);
  const divider = page.locator('[aria-label="Resize the review panel"]');
  // The panel owns its width through --sidebar-width on the sidebar wrapper, so
  // the drag and the collapse share one lever; read the resolved gap width the
  // sidebar actually lays out to.
  const panelWidth = async () =>
    Number.parseFloat(
      await page.locator('[data-slot="sidebar-gap"]').evaluate((el) => getComputedStyle(el).width),
    );

  // The gap animates its width (transition-[width]); getComputedStyle samples
  // mid-transition, so settle to a stable value before measuring.
  const settledWidth = async (): Promise<number> => {
    let prev = await panelWidth();
    for (;;) {
      await page.waitForTimeout(120);
      const now = await panelWidth();
      if (now === prev) return now;
      prev = now;
    }
  };

  const before = await settledWidth();
  await divider.dblclick();
  // The chrome cannot measure the surface itself - it is on an opaque origin,
  // so contentDocument is null. The width only changes if the overlay measured
  // and posted back across the boundary.
  await expect.poll(panelWidth).not.toBe(before);
  const fitted = await settledWidth();
  expect(fitted).toBeGreaterThanOrEqual(320); // never below the panel minimum

  // Arrow keys resize too, so the divider is not pointer-only. The panel
  // sits on the RIGHT (artifact-first D9), so ArrowLeft grows it.
  await divider.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(settledWidth).toBe(fitted + 16);
});

test("the panel tabs switch between review and sessions, and the panel collapses to reflow", async ({
  page,
}) => {
  await openViewer(page);
  const gap = page.locator('[data-slot="sidebar-gap"]');

  // The review tab is the default face of the panel; the composer is present.
  await expect(page.locator('[data-test="message-input"]')).toBeVisible();
  const openWidth = Number.parseFloat(await gap.evaluate((el) => getComputedStyle(el).width));
  expect(openWidth).toBeGreaterThan(300);

  // Switch to Sessions: the current session lists itself as "you are here", and
  // the composer survives underneath (keepMounted), it is only hidden.
  await page.locator('[data-test="tab-sessions"]').click();
  await expect(page.locator('[data-test="sessions-list"]')).toBeVisible();
  await expect(page.locator('[data-test="session-row"]')).toHaveCount(1);
  await expect(page.locator('[data-test="sessions-list"]')).toContainText("you are here");
  await expect(page.locator('[data-test="message-input"]')).toBeHidden();

  // Back to review; the composer is shown again, never remounted.
  await page.locator('[data-test="tab-chat"]').click();
  await expect(page.locator('[data-test="message-input"]')).toBeVisible();

  // Closing the panel collapses the gap to zero - the artifact reflows into the
  // space rather than being covered by an overlay.
  await page.locator('[data-test="panel-toggle"]').click();
  await expect
    .poll(async () => Number.parseFloat(await gap.evaluate((el) => getComputedStyle(el).width)))
    .toBe(0);
  // The divider goes with it: there is no panel edge to drag while collapsed.
  await expect(page.locator('[aria-label="Resize the review panel"]')).toHaveCount(0);

  // Reopen restores the panel to its width.
  await page.locator('[data-test="panel-toggle"]').click();
  await expect
    .poll(async () => Number.parseFloat(await gap.evaluate((el) => getComputedStyle(el).width)))
    .toBe(openWidth);
});

test("the target toggle quiets the surface for reading and restores it", async ({ page }) => {
  await openViewer(page);
  const surface = surfaceOf(page);
  const marker = surface.locator(".marker");
  const toggle = page.locator('[data-test="toggle-targets"]');

  // Targets are on by default, so a sent annotation paints a mark.
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await page.locator('textarea[placeholder^="What should change here?"]').fill("A note");
  await page.locator('[data-test="add-to-queue"]').click();
  await page.locator('[data-test="send-queue"]').click();
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(1);
  await expect(marker).toHaveCount(1);

  // Read mode: marks gone, and clicking the artifact no longer picks a target -
  // the overlay must stop swallowing clicks, not just stop painting.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(marker).toHaveCount(0);
  await surface.locator("#note").click();
  await expect(page.locator('textarea[placeholder^="What should change here?"]')).toHaveCount(0);

  // The annotation itself is untouched - this is a view preference, not a delete.
  await expect(page.locator('[data-test="annotation"]')).toHaveCount(1);

  // Toggling back repaints from anchors the overlay kept the whole time.
  await toggle.click();
  await expect(marker).toHaveCount(1);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
});

test("change-view hunk navigation does not steal keys from a text field", async ({ page }) => {
  await openViewer(page);
  const surface = surfaceOf(page);

  // Commit v2 so change view is reachable, then queue an annotation and edit it.
  await cli.write(PLAN_V2);
  await expect(page.locator('[data-test="version"]')).toContainText("v2");
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await page.locator('textarea[placeholder^="What should change here?"]').fill("ABCDEF");
  await page.locator('[data-test="add-to-queue"]').click();
  await page.locator('[data-test="enter-diff"]').click();
  await expect(page.locator('[data-test="enter-diff"]')).toHaveCount(0);
  await page.locator('[data-test="edit-queued"]').click();

  // Arrows move the caret rather than jumping hunks...
  const box = page.locator('[data-test="edit-note"]');
  await box.click();
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(4, 4));
  await page.keyboard.press("ArrowLeft");
  expect(await box.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(3);

  // ...and Escape cancels the edit without also exiting change view.
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(page.locator('[data-test="enter-diff"]')).toHaveCount(0);
});

test("defer-until-committed shows the newer-version indicator and never loses a draft", async ({
  page,
}) => {
  await openViewer(page);
  const surface = surfaceOf(page);

  // Compose (but do not send) an annotation - a committed-but-unsent draft.
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await page.locator('textarea[placeholder^="What should change here?"]').fill("Draft in flight");
  await page.locator('[data-test="add-to-queue"]').click();
  await expect(page.locator('[data-test="send-queue"]')).toBeVisible();

  // A new version arrives while the draft is queued -> swap deferred, indicator shown.
  await cli.write(PLAN_V2);
  await expect(page.locator('[data-test="newer-version"]')).toBeVisible();
  // Surface still shows the old version (swap deferred).
  await expect(surface.locator("h1")).not.toContainText("revised");

  // Sending the draft releases the deferred swap.
  await page.locator('[data-test="send-queue"]').click();
  await expect(page.locator('[data-test="newer-version"]')).toHaveCount(0);
  await expect(surface.locator("h1")).toContainText("revised");
});

test("the newer-version banner names the real blocker and only offers a live discard", async ({
  page,
}) => {
  await openViewer(page);
  const surface = surfaceOf(page);
  const banner = page.locator('[data-test="newer-version"]');

  // A queue is not discardable, so the banner must ask for a send and show no
  // Discard button - it could only ever clear the composer, not the queue.
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await page.locator('textarea[placeholder^="What should change here?"]').fill("Queued work");
  await page.locator('[data-test="add-to-queue"]').click();
  await cli.write(PLAN_V2);
  await expect(banner).toContainText("send your 1 queued annotation to see it");
  await expect(page.locator('[data-test="discard-draft"]')).toHaveCount(0);

  // A composer draft on top of the queue is discardable, so the button returns.
  await surface.locator("#note").click();
  await page.locator('textarea[placeholder^="What should change here?"]').fill("Composer draft");
  await expect(banner).toContainText("or discard your draft");
  await expect(page.locator('[data-test="discard-draft"]')).toBeVisible();

  // Discarding it clears only the composer - the queue survives, swap still deferred.
  await page.locator('[data-test="discard-draft"]').click();
  await expect(page.locator('[data-test="send-queue"]')).toBeVisible();
  await expect(page.locator("[data-annotation-id]")).toContainText("Queued work");
  await expect(banner).toContainText("send your 1 queued annotation to see it");
  await expect(surface.locator("h1")).not.toContainText("revised");
});

test("agent question surfaces in the viewer and the answer reaches the agent", async ({ page }) => {
  const { nextCursor } = await openViewer(page);

  // Agent poses a question.
  await cli.run(["ask", cli.artifact, "--text", "Should backfill run before the cutover?"]);

  // It surfaces in the drawer over the artifact.
  await expect(page.locator('[data-test="question"]')).toContainText("Should backfill run before");

  // Human answers it.
  await page.locator('[data-test="free-text"]').fill("Yes - backfill must finish first.");
  await page.locator('[data-test="answer"]').click();
  // Answered -> the drawer goes away and the question enters the RECORD, as one
  // question+answer item at the answer moment (D14).
  await expect(page.locator('[data-test="question-drawer"]')).toHaveCount(0);
  await expect(page.locator('[data-test="qa"]')).toContainText("Should backfill run before");
  await expect(page.locator('[data-test="qa-answer"]')).toContainText("backfill must finish first");

  // The answer reaches the agent as feedback.
  const fb = (await cli.run(["wait", cli.artifact, "--since", nextCursor, "--timeout", "8"])) as {
    status: string;
    questions?: { answered: boolean; answer?: string }[];
  };
  expect(fb.status).toBe("feedback");
  expect(fb.questions?.[0]?.answered).toBe(true);
  expect(fb.questions?.[0]?.answer).toContain("backfill must finish first");
});

test("diff view shows changes since a version and revert reaches the agent", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  // Agent revises v1 -> v2; the viewer live-reloads.
  await cli.write(PLAN_V2);
  await expect(surface.locator("h1")).toContainText("revised");
  await expect(page.locator('[data-test="version"]')).toContainText("v2");

  // Enter the change view.
  await page.locator('[data-test="enter-diff"]').click();
  await expect(page.locator('[data-test="diff-bar"]')).toBeVisible();
  await expect(page.locator('[data-test="diff-count"]')).toContainText("/");

  // The surface shows in-place diff markup (sage adds/changes, ghost removes).
  // A changed block stacks its old version over the new one, in place.
  expect(await surface.locator("[data-diff]").count()).toBeGreaterThan(0);
  expect(await surface.locator(".lucid-diff-now").count()).toBeGreaterThan(0);

  // An undo needs no essay: the box is empty, the button still works, and the
  // agent receives an instruction that reads on its own.
  await expect(page.locator('[data-test="revert"]')).toBeEnabled();
  // And the button says what a revert IS - a request to the agent, not an undo
  // the viewer performs.
  await page.locator('[data-test="revert"]').hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText("Forward-only");
  // With a reason, that reason is what reaches the agent.
  await page.locator('[data-test="revert-why"]').fill("keep the nightly backfill");
  await page.locator('[data-test="revert"]').click();

  const fb = (await cli.run(["wait", cli.artifact, "--since", nextCursor, "--timeout", "8"])) as {
    status: string;
    nextCursor: string;
    reverts?: { targetVersion: number; why: string }[];
  };
  expect(fb.reverts?.[0]?.targetVersion).toBe(1);
  expect(fb.reverts?.[0]?.why).toContain("nightly backfill");

  const cursor2 = fb.nextCursor;
  await page.locator('[data-test="revert"]').click();
  const blank = (await cli.run(["wait", cli.artifact, "--since", cursor2, "--timeout", "8"])) as {
    reverts?: { targetVersion: number; why: string }[];
  };
  expect(blank.reverts?.[0]?.why).toContain("restore to v1");

  // Exit the change view.
  await page.locator('[data-test="diff-done"]').click();
  await expect(page.locator('[data-test="diff-bar"]')).toHaveCount(0);
});
