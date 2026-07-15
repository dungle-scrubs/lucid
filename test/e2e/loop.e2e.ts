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

  // It surfaces in the "Questions for you" panel.
  await expect(page.locator('[data-test="question"]')).toContainText("Should backfill run before");

  // Human answers it.
  await page.locator('[data-test="question"] .qinput').fill("Yes - backfill must finish first.");
  await page.locator('[data-test="answer"]').click();
  await expect(page.locator('[data-test="question-answered"]')).toContainText(
    "backfill must finish first",
  );

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
  expect(await surface.locator("[data-diff]").count()).toBeGreaterThan(0);
  expect(await surface.locator("ins.lucid-ins").count()).toBeGreaterThan(0);

  // Revert the current change back to v1, with a reason; the agent receives it.
  await page.locator('[data-test="revert-why"]').fill("keep the nightly backfill");
  await page.locator('[data-test="revert"]').click();

  const fb = (await cli.run(["wait", cli.artifact, "--since", nextCursor, "--timeout", "8"])) as {
    status: string;
    reverts?: { targetVersion: number; why: string }[];
  };
  expect(fb.reverts?.[0]?.targetVersion).toBe(1);
  expect(fb.reverts?.[0]?.why).toContain("nightly backfill");

  // Exit the change view.
  await page.locator('[data-test="diff-done"]').click();
  await expect(page.locator('[data-test="diff-bar"]')).toHaveCount(0);
});
