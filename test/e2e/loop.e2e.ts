import { hook, mod, on } from "./locators.ts";
import { expect, test, type FrameLocator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_OUTLINE_POLICY } from "../../client/shared/artifact-outline.ts";
import {
  PLAN_V1,
  PLAN_V2,
  makeCli,
  outlineDebugInfo,
  overlaySettled,
  overlaps,
  type Cli,
  waitTimeoutSeconds,
} from "./helpers.ts";

let cli: Cli;

test.afterEach(async () => {
  await cli?.cleanup();
});

const surfaceOf = (page: Page): FrameLocator =>
  page.frameLocator('iframe[title="artifact surface"]');

const openViewer = async (
  page: Page,
  html: string = PLAN_V1,
  expectedTitle = "Database migration plan",
): Promise<{ nextCursor: string }> => {
  cli = await makeCli(html);
  const session = (await cli.run(["open", cli.artifact])) as { url: string; nextCursor: string };
  await page.goto(session.url);
  await expect(surfaceOf(page).locator("h1")).toContainText(expectedTitle);
  return { nextCursor: session.nextCursor };
};

interface OutlinePublicationProbe {
  readonly errors: string[];
  readonly messages: Array<Record<string, unknown>>;
  readonly port: MessagePort | null;
  readonly windowOutlineMessages: number;
}

type OutlinePublicationProbeView = Omit<OutlinePublicationProbe, "port"> & {
  readonly connected: boolean;
};

const installOutlinePublicationProbe = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const state: OutlinePublicationProbe = {
      errors: [],
      messages: [],
      port: null,
      windowOutlineMessages: 0,
    };
    Object.defineProperty(window, "__outlineTest", { value: state });
    window.addEventListener("message", (event) => {
      if (
        event.data?.source === "lucid-overlay-bootstrap" &&
        event.data.type === "private-channel" &&
        state.port === null
      ) {
        const port = event.ports[0] ?? null;
        Object.defineProperty(state, "port", { configurable: true, value: port });
        if (port) {
          port.addEventListener("message", (message) =>
            state.messages.push(message.data as Record<string, unknown>),
          );
          port.start();
        }
      } else if (event.data?.type === "outline-snapshot") {
        Object.defineProperty(state, "windowOutlineMessages", {
          configurable: true,
          value: state.windowOutlineMessages + 1,
        });
      }
    });
    window.addEventListener("error", (event) =>
      state.errors.push(event.error?.stack ?? event.message),
    );
  });
};

const outlineProbe = async (page: Page): Promise<OutlinePublicationProbeView> =>
  page.evaluate(() => {
    const state = (window as unknown as { __outlineTest: OutlinePublicationProbe }).__outlineTest;
    return {
      connected: state.port !== null,
      errors: state.errors,
      messages: state.messages,
      windowOutlineMessages: state.windowOutlineMessages,
    };
  });

const outlineProbeMessages = async (page: Page): Promise<Array<Record<string, unknown>>> =>
  (await outlineProbe(page)).messages;

const outlineProbeSnapshots = async (page: Page): Promise<Array<Record<string, unknown>>> =>
  (await outlineProbeMessages(page)).filter(({ type }) => type === "outline-snapshot");

const latestOutlineProbeSnapshot = async (page: Page): Promise<Record<string, unknown> | null> =>
  (await outlineProbeSnapshots(page)).at(-1) ?? null;

const outlineProbeSnapshotCount = async (page: Page): Promise<number> =>
  (await outlineProbeSnapshots(page)).length;

const waitForOutlineProbeConnection = async (page: Page): Promise<void> => {
  await expect.poll(async () => (await outlineProbe(page)).connected).toBe(true);
};

const postOutlineProbeMessage = async (
  page: Page,
  message: Record<string, unknown>,
): Promise<void> => {
  await page.evaluate((outbound) => {
    const state = (window as unknown as { __outlineTest: OutlinePublicationProbe }).__outlineTest;
    state.port?.postMessage(outbound);
  }, message);
};

const requestOutlineProbeLayout = async (page: Page): Promise<void> => {
  await postOutlineProbeMessage(page, {
    type: "outline-layout-request",
    generation: 1_000_000,
    preferredWidth: 240,
    safeInsets: { top: 80, right: 20, bottom: 24 },
  });
};

const openOutlineProbeArtifact = async (page: Page, artifact: string): Promise<void> => {
  await page.setViewportSize({ width: 2_400, height: 900 });
  await installOutlinePublicationProbe(page);
  await openViewer(page, artifact);
  await waitForOutlineProbeConnection(page);
  await requestOutlineProbeLayout(page);
};

test("Enter sends the message, which is what the composer's placeholder promises", async ({
  page,
}) => {
  // The box says "Enter to send, Shift+Enter for a new line". Nothing tested
  // it, so a regression there would only ever be found by a human typing.
  await openViewer(page);
  const input = page.locator(`${hook("message-input")}:visible`);
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
  await expect(on(page).annotationNote()).toBeVisible();

  await page
    .locator(hook("annotation-note"))
    .fill("Backfill in one batch, not nightly - nightly will take weeks.");
  await on(page).addToQueue().click();
  await expect(on(page).sendQueue()).toBeVisible();
  await on(page).sendQueue().click();

  // The annotation echoes back via SSE and renders in the chrome list.
  await expect(on(page).annotation()).toHaveCount(1);

  // The agent receives located feedback via wait.
  const feedback = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
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
  await expect(on(page).version()).toContainText("v2");

  // A version-only delta returns `waiting`, not feedback (D-062).
  const afterRevise = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    feedback.nextCursor,
    "--timeout",
    waitTimeoutSeconds(4),
  ])) as {
    status: string;
    version: number;
  };
  expect(afterRevise.status).toBe("waiting");
  expect(afterRevise.version).toBe(2);
});

test("hostile marker payloads fail closed at the global render budget", async ({ page }) => {
  await openViewer(page);
  const surface = surfaceOf(page);
  await surface.locator("#__lucid_overlay_root").evaluate(async (root) => {
    const overlay = root.firstElementChild as
      | (HTMLElement & {
          markers: unknown[];
          requestUpdate(): void;
          updateComplete: Promise<unknown>;
        })
      | null;
    if (!overlay) throw new Error("owned overlay missing");
    const rects = Array.from({ length: 64 }, (_, index) => ({
      height: 10,
      left: index,
      top: index,
      width: 10,
    }));
    overlay.markers = Array.from({ length: 9 }, (_, index) => ({
      id: `hostile-${index}`,
      index: index + 1,
      rects,
      stackIndex: 0,
      state: "committed",
    }));
    overlay.requestUpdate();
    await overlay.updateComplete;
  });

  await expect(surface.locator("[data-annotation-id]")).toHaveCount(0);
});

test("lucid progress renders a distinct fan-out indicator that output clears", async ({ page }) => {
  await openViewer(page);

  // The agent farms the revision out to parallel subagents and self-reports.
  await cli.run(["progress", cli.artifact, "--label", "auditing 7 screens", "--total", "7"]);
  const fanout = page.locator(`${hook("agent-working")}[data-fanout="true"]`);
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
  await expect(on(page).agentWorking()).toHaveCount(0);
});

test("context usage renders a header ring that updates live", async ({ page }) => {
  await openViewer(page);

  // No report yet -> no ring.
  await expect(on(page).contextRing()).toHaveCount(0);

  // The harness (its statusline) reports usage; the ring appears via SSE.
  await cli.run(["context", cli.artifact, "--used", "142000", "--total", "200000"]);
  const ring = on(page).contextRing();
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
  await expect(on(page).questionDrawer()).toBeVisible();
  const choices = on(page).choice();
  await expect(choices).toHaveCount(2);
  await choices.first().click();
  await expect(choices.first()).toHaveAttribute("aria-checked", "true");

  // Pin a region of the artifact as the answer's referent - the surface stays
  // live under the drawer, which is the point of a drawer rather than a modal.
  await on(page).pinRegion().click();
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await expect(on(page).answerAnchor()).toBeVisible();

  // Send the answer; it reaches wait with the chosen option and the pinned region.
  await on(page).answer().click();
  // Answered -> the drawer lowers (nothing outstanding) and the exchange enters
  // the record. An options-only answer has no free text, so the card has to read
  // the chosen labels or it would print an empty answer over a real decision.
  await expect(on(page).questionDrawer()).toHaveCount(0);
  await expect(on(page).qaAnswer()).toContainText("Postgres");
  const payload = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
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

  await expect(on(page).questionDrawer()).toBeVisible();
  const options = on(page).choice();
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
  await expect(on(page).questionDrawer()).toHaveCount(0);

  const payload = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as { questions?: { answered: boolean; answerOptions?: string[] }[] };
  const q = payload.questions?.[0];
  expect(q?.answered).toBe(true);
  expect(q?.answerOptions).toEqual(["Category", "Spam"]);
});

test("a question can be skipped: it leaves the panel and the agent is told", async ({ page }) => {
  const { nextCursor } = await openViewer(page);

  await cli.run(["ask", cli.artifact, "--text", "Do you have the API keys?"]);
  await expect(on(page).questionDrawer()).toBeVisible();

  // Decline without answering.
  await on(page).skip().click();
  await expect(on(page).questionDrawer()).toHaveCount(0);

  // The agent learns it was declined, not answered with content.
  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
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
  const q = on(page).questionText();
  await expect(q).toBeVisible();
  // Markdown, not literal source: the fence became a code block and its
  // backticks are gone from the text.
  await expect(q.locator("pre code")).toContainText("lucid ask plan.html");
  await expect(q).not.toContainText("```");

  // Short question, no disclosure: the fold only exists for walls.
  // Absent by design, so there is no hook in the product to generate from.
  await expect(page.locator(hook("question-fold"))).toHaveCount(0);

  // "I don't understand this" - the note says what was confusing. A bare
  // --text ask renders as a free-text field in the drawer.
  await on(page).freeText().fill("which schema do you mean?");
  await on(page).reask().click();
  await expect(on(page).questionDrawer()).toHaveCount(0);

  // The agent is told to ask again rather than that it was answered or declined.
  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
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
  const text = on(page).questionText();
  await expect(text).toBeVisible();
  // Absent by design, so there is no hook in the product to generate from.
  await expect(page.locator(hook("question-fold"))).toHaveCount(0);
  await expect(text).toContainText("Paragraph 12");

  const drawer = on(page).questionDrawer();
  const surfaceBox = await page.locator('iframe[title="artifact surface"]').boundingBox();
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox?.height ?? Infinity).toBeLessThanOrEqual((surfaceBox?.height ?? 0) * 0.62);
  const scrollable = await drawer.evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(scrollable).toBe(true);

  // However tall the question, the drawer never eats the composer that answers it.
  await expect(on(page).messageInput()).toBeVisible();
});

test("fork button spins the selection off; the request reaches wait as a fork", async ({
  page,
}) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  // Pick a region, type the directive, and Fork instead of annotating in place.
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await page
    .locator(hook("annotation-note"))
    .fill("Turn the backfill into its own implementation plan.");
  await on(page).fork().click();

  // The composer clears (a fork is sent on click, not queued) and nothing lands
  // in the annotation list.
  await expect(on(page).annotationNote()).toHaveCount(0);
  await expect(on(page).annotation()).toHaveCount(0);

  // The agent receives the fork - not an annotation - via wait.
  const feedback = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
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
  await expect(on(page).annotationNote()).toBeVisible();
  await on(page).fork().click();

  // A neutral confirmation appears and the composer clears.
  await expect(page.getByText(/Fork(ed)?/)).toBeVisible();
  await expect(on(page).annotationNote()).toHaveCount(0);

  // The fork reached wait with the default directive.
  const feedback = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as { status: string; forks?: { note: string }[] };
  expect(feedback.forks).toHaveLength(1);
  expect(feedback.forks?.[0]?.note.length).toBeGreaterThan(0);
});

test("Esc discards the annotation being composed", async ({ page }) => {
  await openViewer(page);
  const surface = surfaceOf(page);

  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  const composer = on(page).annotationNote();
  await expect(composer).toBeVisible();
  await composer.fill("never mind this one");
  await composer.press("Escape");

  // The composer is dismissed and nothing was queued.
  await expect(composer).toHaveCount(0);
  await expect(on(page).sendQueue()).toHaveCount(0);
});

test("cmd+enter queues the open note and sends the whole queue", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);

  // Queue one annotation, then start a second and flush both with cmd+enter -
  // the shortcut folds the in-progress note into the queue before sending.
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await on(page).annotationNote().fill("Batch the backfill.");
  await on(page).addToQueue().click();
  await expect(on(page).sendQueue()).toBeVisible();

  await surface.locator("#note").click();
  const composer = on(page).annotationNote();
  await composer.fill("Cut over on a weekend.");
  await composer.press("ControlOrMeta+Enter");

  // Both annotations echo back via SSE and the queue clears.
  await expect(on(page).annotation()).toHaveCount(2);
  await expect(on(page).sendQueue()).toHaveCount(0);

  const feedback = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
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
    waitTimeoutSeconds(1),
  ]);
  await expect(page.locator('[data-role="agent"]')).toContainText("reordered and batched");
});

test("human message (non-located) reaches the agent as feedback", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  await on(page).messageInput().fill("Overall: tighten the wording.");
  await on(page).sendMessage().click();
  await expect(page.locator('[data-role="human"]')).toContainText("tighten the wording");

  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
    status: string;
    messages: { role: string; text: string }[];
  };
  expect(fb.status).toBe("feedback");
  expect(fb.messages.some((m) => m.role === "human" && m.text.includes("tighten"))).toBe(true);
});

test("approve/resolve closes the loop and reopen clears it", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  await on(page).approve().click();
  await expect(on(page).resolvedBar()).toBeVisible();

  const resolved = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(6),
  ])) as {
    reviewResolved: boolean;
    nextCursor: string;
  };
  expect(resolved.reviewResolved).toBe(true);

  // Reopen clears the resolved state (D-059).
  await on(page).reopen().click();
  await expect(on(page).resolvedBar()).toHaveCount(0);
});

test("reopen with nobody listening says feedback is record-only", async ({ page }) => {
  // No agent ever connects in this test, so the listening count is
  // deterministically zero - the exact state approval leaves behind.
  await openViewer(page);
  await on(page).approve().click();
  await expect(on(page).resolvedBar()).toBeVisible();

  await on(page).reopen().click();
  await expect(on(page).resolvedBar()).toHaveCount(0);
  await expect(page.getByText("no agent is listening right now")).toBeVisible();
});

test("reopen on an ended session explains the way back instead of failing", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  await on(page).approve().click();
  await expect(on(page).resolvedBar()).toBeVisible();
  await cli.run(["wait", cli.artifact, "--since", nextCursor, "--timeout", waitTimeoutSeconds(6)]);
  // The wait's delivery ack opens the working indicator...
  await expect(on(page).agentWorking()).toBeVisible();
  await cli.run(["end", cli.artifact]);
  // ...and session_ended closes it - the observable proof the browser has
  // processed the ended state before we click.
  await expect(on(page).agentWorking()).toHaveCount(0);

  // Reopen must not fire a doomed POST at a dead server and claim "try
  // again" would help.
  const reopen = on(page).reopen();
  await expect(reopen).toBeVisible();
  await reopen.click();
  await expect(page.getByText("needs the agent to run")).toBeVisible();
});

test("approve refuses while anything is unsent, so nothing is stranded", async ({ page }) => {
  const { nextCursor } = await openViewer(page);
  const surface = surfaceOf(page);
  const approve = on(page).approve();
  await expect(approve).toBeEnabled();

  // A half-composed annotation already blocks: approving would abandon it.
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await on(page).annotationNote().fill("Backfill in one batch");
  await expect(approve).toBeDisabled();
  // The reason lives on the disabled button, not in the header bar.
  await expect(on(page).approve()).toBeDisabled();
  await on(page).approveWrap().hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText(
    "draft annotation first",
  );

  // And CLICKING says why, without hovering. A disabled button emits no
  // pointer events, so the wrapper takes the click - otherwise the primary
  // action is silently dead, which is what it looked like from the outside.
  // The queue and the outbox each have their own visible card saying what is
  // unfinished; a draft has neither, so this is the only surface that can.
  await on(page).approveWrap().click();
  await expect(on(page).warning()).toContainText("draft annotation");

  // Queued still blocks, and says how many.
  await on(page).addToQueue().click();
  await expect(approve).toBeDisabled();
  await on(page).approveWrap().hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText("1 queued annotation");

  // Sending clears the block...
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(on(page).resolvedBar()).toBeVisible();

  // ...and the agent sees the annotation together with the approval, rather
  // than a stop with the feedback stranded behind it.
  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
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

  await expect(on(page).annotationNote()).toBeVisible();
  await on(page).annotationNote().fill("Is zero downtime really required?");
  await on(page).addToQueue().click();
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);

  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
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
  await expect(on(page).annotationNote()).toBeFocused();
  await on(page).annotationNote().fill("Frist draft, typo");
  await on(page).addToQueue().click();

  // Cancel restores the original note, leaving the queue untouched.
  await on(page).editQueued().click();
  // Edit puts the caret in the box: opening an editor you then have to click is
  // not an editor.
  await expect(on(page).editNote()).toBeFocused();
  await on(page).editNote().fill("Discarded rewrite");
  await on(page).cancelEdit().click();
  await expect(on(page).sendQueue()).toBeVisible();
  await expect(page.locator("[data-annotation-id]")).toContainText("Frist draft, typo");

  // An empty note is refused - Save stays disabled.
  await on(page).editQueued().click();
  await on(page).editNote().fill("   ");
  await expect(on(page).saveEdit()).toBeDisabled();

  // Save rewrites the note in place, and that is what reaches the agent.
  await on(page).editNote().fill("Backfill in one batch, not nightly.");
  await on(page).saveEdit().click();
  await expect(on(page).editNote()).toHaveCount(0);
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);

  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
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
  await on(page).annotationNote().fill("Queued first");
  await on(page).addToQueue().click();
  // Queueing hands focus to the message composer - the flow the panel is
  // built around: point, note, Enter, keep talking.
  await expect(on(page).messageInput()).toBeFocused();
  await on(page).messageInput().fill("typed second");
  await on(page).sendMessage().click();
  await expect(page.locator('[data-role="human"]')).toContainText("typed second");

  // Built out here and passed IN: the callback runs in the browser, where
  // `hook` does not exist. Interpolating it inside the callback typechecks
  // perfectly and fails at runtime with `hook is not defined`.
  const cards = `[data-role], ${hook("annotation")}, ${hook("queued-annotation")}`;
  const order = () =>
    page.evaluate(
      (selector) =>
        Array.from(document.querySelectorAll(selector)).map(
          (el) => (el as HTMLElement).dataset.role ?? (el as HTMLElement).dataset.test,
        ),
      cards,
    );
  expect(await order()).toEqual(["queued-annotation", "human"]);

  // Sending must not reorder: the event carries authoredAt, so the located
  // card takes the queued card's place instead of leapfrogging to send time.
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);
  expect(await order()).toEqual(["annotation", "human"]);

  // And the agent sees the authorship time alongside the log time.
  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
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
    await on(page).annotationNote().fill(note);
    await on(page).addToQueue().click();
    await on(page).sendQueue().click();
  };

  await annotate('li[data-lucid-id="step-backfill"]', "first note");
  await expect(on(page).annotation()).toHaveCount(1);
  await cli.run([
    "wait",
    cli.artifact,
    "--reply",
    "agent replied here",
    "--timeout",
    waitTimeoutSeconds(1),
  ]);
  await expect(page.locator('[data-role="agent"]')).toHaveCount(1);
  await annotate("#note", "second note");
  await expect(on(page).annotation()).toHaveCount(2);

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
    await on(page).annotationNote().fill(note);
    await on(page).addToQueue().click();
  }
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(2);

  // Sent marks are quiet by default; the header default brings them all back.
  await on(page).toggleFocusAll().click();
  await expect(surface.locator(".badge")).toHaveCount(2);

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
  await on(page).annotationNote().fill("Looks like this instead");
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
  await expect(on(page).annotationChip()).toHaveCount(1);

  // The image travels with the queued item, through to the sent card.
  await on(page).addToQueue().click();
  await expect(on(page).annotationChip()).toHaveCount(1);
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);
  await expect(on(page).annotationThumb()).toHaveCount(1);

  // It decoded, rather than merely resolving.
  const width = await page.evaluate(
    () =>
      (document.querySelector('[data-test="annotation-thumb"] img') as HTMLImageElement)
        .naturalWidth,
  );
  expect(width).toBeGreaterThan(0);

  // The agent gets the anchor and the bytes together: an absolute path to read
  // and the note saying what is wrong.
  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
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
  await on(page).messageInput().click();
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
  await expect(on(page).imageChip()).toHaveCount(1);

  await on(page).messageInput().fill("look at this");
  await on(page).sendMessage().click();
  await expect(on(page).thumb()).toHaveCount(1);

  // Reload: messages now come from the wait payload rather than the live SSE
  // frame. The payload rewrites images for the agent, and used to drop the
  // filename the viewer needs - so the thumb 404'd only after a reload.
  await page.reload();
  await expect(on(page).thumb()).toHaveCount(1);
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
  const ta = on(page).messageInput();
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
  await on(page).sendMessage().click();

  // The human's turn renders folded: the head shows, the rest waits behind
  // the toggle, and expanding brings in the last line.
  const bubble = page.locator('[data-role="human"]');
  await expect(on(page).foldToggle()).toContainText("show 34 more lines");
  await expect(bubble).not.toContainText("log line 39");
  await on(page).foldToggle().click();
  await expect(bubble).toContainText("log line 39 - why did this fail?");

  // The agent reads what was actually pasted, not the placeholder.
  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
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
  await on(page).sendMessage().click();
  const fb2 = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    fb.nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
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
    await cli.run([
      "wait",
      cli.artifact,
      "--reply",
      `filler ${i}: ${filler}`,
      "--timeout",
      waitTimeoutSeconds(1),
    ]);
  }
  await expect(page.locator('[data-role="agent"]')).toHaveCount(12);
  const vp = on(page).threadViewport();
  expect(await vp.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);

  // Pinned to the bottom, the button is disabled and hidden.
  await expect(on(page).scrollBottom()).toBeDisabled();

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
    waitTimeoutSeconds(1),
  ]);
  await expect(page.locator('[data-role="agent"]')).toHaveCount(13);
  await page.waitForTimeout(400); // any yank would have happened by now
  expect(await vp.evaluate((el) => el.scrollTop)).toBeLessThan(50);

  // The affordance is live while scrolled up, and returns the reader.
  const btn = on(page).scrollBottom();
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
  await expect(on(page).agentWorking()).toHaveCount(0);

  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await on(page).annotationNote().fill("Backfill in one batch");
  await on(page).addToQueue().click();
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);

  // The agent takes delivery: wait returns feedback and acks it. The viewer
  // flips to "agent is working".
  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
    status: string;
    nextCursor: string;
  };
  expect(fb.status).toBe("feedback");
  await expect(on(page).agentWorking()).toBeVisible();
  await expect(on(page).agentWorking()).toContainText("Agent responding");

  // The agent's reply closes the window.
  await cli.run(["wait", cli.artifact, "--reply", "Batched.", "--timeout", waitTimeoutSeconds(1)]);
  await expect(on(page).agentWorking()).toHaveCount(0);
  await expect(page.locator('[data-role="agent"]')).toContainText("Batched.");
});

test("the composer says whether an agent is listening", async ({ page }) => {
  await openViewer(page);
  const line = on(page).listenerLine();

  // Nobody is waiting on a fresh session.
  await expect(line).toHaveAttribute("data-listening", "false");
  // The standalone viewer has no hub, so nothing spawns. The mode is named as
  // a term (the detail is on hover) rather than restating a sentence above the
  // composer on every turn.
  await expect(line).toContainText("recording only");

  // An agent blocks in wait: its waker connects and the line flips - live via
  // the synthetic listeners frame, no reload.
  const waiting = cli.run([
    "wait",
    cli.artifact,
    "--since",
    "evt_00001",
    "--timeout",
    waitTimeoutSeconds(6),
  ]);
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
  await expect(on(page).agentWorking()).toContainText("Agent responding");
  await expect(on(page).surfaceUpdating()).toHaveCount(0);

  await page.evaluate(() =>
    fetch("/__lucid/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "i-intent", intent: "revise" }),
    }),
  );
  await expect(on(page).surfaceUpdating()).toBeVisible();
  await expect(on(page).agentWorking()).toContainText("Updating the artifact");

  // Real output closes the window and the spinner with it.
  await cli.run(["wait", cli.artifact, "--reply", "done", "--timeout", waitTimeoutSeconds(1)]);
  await expect(on(page).surfaceUpdating()).toHaveCount(0);
  await expect(on(page).agentWorking()).toHaveCount(0);
});

test("a typed message says it landed immediately, and never claims an artifact update (findings #18, #19)", async ({
  page,
}) => {
  await openViewer(page);

  // Type into the composer and send. The gap this covers is real: a headless
  // turn takes 3-4s to ack (attend's quiet window plus a poll), and the
  // composer used to show NOTHING for all of it - `awaitingAck` was set on the
  // annotation path and not the message path.
  await on(page).messageInput().fill("hey");
  await on(page).sendMessage().click();

  // Immediately - not after the ack. One-shot, because an auto-retrying
  // assertion would wait out the very window this is about.
  await expect(on(page).awaitingAck()).toBeVisible({ timeout: 3000 });
  await expect(on(page).awaitingAck()).toContainText("Delivered");

  // NOT asserted here: that no spawner claims an update. This viewer has no
  // hub and no agent, so nothing ever writes an ack - a `surfaceUpdating`
  // count of 0 would be 0 whatever the spawners do, and would pass with the
  // speculative intent restored. That behaviour is pinned where it is real:
  // `test/attend.test.ts` (a live daemon spawning a stub, asserting the ack
  // carries no intent) and `test/launch.test.ts` (the prompt tells the turn
  // to declare it).
});

test("a dropped live connection shows a self-clearing indicator, not a warning pile", async ({
  page,
}) => {
  await openViewer(page);
  await expect(on(page).reconnecting()).toHaveCount(0);

  // Stop the server out from under the viewer.
  await cli.run(["end", cli.artifact]);
  await expect(on(page).reconnecting()).toBeVisible();

  // EventSource retries by itself, so this must never tell the human to reload,
  // and must never pile up one warning per failed attempt.
  await page.waitForTimeout(1500);
  await expect(on(page).reconnecting()).toHaveCount(1);
  await expect(page.locator("body")).not.toContainText("reload to resume");

  // ...and it clears itself once the stream is back.
  await cli.run(["open", cli.artifact]);
  await expect(on(page).reconnecting()).toHaveCount(0, { timeout: 15_000 });
});

test("a message sent at a dead server is kept, not eaten, and delivers itself on reconnect", async ({
  page,
}) => {
  await openViewer(page);
  const composer = on(page).messageInput();
  const first = "Confirm the routing: Patch re-enters at Test, not Build.";
  const second = "Also: Land is the right name for the phase, not Merge.";

  // The server goes out from under the viewer - the failure this whole path
  // exists for. The composer keeps working; only the POST cannot land.
  await cli.run(["end", cli.artifact]);
  await expect(on(page).reconnecting()).toBeVisible();

  await composer.fill(first);
  await on(page).sendMessage().click();

  // assistant-ui empties the composer on Enter, so this card is the only place
  // the typing still exists. It must exist.
  await expect(on(page).unsentMessage()).toContainText(first);
  await expect(composer).toHaveValue("");
  // ...and be recoverable by hand, not just by retry.
  await expect(on(page).copyUnsent()).toBeVisible();

  // A second message during the same outage gets its own card. Nothing may hide
  // behind the first: an invisible entry still blocks approval, with no way to
  // retry or discard it.
  await composer.fill(second);
  await on(page).sendMessage().click();
  await expect(on(page).unsentMessage()).toHaveCount(2);

  // Approving would strand them behind a stop the agent has already acted on.
  await expect(on(page).approve()).toBeDisabled();
  await on(page).approveWrap().hover();
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
  await expect(on(page).unsentMessage()).toHaveCount(0, { timeout: 20_000 });
  const humanTurns = page.locator('[data-role="human"]');
  await expect(humanTurns).toHaveCount(2);
  await expect(humanTurns.first()).toContainText("Patch re-enters at Test");
  await expect(humanTurns.last()).toContainText("Land is the right name");
  await expect(on(page).approve()).toBeEnabled();

  // And the agent actually receives them - the cards were never a consolation prize.
  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    reopened.nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
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
  const composer = on(page).messageInput();

  // This session goes away, freeing its port back to the shared pool.
  await cli.run(["end", cli.artifact]);
  await expect(on(page).reconnecting()).toBeVisible();

  await composer.fill("Renumber the phases in the overview.");
  await on(page).sendMessage().click();
  await expect(on(page).unsentMessage()).toHaveCount(1);

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

    await expect(on(page).unsentMessage()).toHaveCount(1);
    await expect(page.locator("body")).toContainText("A different session is running");

    // The other session's agent must see nothing at all.
    const fb = (await other.run([
      "wait",
      other.artifact,
      "--since",
      otherSession.nextCursor,
      "--timeout",
      waitTimeoutSeconds(2),
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
  await expect(on(page).messageInput()).toBeVisible();
  const openWidth = Number.parseFloat(await gap.evaluate((el) => getComputedStyle(el).width));
  expect(openWidth).toBeGreaterThan(300);

  // Switch to Sessions: the current session lists itself as "you are here", and
  // the composer survives underneath (keepMounted), it is only hidden.
  await on(page).tabSessions().click();
  await expect(on(page).sessionsList()).toBeVisible();
  await expect(on(page).sessionRow()).toHaveCount(1);
  await expect(on(page).sessionsList()).toContainText("you are here");
  await expect(on(page).messageInput()).toBeHidden();

  // Back to review; the composer is shown again, never remounted.
  await on(page).tabChat().click();
  await expect(on(page).messageInput()).toBeVisible();

  // Closing the panel collapses the gap to zero - the artifact reflows into the
  // space rather than being covered by an overlay.
  await on(page).panelToggle().click();
  await expect
    .poll(async () => Number.parseFloat(await gap.evaluate((el) => getComputedStyle(el).width)))
    .toBe(0);
  // The divider goes with it: there is no panel edge to drag while collapsed.
  await expect(page.locator('[aria-label="Resize the review panel"]')).toHaveCount(0);

  // Reopen restores the panel to its width.
  await on(page).panelToggle().click();
  await expect
    .poll(async () => Number.parseFloat(await gap.evaluate((el) => getComputedStyle(el).width)))
    .toBe(openWidth);
});

test("the target toggle quiets the surface for reading and restores it", async ({ page }) => {
  await openViewer(page);
  const surface = surfaceOf(page);
  const marker = surface.locator(".marker");
  const toggle = on(page).toggleTargets();

  // Targets are on by default, but a SENT annotation's mark is quiet until
  // asked for - the card's link pins it on, giving read mode a mark to hide.
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await on(page).annotationNote().fill("A note");
  await on(page).addToQueue().click();
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);
  await on(page).toggleFocus().click();
  await expect(marker).toHaveCount(1);

  // Read mode: marks gone, and clicking the artifact no longer picks a target -
  // the overlay must stop swallowing clicks, not just stop painting.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(marker).toHaveCount(0);
  await surface.locator("#note").click();
  await expect(on(page).annotationNote()).toHaveCount(0);

  // The annotation itself is untouched - this is a view preference, not a delete.
  await expect(on(page).annotation()).toHaveCount(1);

  // Toggling back repaints from anchors the overlay kept the whole time.
  await toggle.click();
  await expect(marker).toHaveCount(1);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
});

test("focus is exclusive: one card at a time, or every card from the header", async ({ page }) => {
  await openViewer(page);
  const surface = surfaceOf(page);
  const marker = surface.locator(".marker.committed");
  const badge = surface.locator(".badge");

  for (const [sel, note] of [
    ['li[data-lucid-id="step-backfill"]', "First note"],
    ["#note", "Second note"],
  ] as const) {
    await surface.locator(sel).click();
    await on(page).annotationNote().fill(note);
    await on(page).addToQueue().click();
  }
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(2);

  // Delivered feedback stops shouting: no marks paint on send.
  await expect(marker).toHaveCount(0);

  // Hovering a card lights its mark for exactly as long as the question
  // "where is this?" is being asked, then puts the paper back.
  await on(page).annotation().nth(1).hover();
  await expect(marker).toHaveCount(1);
  await on(page).messageInput().hover();
  await expect(marker).toHaveCount(0);

  // Focusing the second card pins only its own mark - which keeps its own
  // number: leaving #1 unfocused must not renumber #2's badge off its card.
  const first = on(page).toggleFocus().nth(0);
  const second = on(page).toggleFocus().nth(1);
  await expect(second).toHaveText("Focus");
  await second.click();
  // Off the card entirely - pointer AND keyboard focus, since a card that holds
  // either lights its mark on its own. What is left is what focus pinned.
  await on(page).messageInput().click();
  await expect(badge).toHaveText(["2"]);
  await expect(second).toHaveText("Unfocus");

  // Focus moves rather than accumulating: taking it releases the card that
  // held it, so the artifact is only ever pointing at one thing.
  await first.click();
  await on(page).messageInput().click();
  await expect(badge).toHaveText(["1"]);
  await expect(second).toHaveText("Focus");

  // And the focused card gives it back, leaving nothing focused.
  await first.click();
  await on(page).messageInput().click();
  await expect(marker).toHaveCount(0);
  await expect(first).toHaveText("Focus");

  // The header focuses every mark at once. No single card holds that focus,
  // so each still offers to narrow the artifact down to itself.
  await on(page).toggleFocusAll().click();
  await expect(badge).toHaveText(["1", "2"]);
  await expect(first).toHaveText("Focus");

  // Taking one card's focus out of all-at-once leaves that card alone lit,
  // and the header toggle says so.
  await second.click();
  await on(page).messageInput().click();
  await expect(badge).toHaveText(["2"]);
  await expect(on(page).toggleFocusAll()).toHaveAttribute("aria-pressed", "false");

  // All-at-once is the session's remembered preference; a single focus is not.
  await on(page).toggleFocusAll().click();
  await expect(marker).toHaveCount(2);
  await page.reload();
  await expect(surfaceOf(page).locator("h1")).toContainText("Database migration plan");
  await expect(on(page).toggleFocusAll()).toHaveAttribute("aria-pressed", "true");
  await expect(surfaceOf(page).locator(".marker.committed")).toHaveCount(2);
});

test("the focus toggles cannot paint today's annotations onto a historical snapshot", async ({
  page,
}) => {
  await openViewer(page);
  const surface = surfaceOf(page);

  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await on(page).annotationNote().fill("A note");
  await on(page).addToQueue().click();
  await on(page).sendQueue().click();
  await expect(on(page).annotation()).toHaveCount(1);

  await cli.write(PLAN_V2);
  await expect(surface.locator("h1")).toContainText("revised");
  await expect(on(page).version()).toContainText("v2");

  // Open v1 read-only. The snapshot is not the DOM the record was written
  // against, so it must stay bare.
  await on(page).version().click();
  await page.getByRole("option", { name: "v1", exact: true }).click();
  await expect(on(page).versionView()).toBeVisible();

  // Both toggles stay clickable in history view, and each one pushes
  // highlights - neither push may land marks on the snapshot.
  await on(page).toggleFocusAll().click();
  await on(page).toggleFocus().click(); // narrows all-at-once down to this card
  await overlaySettled(page);
  await expect(surface.locator(".marker.committed")).toHaveCount(0);

  // Back on the live artifact, the state built while the snapshot was up
  // paints: all-at-once released, this one card focused.
  await on(page).versionViewExit().click();
  await expect(surface.locator("h1")).toContainText("revised");
  await expect(on(page).toggleFocusAll()).toHaveAttribute("aria-pressed", "false");
  await on(page).messageInput().hover();
  await expect(surface.locator(".marker.committed")).toHaveCount(1);
});

test("change-view hunk navigation does not steal keys from a text field", async ({ page }) => {
  await openViewer(page);
  const surface = surfaceOf(page);

  // Commit v2 so change view is reachable, then queue an annotation and edit it.
  await cli.write(PLAN_V2);
  await expect(on(page).version()).toContainText("v2");
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await on(page).annotationNote().fill("ABCDEF");
  await on(page).addToQueue().click();
  await on(page).enterDiff().click();
  await expect(on(page).enterDiff()).toHaveCount(0);
  await on(page).editQueued().click();

  // Arrows move the caret rather than jumping hunks...
  const box = on(page).editNote();
  await box.click();
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(4, 4));
  await page.keyboard.press("ArrowLeft");
  expect(await box.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(3);

  // ...and Escape cancels the edit without also exiting change view.
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(on(page).enterDiff()).toHaveCount(0);
});

test("defer-until-committed shows the newer-version indicator and never loses a draft", async ({
  page,
}) => {
  await openViewer(page);
  const surface = surfaceOf(page);

  // Compose (but do not send) an annotation - a committed-but-unsent draft.
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await on(page).annotationNote().fill("Draft in flight");
  await on(page).addToQueue().click();
  await expect(on(page).sendQueue()).toBeVisible();

  // A new version arrives while the draft is queued -> swap deferred, indicator shown.
  await cli.write(PLAN_V2);
  await expect(on(page).newerVersion()).toBeVisible();
  // Surface still shows the old version (swap deferred).
  await expect(surface.locator("h1")).not.toContainText("revised");

  // Sending the draft releases the deferred swap.
  await on(page).sendQueue().click();
  await expect(on(page).newerVersion()).toHaveCount(0);
  await expect(surface.locator("h1")).toContainText("revised");
});

test("the newer-version banner names the real blocker and only offers a live discard", async ({
  page,
}) => {
  await openViewer(page);
  const surface = surfaceOf(page);
  const banner = on(page).newerVersion();

  // A queue is not discardable, so the banner must ask for a send and show no
  // Discard button - it could only ever clear the composer, not the queue.
  await surface.locator('li[data-lucid-id="step-backfill"]').click();
  await on(page).annotationNote().fill("Queued work");
  await on(page).addToQueue().click();
  await cli.write(PLAN_V2);
  await expect(banner).toContainText("send your 1 queued annotation to see it");
  await expect(on(page).discardDraft()).toHaveCount(0);

  // A composer draft on top of the queue is discardable, so the button returns.
  await surface.locator("#note").click();
  await on(page).annotationNote().fill("Composer draft");
  await expect(banner).toContainText("or discard your draft");
  await expect(on(page).discardDraft()).toBeVisible();

  // Discarding it clears only the composer - the queue survives, swap still deferred.
  await on(page).discardDraft().click();
  await expect(on(page).sendQueue()).toBeVisible();
  await expect(page.locator("[data-annotation-id]")).toContainText("Queued work");
  await expect(banner).toContainText("send your 1 queued annotation to see it");
  await expect(surface.locator("h1")).not.toContainText("revised");
});

test("agent question surfaces in the viewer and the answer reaches the agent", async ({ page }) => {
  const { nextCursor } = await openViewer(page);

  // Agent poses a question.
  await cli.run(["ask", cli.artifact, "--text", "Should backfill run before the cutover?"]);

  // It surfaces in the drawer over the artifact.
  await expect(on(page).question()).toContainText("Should backfill run before");

  // Human answers it.
  await on(page).freeText().fill("Yes - backfill must finish first.");
  await on(page).answer().click();
  // Answered -> the drawer goes away and the question enters the RECORD, as one
  // question+answer item at the answer moment (D14).
  await expect(on(page).questionDrawer()).toHaveCount(0);
  await expect(on(page).qa()).toContainText("Should backfill run before");
  await expect(on(page).qaAnswer()).toContainText("backfill must finish first");

  // The answer reaches the agent as feedback.
  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
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
  await expect(on(page).version()).toContainText("v2");

  // Enter the change view.
  await on(page).enterDiff().click();
  await expect(on(page).diffBar()).toBeVisible();
  await expect(on(page).diffCount()).toContainText("/");

  // The surface shows in-place diff markup (sage adds/changes, ghost removes).
  // A changed block stacks its old version over the new one, in place.
  expect(await surface.locator("[data-diff]").count()).toBeGreaterThan(0);
  expect(await surface.locator(".lucid-diff-now").count()).toBeGreaterThan(0);

  // An undo needs no essay: the box is empty, the button still works, and the
  // agent receives an instruction that reads on its own.
  await expect(on(page).revert()).toBeEnabled();
  // And the button says what a revert IS - a request to the agent, not an undo
  // the viewer performs.
  await on(page).revert().hover();
  await expect(page.locator('[data-slot="tooltip-content"]')).toContainText("Forward-only");
  // With a reason, that reason is what reaches the agent.
  await on(page).revertWhy().fill("keep the nightly backfill");
  await on(page).revert().click();

  const fb = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
    status: string;
    nextCursor: string;
    reverts?: { targetVersion: number; why: string }[];
  };
  expect(fb.reverts?.[0]?.targetVersion).toBe(1);
  expect(fb.reverts?.[0]?.why).toContain("nightly backfill");

  const cursor2 = fb.nextCursor;
  await on(page).revert().click();
  const blank = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    cursor2,
    "--timeout",
    waitTimeoutSeconds(8),
  ])) as {
    reverts?: { targetVersion: number; why: string }[];
  };
  expect(blank.reverts?.[0]?.why).toContain("restore to v1");

  // Exit the change view.
  await on(page).diffDone().click();
  await expect(on(page).diffBar()).toHaveCount(0);
});

/**
 * PLAN_V1's content with its colours routed through the standard tokens, plus
 * the dark remap an author writes.
 *
 * The toggle test needs this because PLAN_V1 itself has NO dark form - no
 * tokens, no `prefers-color-scheme`, just `color:#1a202c` hardcoded on body. An
 * artifact like that is deliberately left in the one appearance it has, so
 * asserting that the toggle re-themes it was asserting the defect 569d43c set
 * out to fix. It only passed because `canRenderDark()` used to find the tokens
 * Lucid itself injected and call every artifact dark-capable.
 *
 * The subject here is the toggle's REACH into the artifact and the persistence
 * of the choice, which needs a document that can legitimately be re-themed. The
 * artifact that cannot is covered in contrast.e2e.ts, which asserts the opposite
 * and is the reason the two disagreed.
 */
const THEMED_PLAN = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Migration plan</title>
<style>
  :root { --paper: #faf6ec; --ink: #211d15; }
  @media (prefers-color-scheme: dark) { :root { --paper: #211d15; --ink: #ece3cf; } }
  body { background: var(--paper); color: var(--ink); font-family: system-ui;
         max-width: 760px; margin: 40px auto }
  li { margin: 6px 0 }
</style>
</head>
<body>
  <article>
    <h1>Database migration plan</h1>
    <ol id="steps">
      <li data-lucid-id="step-backfill">Backfill from the events table nightly</li>
      <li>Cut over reads to the new store</li>
      <li>Decommission the legacy table</li>
    </ol>
    <p id="note">This plan assumes zero downtime is required for the cutover.</p>
  </article>
</body>
</html>`;

test("the paper toggle re-themes the artifact itself, and the choice survives a reload", async ({
  page,
}) => {
  await openViewer(page, THEMED_PLAN);
  const surface = surfaceOf(page);
  const root = surface.locator("html");

  // Light is the default: paper is the ground every artifact is designed on.
  await expect(on(page).themeToggle()).toHaveAttribute("data-theme", "light");
  await expect(root).toHaveAttribute("data-lucid-theme", "light");

  // The toggle reaches INSIDE the artifact document - the tokens it remaps are
  // what an artifact's own colors resolve through.
  await on(page).themeToggle().click();
  await expect(root).toHaveAttribute("data-lucid-theme", "dark");
  const dark = await surface
    .locator("html")
    .evaluate((el) => getComputedStyle(el).getPropertyValue("--paper").trim());
  expect(dark).toBe("#211d15");

  // A theme belongs to the eyes reading, so it outlives the page.
  await page.reload();
  await expect(on(page).themeToggle()).toHaveAttribute("data-theme", "dark");
  await expect(surfaceOf(page).locator("html")).toHaveAttribute("data-lucid-theme", "dark");

  // And back, without leaving the artifact on the wrong palette.
  await on(page).themeToggle().click();
  await expect(surfaceOf(page).locator("html")).toHaveAttribute("data-lucid-theme", "light");
  const light = await surfaceOf(page)
    .locator("html")
    .evaluate((el) => getComputedStyle(el).getPropertyValue("--paper").trim());
  expect(light).toBe("#faf6ec");
});

test("a turn that ends with nothing to show says so, instead of going quiet", async ({ page }) => {
  await openViewer(page);

  // A turn takes the batch. This is the state the viewer has always had.
  await page.evaluate(() =>
    fetch("/__lucid/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "te-ack", turnId: "T1" }),
    }),
  );
  await expect(on(page).agentWorking()).toContainText("Agent responding");

  // ...and ends having produced nothing. Closing the window is right - the
  // agent is not working. Closing it SILENTLY was not: the human was left
  // with feedback marked delivered and no idea what came of it, which reads
  // as if the turn never happened (plan 08 M7, OQ-3).
  await page.evaluate(() =>
    fetch("/__lucid/turn-ended", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId: "T1", reason: "done" }),
    }),
  );
  await expect(on(page).agentWorking()).toHaveCount(0);
  await expect(on(page).turnEnded()).toContainText("finished without changing anything");

  // A different reason is a different fact about what happened.
  await page.evaluate(() =>
    fetch("/__lucid/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "te-ack2", turnId: "T2" }),
    }),
  );
  await page.evaluate(() =>
    fetch("/__lucid/turn-ended", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId: "T2", reason: "usage_limit", code: "weekly_limit" }),
    }),
  );
  await expect(on(page).turnEnded()).toContainText("weekly usage limit");
  await expect(on(page).warning()).toHaveCount(0);

  // Real output answers the feedback, so the line gives way to it rather than
  // sitting beside it.
  await cli.run(["wait", cli.artifact, "--reply", "done", "--timeout", waitTimeoutSeconds(1)]);
  await expect(on(page).turnEnded()).toHaveCount(0);
});

test("a section permalink in a reply lands the reader on that section", async ({ page }) => {
  await openViewer(page);
  const surface = surfaceOf(page);

  // The reply points at a section by the id the artifact already carries -
  // what the skill tells an agent to do after adding one.
  await cli.run([
    "wait",
    cli.artifact,
    "--reply",
    "Rewrote it - see [the backfill step](lucid:section/step-backfill).",
    "--timeout",
    waitTimeoutSeconds(1),
  ]);
  const chip = on(page).sectionLink();
  await expect(chip).toHaveText("the backfill step");

  // The artifact starts at the top; the click is what puts the section on
  // screen, and the owned overlay pulse says where the eye landed.
  const target = surface.locator('[data-lucid-id="step-backfill"]');
  const emphasis = surface.locator(".section-emphasis");
  await expect(emphasis).toHaveCount(0);
  await chip.click();
  await expect(emphasis).toHaveCount(1);
  await expect(target).toBeInViewport();
  await expect(target).not.toBeFocused();
  const previousTarget = await target.elementHandle();
  expect(previousTarget).not.toBeNull();

  // A permalink to something this version does not have is not a chip at all:
  // a dead link that still looks clickable is worse than plain prose.
  await cli.write(PLAN_V2.replace('data-lucid-id="step-backfill"', 'data-lucid-id="renamed"'));
  await expect(surface.locator("h1")).toContainText("revised");
  expect(await previousTarget?.evaluate((element) => !element.isConnected)).toBe(true);
  await expect(on(page).sectionLink()).toHaveCount(0);
  await expect(page.locator('[data-role="agent"]')).toContainText("the backfill step");
});

test("a reduced-motion section reveal rests without focusing the artifact heading", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openViewer(page);
  const surface = surfaceOf(page);
  await surface.locator("html").evaluate((root) => {
    root.style.scrollBehavior = "smooth";
  });
  await cli.run([
    "wait",
    cli.artifact,
    "--reply",
    "See [the backfill step](lucid:section/step-backfill).",
    "--timeout",
    waitTimeoutSeconds(1),
  ]);

  const target = surface.locator('[data-lucid-id="step-backfill"]');
  await on(page).sectionLink().click();
  expect(
    await target.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    }),
  ).toBe(true);
  const emphasis = surface.locator(".section-emphasis");
  await expect(emphasis).toHaveCount(1);
  await expect(emphasis).toHaveCSS("animation-name", "none");
  await expect(emphasis).toHaveCSS("outline-style", "solid");
  await expect(target).toBeInViewport();
  await expect(target).not.toBeFocused();
});

test("the active outline runtime publishes complete geometry only over its pre-artifact port", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2_400, height: 900 });
  await installOutlinePublicationProbe(page);
  const artifact = `<!doctype html><html><head><meta charset="utf-8"><title>Outline runtime</title>
    <style>body{max-width:700px;margin:40px auto;font-family:system-ui}main{position:static}.__lucid_section_target{position:fixed!important;right:20px;top:120px;width:180px;height:120px;box-shadow:0 0 80px red!important}</style></head><body>
    <main><h1>Database migration plan outline runtime</h1><h2>Context</h2><p>One</p><h2>Milestones</h2><p>Two</p><h2>Risks</h2><p>Three</p></main>
    <script>
      window.MessageChannel = class { constructor() { throw new Error("artifact channel"); } };
      window.MutationObserver = class { constructor() { throw new Error("artifact mutation observer"); } };
      window.ResizeObserver = class { constructor() { throw new Error("artifact resize observer"); } };
      window.parent.postMessage({type:"outline-snapshot",proof:{complete:true},headings:[{label:"forged"}]}, "*");
    </script></body></html>`;
  await openViewer(page, artifact);
  const surface = surfaceOf(page);

  await waitForOutlineProbeConnection(page);
  await expect.poll(async () => (await outlineProbeMessages(page)).length).toBeGreaterThan(0);
  expect((await outlineProbe(page)).windowOutlineMessages).toBe(1);
  expect(await outlineDebugInfo(page)).toMatchObject({ dormant: false, connected: true });

  await requestOutlineProbeLayout(page);
  await expect
    .poll(() =>
      surface.locator("#__lucid_overlay_root").evaluate((root) => {
        const overlay = root.firstElementChild as Element & {
          outlineDebugInfo?: () => Record<string, unknown>;
        };
        return overlay.outlineDebugInfo?.().dormant ?? null;
      }),
    )
    .toBe(false);
  await expect
    .poll(() =>
      surface.locator("#__lucid_overlay_root").evaluate((root) => {
        const overlay = root.firstElementChild as Element & {
          outlineDebugInfo?: () => Record<string, unknown>;
        };
        return overlay.outlineDebugInfo?.().taskCount ?? null;
      }),
    )
    .toBeGreaterThanOrEqual(1);
  expect((await outlineProbe(page)).errors).toEqual([]);
  expect(
    await surface
      .locator("html")
      .evaluate(
        () => (window as unknown as { __outlineTest: { errors: string[] } }).__outlineTest.errors,
      ),
  ).toEqual([]);
  await expect
    .poll(async () => {
      const debug = await outlineDebugInfo(page);
      return debug === null
        ? null
        : { headingCount: debug.headingCount, pendingQuietTask: debug.pendingQuietTask };
    })
    .toEqual({ headingCount: 3, pendingQuietTask: false });
  const afterTaskDebug = await outlineDebugInfo(page);
  expect(afterTaskDebug).toMatchObject({
    taskCount: expect.any(Number),
    pendingQuietTask: false,
    headingCount: 3,
  });
  expect(JSON.stringify(afterTaskDebug)).not.toContain("Context");
  await expect.poll(async () => (await outlineProbeMessages(page)).length).toBeGreaterThan(0);
  const latestSnapshot = (): Promise<Record<string, unknown> | null> =>
    latestOutlineProbeSnapshot(page);
  const snapshot = await latestSnapshot();
  expect(snapshot).not.toBeNull();
  if (!snapshot) throw new Error("outline snapshot missing");
  expect(snapshot).toMatchObject({
    type: "outline-snapshot",
    availability: "complete",
    headings: [{ label: "Context" }, { label: "Milestones" }, { label: "Risks" }],
    proof: { complete: true, reason: "complete-unused-rectangle" },
  });
  const taskCount = async (): Promise<number> => (await outlineDebugInfo(page))?.taskCount ?? 0;
  const snapshotCount = (): Promise<number> => outlineProbeSnapshotCount(page);
  const initialTaskCount = await taskCount();
  const initialSnapshotCount = await snapshotCount();

  await surface.locator("body").evaluate((body) => {
    for (let index = 0; index < 200; index += 1) {
      body.setAttribute("data-outline-burst", String(index));
    }
  });
  await expect.poll(taskCount).toBeGreaterThan(initialTaskCount);
  await expect.poll(snapshotCount).toBeGreaterThan(initialSnapshotCount);
  const burstSnapshotCount = await snapshotCount();

  await surface.locator("body").evaluate((body) => {
    const timer = window.setInterval(() => {
      body.toggleAttribute("data-outline-continuous");
    }, 10);
    Object.defineProperty(window, "__outlineMutationTimer", { configurable: true, value: timer });
  });
  await expect
    .poll(() =>
      surface.locator("#__lucid_overlay_root").evaluate((root) => {
        const overlay = root.firstElementChild as Element & {
          outlineDebugInfo?: () => Record<string, unknown>;
        };
        return overlay.outlineDebugInfo?.().headingCount ?? null;
      }),
    )
    .toBe(0);
  const continuousTaskCount = await taskCount();
  await page.waitForTimeout(150);
  expect(await taskCount()).toBe(continuousTaskCount);
  await surface.locator("body").evaluate(() => {
    const ownedWindow = window as unknown as { __outlineMutationTimer: number };
    window.clearInterval(ownedWindow.__outlineMutationTimer);
  });
  await expect.poll(taskCount).toBeGreaterThan(continuousTaskCount);
  await expect.poll(snapshotCount).toBeGreaterThan(burstSnapshotCount);

  await surface.locator("body").evaluate((body) => {
    const hazard = document.createElement("aside");
    hazard.id = "captured-observer-hazard";
    hazard.setAttribute(
      "style",
      "position:fixed;right:20px;top:120px;width:180px;height:120px;background:red",
    );
    body.append(hazard);
  });
  await expect
    .poll(
      async () => ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.reason,
    )
    .toBe("box-intersection");
  await surface.locator("#captured-observer-hazard").evaluate((hazard) => hazard.remove());
  await expect
    .poll(
      async () =>
        ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.complete,
    )
    .toBe(true);

  const revisedArtifact = artifact
    .replace("<h2>Context</h2>", "<h2>Updated context</h2>")
    .replace("<h2>Risks</h2>", "<h2>Updated risks</h2>");
  await cli.write(revisedArtifact);
  await expect(surface.locator("h2").first()).toContainText("Updated context");
  await expect
    .poll(async () => {
      const current = await latestSnapshot();
      return (current?.headings as Array<Record<string, unknown>> | undefined)?.[0]?.label;
    })
    .toBe("Updated context");
  const revisedSnapshot = await latestOutlineProbeSnapshot(page);
  if (!revisedSnapshot) throw new Error("revised outline snapshot missing");
  expect(revisedSnapshot).toMatchObject({
    availability: "complete",
    headings: [{ label: "Updated context" }, { label: "Milestones" }, { label: "Updated risks" }],
  });
  expect(revisedSnapshot.generation).toBeGreaterThan(snapshot.generation as number);
  expect(revisedSnapshot.headings).not.toEqual(snapshot.headings);

  await surface
    .locator("h2")
    .first()
    .evaluate((heading) => {
      const text = heading.firstChild;
      if (!text) throw new Error("heading text node missing");
      text.nodeValue = "Updated contact";
    });
  await expect
    .poll(async () => {
      const current = await latestSnapshot();
      return (current?.headings as Array<Record<string, unknown>> | undefined)?.[0]?.label;
    })
    .toBe("Updated contact");
  const textSnapshot = await latestSnapshot();
  expect((textSnapshot?.headings as Array<Record<string, unknown>> | undefined)?.[0]).toMatchObject(
    {
      label: "Updated contact",
    },
  );

  const cssomMutation = await surface.locator("body").evaluate(() => {
    const rule = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .findLast(
        (candidate): candidate is CSSStyleRule =>
          candidate instanceof CSSStyleRule && candidate.selectorText === "main",
      );
    if (!rule) throw new Error("artifact main rule missing");
    rule.style.setProperty("position", "fixed");
    rule.style.setProperty("right", "20px");
    rule.style.setProperty("top", "120px");
    rule.style.setProperty("width", "180px");
    rule.style.setProperty("height", "120px");
    return {
      cssText: rule.cssText,
      selector: rule.selectorText,
      value: rule.style.getPropertyValue("position"),
    };
  });
  expect(cssomMutation).toMatchObject({ selector: "main", value: "fixed" });
  await expect
    .poll(() => surface.locator("main").evaluate((main) => getComputedStyle(main).position))
    .toBe("fixed");
  await expect
    .poll(
      async () => ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.reason,
    )
    .toBe("box-intersection");

  await surface.locator("body").evaluate(() => {
    const rule = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .findLast(
        (candidate): candidate is CSSStyleRule =>
          candidate instanceof CSSStyleRule && candidate.selectorText === "main",
      );
    if (!rule) throw new Error("artifact main rule missing");
    for (const property of ["position", "right", "top", "width", "height"]) {
      rule.style.removeProperty(property);
    }
  });
  await expect
    .poll(
      async () =>
        ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.complete,
    )
    .toBe(true);

  await surface.locator("body").evaluate(() => {
    const rule = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .findLast(
        (candidate): candidate is CSSStyleRule =>
          candidate instanceof CSSStyleRule && candidate.selectorText === "main",
      );
    if (!rule) throw new Error("artifact main rule missing");
    rule.styleMap.set("position", new CSSKeywordValue("fixed"));
    rule.styleMap.set("right", CSS.px(20));
    rule.styleMap.set("top", CSS.px(120));
    rule.styleMap.set("width", CSS.px(180));
    rule.styleMap.set("height", CSS.px(120));
  });
  await expect
    .poll(
      async () => ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.reason,
    )
    .toBe("box-intersection");
  await surface.locator("body").evaluate(() => {
    const rule = Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .findLast(
        (candidate): candidate is CSSStyleRule =>
          candidate instanceof CSSStyleRule && candidate.selectorText === "main",
      );
    if (!rule) throw new Error("artifact main rule missing");
    for (const property of ["position", "right", "top", "width", "height"]) {
      rule.styleMap.delete(property);
    }
  });
  await expect
    .poll(
      async () =>
        ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.complete,
    )
    .toBe(true);

  await surface.locator("body").evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      "main{position:fixed;right:20px;top:120px;width:180px;height:120px;background:red}",
    );
    sheet.disabled = true;
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    Object.defineProperty(window, "__outlineDisabledSheet", {
      configurable: true,
      value: sheet,
    });
  });
  await expect
    .poll(
      async () =>
        ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.complete,
    )
    .toBe(true);
  await surface.locator("body").evaluate(() => {
    (
      window as unknown as { __outlineDisabledSheet: CSSStyleSheet }
    ).__outlineDisabledSheet.disabled = false;
  });
  await expect
    .poll(
      async () => ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.reason,
    )
    .toBe("box-intersection");
  await surface.locator("body").evaluate(() => {
    const ownedWindow = window as unknown as { __outlineDisabledSheet: CSSStyleSheet };
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
      (sheet) => sheet !== ownedWindow.__outlineDisabledSheet,
    );
  });
  await expect
    .poll(
      async () =>
        ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.complete,
    )
    .toBe(true);

  await surface.locator("body").evaluate((body) => {
    const style = document.createElement("style");
    style.id = "disabled-element-sheet";
    style.textContent =
      "main{position:fixed;right:20px;top:120px;width:180px;height:120px;background:red}";
    style.disabled = true;
    body.append(style);
  });
  await expect
    .poll(
      async () =>
        ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.complete,
    )
    .toBe(true);
  await surface.locator("#disabled-element-sheet").evaluate((style: HTMLStyleElement) => {
    style.disabled = false;
  });
  await expect
    .poll(
      async () => ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.reason,
    )
    .toBe("box-intersection");
  await surface.locator("#disabled-element-sheet").evaluate((style) => style.remove());
  await expect
    .poll(
      async () =>
        ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.complete,
    )
    .toBe(true);

  await surface.locator("main").evaluate((main) => {
    const effect = new KeyframeEffect(
      main,
      [{ transform: "translateX(0)" }, { transform: "translateX(900px)" }],
      { duration: 2_000, iterations: Number.POSITIVE_INFINITY },
    );
    const animation = new Animation(effect, document.timeline);
    Object.defineProperty(window, "__outlineDirectAnimation", {
      configurable: true,
      value: animation,
    });
    animation.play();
  });
  await expect
    .poll(
      async () => ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.reason,
    )
    .toBe("dynamic-paint");
  await surface.locator("body").evaluate(() => {
    (
      window as unknown as { __outlineDirectAnimation: Animation }
    ).__outlineDirectAnimation.cancel();
  });
  await expect
    .poll(
      async () =>
        ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.complete,
    )
    .toBe(true);

  await surface.locator("main").evaluate((main) => {
    const animation = main.animate(
      [{ transform: "translateX(0)" }, { transform: "translateX(900px)" }],
      { duration: 2_000, iterations: Number.POSITIVE_INFINITY },
    );
    Object.defineProperty(window, "__outlineAnimation", { configurable: true, value: animation });
  });
  await expect
    .poll(
      async () => ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.reason,
    )
    .toBe("dynamic-paint");
  await surface.locator("body").evaluate(() => {
    (window as unknown as { __outlineAnimation: Animation }).__outlineAnimation.cancel();
  });
  await expect
    .poll(
      async () =>
        ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.complete,
    )
    .toBe(true);

  await surface.locator("body").evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      "main{position:fixed;right:20px;top:120px;width:180px;height:120px;background:red}",
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    Object.defineProperty(window, "__outlineAdoptedSheet", {
      configurable: true,
      value: sheet,
    });
  });
  await expect
    .poll(
      async () => ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.reason,
    )
    .toBe("box-intersection");
  await surface.locator("body").evaluate(() => {
    const ownedWindow = window as unknown as { __outlineAdoptedSheet: CSSStyleSheet };
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
      (sheet) => sheet !== ownedWindow.__outlineAdoptedSheet,
    );
  });
  await expect
    .poll(
      async () =>
        ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.complete,
    )
    .toBe(true);

  await surface.locator("body").evaluate((body) => {
    const hazard = document.createElement("aside");
    hazard.id = "semantic-paint-hazard";
    hazard.setAttribute("inert", "");
    hazard.setAttribute("aria-hidden", "true");
    hazard.setAttribute(
      "style",
      "position:fixed;right:20px;top:120px;width:180px;height:120px;background:red",
    );
    body.append(hazard);
  });
  await expect
    .poll(
      async () => ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.reason,
    )
    .toBe("box-intersection");

  await surface.locator("#semantic-paint-hazard").evaluate((hazard) => hazard.remove());
  await expect
    .poll(
      async () =>
        ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.complete,
    )
    .toBe(true);

  await surface.locator("body").evaluate((body) => {
    const hazard = document.createElement("aside");
    hazard.id = "forged-owned-hazard";
    hazard.setAttribute("data-lucid-owned", "true");
    hazard.setAttribute(
      "style",
      "position:fixed;right:20px;top:120px;width:180px;height:120px;background:red",
    );
    body.append(hazard);
  });
  await expect
    .poll(
      async () => ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.reason,
    )
    .toBe("box-intersection");
  await surface.locator("#forged-owned-hazard").evaluate((hazard) => hazard.remove());
  await expect
    .poll(
      async () =>
        ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.complete,
    )
    .toBe(true);

  const activationSnapshot = await latestSnapshot();
  if (!activationSnapshot) throw new Error("activation outline snapshot missing");
  expect(activationSnapshot).toMatchObject({ proof: { complete: true } });

  const first = (activationSnapshot.headings as { key: string }[])[0];
  if (!first) throw new Error("outline heading missing");
  await postOutlineProbeMessage(page, {
    type: "outline-activate",
    generation: activationSnapshot.generation as number,
    key: first.key,
    motion: "reduced",
  });
  const target = surface.locator("h2").first();
  await expect
    .poll(() =>
      surface.locator("#__lucid_overlay_root").evaluate((root) => {
        const overlay = root.firstElementChild as Element & {
          outlineDebugInfo?: () => Record<string, unknown>;
        };
        return overlay.outlineDebugInfo?.().proofComplete ?? null;
      }),
    )
    .toBe(true);
  const debug = await surface.locator("#__lucid_overlay_root").evaluate((root) => {
    const overlay = root.firstElementChild as Element & {
      outlineDebugInfo?: () => Record<string, unknown>;
    };
    return overlay.outlineDebugInfo?.() ?? null;
  });
  expect(debug).toMatchObject({ dormant: false, headingCount: 3, proofComplete: true });
  expect(JSON.stringify(debug)).not.toContain("Context");
  await expect(target).not.toHaveClass(/__lucid_section_target/);
  await expect(target).not.toBeFocused();

  await surface
    .locator("h2")
    .first()
    .evaluate((heading) => {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 5_000; index += 1) {
        fragment.append(document.createTextNode(""));
      }
      heading.append(fragment);
    });
  await expect.poll(async () => (await latestSnapshot())?.availability).toBe("absent");
  expect(await latestSnapshot()).toMatchObject({
    headings: [],
    health: { code: "AO-004", reason: "work-budget-exhausted" },
    proof: { complete: false, reason: "work-budget-exhausted" },
  });
  await surface
    .locator("h2")
    .first()
    .evaluate((heading) => heading.normalize());
  await expect
    .poll(
      async () => ((await latestSnapshot())?.proof as Record<string, unknown> | undefined)?.reason,
    )
    .toBe("untrusted-style-realm");
  await expect(surface.locator(".section-emphasis")).toHaveCount(1);

  await surface.locator("body").evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
  });
  await expect
    .poll(() =>
      surface.locator("#__lucid_overlay_root").evaluate((root) => {
        const overlay = root.firstElementChild as Element & {
          outlineDebugInfo?: () => Record<string, unknown>;
        };
        return overlay.outlineDebugInfo?.().connected ?? null;
      }),
    )
    .toBe(false);
});

test("the active chrome accepts outline state only from its captured private port", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2_400, height: 900 });
  const artifact = `<!doctype html><html><head><style>
    body{max-width:700px;margin:40px auto;font-family:system-ui}main{position:static}
    </style></head><body><main><h1>Database migration plan</h1><h2>Context</h2><p>A</p><h2>Milestones</h2><p>B</p><h2>Risks</h2><p>C</p></main></body></html>`;
  await openViewer(page, artifact);
  const region = on(page).surfaceRegion();

  await expect
    .poll(async () => Number(await region.getAttribute("data-outline-generation")))
    .toBeGreaterThan(0);
  const generation = await region.getAttribute("data-outline-generation");
  const health = await region.getAttribute("data-outline-health");
  expect(health).toMatch(/^(?:|AO-00[1-5])$/);
  expect(`${generation}:${health}`).not.toContain("Context");

  await surfaceOf(page)
    .locator("body")
    .evaluate(() => {
      window.parent.postMessage(
        {
          type: "outline-snapshot",
          requestGeneration: 999,
          generation: 999,
          availability: "complete",
          headings: [
            { key: "forged-1", label: "Forged one" },
            { key: "forged-2", label: "Forged two" },
          ],
          activeKey: "forged-1",
          proof: { complete: true, clearancePx: 999, reason: "forged" },
        },
        "*",
      );
      window.parent.postMessage(
        { source: "lucid-overlay", type: "swap-complete", revision: 1 },
        "*",
      );
      window.postMessage(
        {
          source: "lucid-chrome",
          type: "swap",
          html: "<!doctype html><html><body><h1>Forged swap</h1></body></html>",
          revision: 1,
        },
        "*",
      );
    });
  await page.waitForTimeout(100);
  await expect(
    surfaceOf(page).getByRole("heading", { name: "Database migration plan" }),
  ).toBeVisible();
  await expect(region).toHaveAttribute("data-outline-generation", generation ?? "");
  await expect(region).toHaveAttribute("data-outline-health", health ?? "");

  await cli.write(artifact.replace("<h2>Risks</h2>", "<h2>Execution</h2><h2>Risks</h2>"));
  await expect
    .poll(async () => Number(await region.getAttribute("data-outline-generation")))
    .toBeGreaterThan(Number(generation));
});

test("delayed font, image, and content reflow withdraw stale outline state until stable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2_400, height: 900 });
  await installOutlinePublicationProbe(page);
  let releaseFont!: () => void;
  let releaseImage!: () => void;
  const fontGate = new Promise<void>((resolve) => {
    releaseFont = resolve;
  });
  const imageGate = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  await page.route("https://lucid.invalid/delayed.ttf", async (route) => {
    await fontGate;
    await route.fulfill({
      contentType: "font/ttf",
      headers: { "access-control-allow-origin": "*" },
      // This font ships with the locked Playwright dependency, so the fixture
      // is repository-reproducible rather than coupled to a host font install.
      path: join(
        process.cwd(),
        "node_modules/playwright-core/lib/vite/recorder/assets/codicon-DCmgc-ay.ttf",
      ),
    });
  });
  await page.route("https://lucid.invalid/delayed.png", async (route) => {
    await imageGate;
    await route.fulfill({
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
      contentType: "image/png",
    });
  });
  const artifact = `<!doctype html><html><head><style>
    @font-face{font-family:DelayedOutline;src:url(https://lucid.invalid/delayed.ttf)}
    body{max-width:700px;margin:40px auto;font-family:system-ui}
    body.load-delayed-font{font-family:DelayedOutline,system-ui}
    #font-probe{display:inline-block;font-size:48px}
    #delayed-content-reflow{height:240px}
  </style></head><body><main><h1>Delayed outline</h1>
    <h2>Context</h2><p id="font-probe" data-lucid-id="pick-while-unsettled">&#xea60;&#xea60;&#xea60;&#xea60;</p>
    <h2>Milestones</h2><p>B</p><h2>Risks</h2><p>C</p>
  </main></body></html>`;
  await openViewer(page, artifact, "Delayed outline");
  const snapshots = (): Promise<Array<Record<string, unknown>>> => outlineProbeSnapshots(page);

  await expect
    .poll(async () => (await outlineDebugInfo(page))?.proofReason ?? "missing")
    .toBe("complete-unused-rectangle");
  await expect(on(page).artifactOutline()).toHaveAttribute("data-mode", "pinned");
  const initialGeneration = Number((await snapshots()).at(-1)?.generation ?? 0);
  const beforeImage = (await outlineProbeMessages(page)).length;
  await surfaceOf(page)
    .locator("main")
    .evaluate((main) => {
      const image = document.createElement("img");
      image.alt = "layout probe";
      image.src = "https://lucid.invalid/delayed.png";
      main.prepend(image);
      const view = main.ownerDocument.defaultView as Window & { __assetTimer?: number };
      view.__assetTimer = view.setInterval(() => {
        main.ownerDocument.body.toggleAttribute("data-assets-active");
      }, 10);
    });
  await expect
    .poll(async () =>
      (await outlineProbeMessages(page))
        .slice(beforeImage)
        .some(({ type }) => type === "outline-invalidated"),
    )
    .toBe(true);
  await expect(on(page).artifactOutline()).toHaveCount(0);
  await surfaceOf(page).locator('[data-lucid-id="pick-while-unsettled"]').click();
  await expect(on(page).annotationNote()).toBeVisible();
  await on(page).annotationNote().press("Escape");
  await expect(on(page).annotationNote()).toHaveCount(0);
  await surfaceOf(page)
    .locator("main")
    .evaluate((main) => {
      const view = main.ownerDocument.defaultView as Window & { __assetTimer?: number };
      if (view.__assetTimer !== undefined) view.clearInterval(view.__assetTimer);
    });
  await expect
    .poll(async () =>
      Number(
        (await snapshots()).findLast(
          ({ proof }) =>
            (proof as Record<string, unknown> | undefined)?.reason === "layout-unsettled",
        )?.generation ?? 0,
      ),
    )
    .toBeGreaterThan(initialGeneration);
  const unsettledDebug = await outlineDebugInfo(page);
  expect(unsettledDebug).toMatchObject({ proofComplete: false, proofReason: "layout-unsettled" });
  expect(unsettledDebug?.taskCount).toBeLessThanOrEqual(3);
  expect(unsettledDebug?.lastDurationMs).toBeLessThanOrEqual(
    ARTIFACT_OUTLINE_POLICY.proofTimeBudgetMs + 4,
  );

  const imageUnsettledGeneration = Number((await snapshots()).at(-1)?.generation ?? 0);
  releaseImage();
  await expect
    .poll(async () => Number((await snapshots()).at(-1)?.generation ?? 0))
    .toBeGreaterThan(imageUnsettledGeneration);
  await expect(on(page).artifactOutline()).toHaveAttribute("data-mode", "pinned");

  const fontWidthBefore = await surfaceOf(page)
    .locator("#font-probe")
    .evaluate((element) => element.getBoundingClientRect().width);
  const beforeFont = (await outlineProbeMessages(page)).length;
  await surfaceOf(page)
    .locator("body")
    .evaluate((body) => body.setAttribute("class", "load-delayed-font"));
  await expect
    .poll(async () =>
      (await outlineProbeMessages(page))
        .slice(beforeFont)
        .some(({ type }) => type === "outline-invalidated"),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      Number(
        (await snapshots()).findLast(
          ({ proof }) =>
            (proof as Record<string, unknown> | undefined)?.reason === "layout-unsettled",
        )?.generation ?? 0,
      ),
    )
    .toBeGreaterThan(imageUnsettledGeneration);
  await expect(on(page).artifactOutline()).toHaveCount(0);
  expect(
    (await outlineProbeMessages(page))
      .slice(beforeFont)
      .some(
        ({ availability, proof, type }) =>
          type === "outline-snapshot" &&
          (availability === "complete" ||
            (proof as Record<string, unknown> | undefined)?.complete === true),
      ),
  ).toBe(false);
  const fontUnsettledGeneration = Number((await snapshots()).at(-1)?.generation ?? 0);
  releaseFont();
  await surfaceOf(page)
    .locator("body")
    .evaluate(() => document.fonts.ready);
  await expect
    .poll(async () => Number((await snapshots()).at(-1)?.generation ?? 0))
    .toBeGreaterThan(fontUnsettledGeneration);
  await expect(on(page).artifactOutline()).toHaveAttribute("data-mode", "pinned");
  const fontWidthAfter = await surfaceOf(page)
    .locator("#font-probe")
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(Math.abs(fontWidthAfter - fontWidthBefore)).toBeGreaterThan(1);
  const stableSnapshots = await snapshots();
  const stable = stableSnapshots.at(-1);
  expect(stable).toMatchObject({
    availability: "complete",
    headings: [{ label: "Context" }, { label: "Milestones" }, { label: "Risks" }],
    proof: { complete: true },
  });
  const stableGeneration = Number(stable?.generation ?? 0);
  const stableMessageCount = (await outlineProbeMessages(page)).length;

  await surfaceOf(page)
    .locator("main")
    .evaluate((main) => {
      const reflow = document.createElement("div");
      reflow.id = "delayed-content-reflow";
      main.prepend(reflow);
      const view = main.ownerDocument.defaultView as Window & { __reflowTimer?: number };
      view.__reflowTimer = view.setInterval(() => {
        main.ownerDocument.body.toggleAttribute("data-reflow-active");
      }, 10);
    });
  await expect
    .poll(async () =>
      (await outlineProbeMessages(page))
        .slice(stableMessageCount)
        .some(({ type }) => type === "outline-invalidated"),
    )
    .toBe(true);
  await expect(on(page).artifactOutline()).toHaveCount(0);
  expect(
    (await outlineProbeMessages(page))
      .slice(stableMessageCount)
      .findIndex(({ type }) => type === "outline-snapshot"),
  ).toBe(-1);
  await surfaceOf(page)
    .locator("main")
    .evaluate((main) => {
      const view = main.ownerDocument.defaultView as Window & { __reflowTimer?: number };
      if (view.__reflowTimer !== undefined) view.clearInterval(view.__reflowTimer);
    });
  await expect
    .poll(async () => Number((await snapshots()).at(-1)?.generation ?? 0))
    .toBeGreaterThan(stableGeneration);
  const afterReflow = (await snapshots()).at(-1);
  expect(afterReflow).toMatchObject({
    availability: "complete",
    headings: [{ label: "Context" }, { label: "Milestones" }, { label: "Risks" }],
  });
  await expect(on(page).warning()).toHaveCount(0);
  expect(JSON.stringify(await outlineDebugInfo(page))).not.toContain("Context");
});

const hostileOutlineFixtures = [
  {
    name: "full-width wrapper",
    markup: '<aside id="hazard"></aside>',
    style: "#hazard{height:24px;width:100vw;margin-left:calc((700px - 100vw)/2);background:#eee}",
  },
  {
    name: "fixed paint",
    markup: '<aside id="hazard"></aside>',
    style: "#hazard{position:fixed;right:240px;top:120px;width:180px;height:120px;background:red}",
  },
  {
    name: "absolute paint",
    markup: '<aside id="hazard"></aside>',
    style:
      "#hazard{position:absolute;right:240px;top:120px;width:240px;height:120px;background:red}",
  },
  {
    name: "transformed paint",
    markup: '<aside id="hazard"></aside>',
    style: "#hazard{width:240px;height:30px;margin-left:712px;transform:translateX(1px)}",
  },
  {
    name: "sticky paint",
    markup: '<aside id="hazard"></aside>',
    style: "#hazard{position:sticky;top:20px;width:240px;height:30px;margin-left:712px}",
  },
  {
    name: "visible overflow",
    markup: '<aside id="hazard"><span></span></aside>',
    style:
      "#hazard{width:10px;height:30px;margin-left:650px;overflow:visible}#hazard span{display:block;width:300px;height:20px}",
  },
  {
    name: "pseudo-content",
    markup: '<aside id="hazard"></aside>',
    style:
      '#hazard{width:40px;height:30px;margin-left:650px}#hazard::after{content:"generated paint"}',
  },
  {
    name: "shadow paint",
    markup: '<aside id="hazard"></aside>',
    style: "#hazard{width:40px;height:30px;margin-left:650px;box-shadow:80px 0 40px red}",
  },
  {
    name: "clipped paint",
    markup: '<aside id="hazard"></aside>',
    style: "#hazard{width:40px;height:30px;margin-left:650px;clip-path:inset(1px)}",
  },
] as const;

for (const fixture of hostileOutlineFixtures) {
  test(`hostile ${fixture.name} fails pinned outline proof closed`, async ({ page }) => {
    await page.setViewportSize({ width: 2_400, height: 900 });
    await installOutlinePublicationProbe(page);
    const artifact = `<!doctype html><html><head><style>
      body{max-width:700px;margin:40px auto;font-family:system-ui}${fixture.style}
    </style></head><body><main><h1>Hostile outline</h1>
      <h2>Context</h2><p id="pick-target" data-lucid-id="hostile-pick">A</p>
      <h2>Milestones</h2><p>B</p><h2>Risks</h2><p>C</p>${fixture.markup}
    </main></body></html>`;
    await openViewer(page, artifact, "Hostile outline");

    const outline = on(page).artifactOutline();
    await expect
      .poll(async () => (await outlineDebugInfo(page))?.taskCount ?? 0)
      .toBeGreaterThan(0);
    await expect.poll(async () => (await outlineDebugInfo(page))?.headingCount ?? 0).toBe(3);
    await expect
      .poll(async () => (await outlineDebugInfo(page))?.pendingQuietTask ?? true)
      .toBe(false);
    const debug = await outlineDebugInfo(page);
    expect(debug).toMatchObject({
      headingCount: 3,
      pendingQuietTask: false,
      proofComplete: false,
    });
    expect(debug?.proofReason).not.toBe("not-requested");
    expect(
      (await outlineProbeSnapshots(page)).filter(
        ({ availability, proof }) =>
          availability === "complete" &&
          (proof as Record<string, unknown> | undefined)?.complete === true,
      ),
    ).toEqual([]);
    await expect(outline).toHaveAttribute("data-mode", "transient_closed");
    await on(page).artifactOutlineRail().click();
    await expect(outline).toHaveAttribute("data-mode", "transient_latched");
    await expect(on(page).artifactOutlineItem()).toHaveCount(3);
    await expect(on(page).artifactOutlineItem().nth(0)).toHaveAccessibleName("Context");
    await expect(on(page).artifactOutlineItem().nth(2)).toHaveAccessibleName("Risks");

    await surfaceOf(page).locator('[data-lucid-id="hostile-pick"]').click();
    await expect(on(page).annotationNote()).toBeVisible();
    await expect(on(page).warning()).toHaveCount(0);
  });
}

test("nested scroller and shadow headings stay transient and out of the projection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2_400, height: 900 });
  const artifact = `<!doctype html><html><head><style>
    body{max-width:700px;margin:40px auto;font-family:system-ui}
    #nested{height:80px;overflow-y:auto}#nested p{height:240px}
  </style></head><body><main><h1>Hostile outline</h1>
    <h2>Light one</h2><p data-lucid-id="hostile-pick">A</p>
    <div id="nested"><h2>Nested hidden</h2><p>B</p></div>
    <span id="shadow-host"></span><h2>Light two</h2><p>C</p><h2>Light three</h2><p>D</p>
  </main><script>
    const root=document.querySelector("#shadow-host").attachShadow({mode:"open"});
    root.innerHTML="<h2>Shadow hidden</h2><p>Secret</p>";
  </script></body></html>`;
  await openViewer(page, artifact, "Hostile outline");

  await expect(on(page).artifactOutline()).toHaveAttribute("data-mode", "transient_closed");
  await on(page).artifactOutlineRail().click();
  await expect(on(page).artifactOutline()).toHaveAttribute("data-mode", "transient_latched");
  await expect(on(page).artifactOutlineItem()).toHaveCount(3);
  await expect(on(page).artifactOutlineItem()).toHaveText([
    "Light one",
    "Light two",
    "Light three",
  ]);
  await expect(page.getByText("Nested hidden", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Shadow hidden", { exact: true })).toHaveCount(0);
  await surfaceOf(page).locator('[data-lucid-id="hostile-pick"]').click();
  await expect(on(page).annotationNote()).toBeVisible();
});

test("repeated permanent outline failure stays parent-owned, bounded, and silent", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2_400, height: 900 });
  const headings = Array.from(
    { length: 65 },
    (_, index) => `<h2>Sensitive permanent label ${index}</h2>`,
  ).join("");
  const { nextCursor } = await openViewer(
    page,
    `<!doctype html><html><head><style>body{max-width:700px;margin:40px auto}</style></head><body><h1>Permanent outline failure</h1>${headings}</body></html>`,
    "Permanent outline failure",
  );
  const region = on(page).surfaceRegion();
  await expect(region).toHaveAttribute("data-outline-health", "AO-001");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const beforeTaskCount = (await outlineDebugInfo(page))?.taskCount ?? 0;
    await surfaceOf(page)
      .locator("body")
      .evaluate((body, value) => body.setAttribute("data-permanent-retry", String(value)), attempt);
    await expect
      .poll(async () => (await outlineDebugInfo(page))?.taskCount ?? 0)
      .toBeGreaterThan(beforeTaskCount);
    await expect(region).toHaveAttribute("data-outline-health", "AO-001");
  }
  await expect(on(page).artifactOutline()).toHaveCount(0);
  // Gate 4's escape hatch deliberately suppresses the optional visible
  // escalation. Zero warnings satisfies the bounded at-most-one contract.
  await expect(on(page).warning()).toHaveCount(0);
  await expect(page.locator('[data-role="human"], [data-role="agent"]')).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain("Sensitive permanent label");
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((key) => key.includes("outline"))),
  ).toEqual([]);
  const payload = (await cli.run([
    "wait",
    cli.artifact,
    "--since",
    nextCursor,
    "--timeout",
    waitTimeoutSeconds(1),
  ])) as { annotations?: unknown[]; messages?: unknown[]; status: string };
  expect(payload).toMatchObject({ annotations: [], messages: [], status: "waiting" });
});

test("a proven gutter renders a pinned, accessible outline without changing the artifact frame", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2_400, height: 900 });
  await openViewer(
    page,
    `<!doctype html><html><head><style>body{max-width:700px;margin:40px auto;font-family:system-ui}</style></head><body><main><h1>Release plan</h1><h2>Context</h2><p>A</p><h2>Milestones</h2><p style="height:700px">B</p><h2>Risks</h2><p>C</p><h2>Post-release monitoring and operational follow-through</h2><p>D</p></main></body></html>`,
    "Release plan",
  );

  const outline = on(page).artifactOutline();
  await expect(outline).toHaveAttribute("data-mode", "pinned");
  await expect(on(page).artifactOutlinePanel()).toHaveCSS("box-shadow", "none");
  const items = on(page).artifactOutlineItem();
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toHaveAccessibleName("Context");
  await expect(items.nth(1)).toHaveAccessibleName("Milestones");
  await expect(items.nth(3)).toHaveAccessibleName(
    "Post-release monitoring and operational follow-through",
  );
  expect(
    await items
      .nth(3)
      .locator("span")
      .evaluate((label) => label.scrollWidth > label.clientWidth),
  ).toBe(true);
  await expect(items.nth(0)).toHaveAttribute("aria-current", "location");

  const frameWidth = await page
    .locator('iframe[title="artifact surface"]')
    .evaluate((frame) => frame.getBoundingClientRect().width);
  await items.nth(1).click();
  await expect(items.nth(1)).toBeFocused();
  expect(
    await page
      .locator('iframe[title="artifact surface"]')
      .evaluate((frame) => frame.getBoundingClientRect().width),
  ).toBe(frameWidth);
});

test("the transient outline supports hover, latch, tab, Escape, and keyboard activation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_180, height: 760 });
  await openViewer(
    page,
    `<!doctype html><html><head><style>html,body,main{margin:0;width:100%;font-family:system-ui}h1,h2,p{padding:0 24px}</style></head><body><main><h1>Wide plan</h1><h2>Context</h2><p>A</p><h2>Execution</h2><p style="height:500px">B</p><h2>Risks</h2><p>C</p></main></body></html>`,
    "Wide plan",
  );

  const outline = on(page).artifactOutline();
  const rail = on(page).artifactOutlineRail();
  const panel = on(page).artifactOutlinePanel();
  const items = on(page).artifactOutlineItem();
  await expect(outline).toHaveAttribute("data-mode", "transient_closed");
  await expect(rail).toHaveAccessibleName("Open artifact outline");
  await expect(panel).toBeHidden();
  const railBox = await rail.boundingBox();
  const slotBox = await on(page).surfaceOutlineSlot().boundingBox();
  expect(railBox?.width).toBe(ARTIFACT_OUTLINE_POLICY.railInsetPx);
  expect(
    Math.abs(
      (railBox?.x ?? 0) + (railBox?.width ?? 0) - ((slotBox?.x ?? 0) + (slotBox?.width ?? 0)),
    ),
  ).toBeLessThanOrEqual(1);
  expect(await outline.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");
  expect(await rail.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("auto");
  const expectedRailBackground = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "bg-ink-850/95";
    document.body.append(probe);
    const background = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return background;
  });
  expect(await rail.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    expectedRailBackground,
  );

  await rail.hover();
  await expect(outline).toHaveAttribute("data-mode", "transient_hover");
  await expect(panel).toBeVisible();
  await panel.hover();
  await page.waitForTimeout(220);
  await expect(panel).toBeVisible();
  await rail.click();
  await expect(outline).toHaveAttribute("data-mode", "transient_latched");
  await expect(rail).toBeFocused();
  const surface = on(page).surfaceRegion();
  const generation = Number(await surface.getAttribute("data-outline-generation"));
  await page.setViewportSize({ width: 1_181, height: 760 });
  await expect
    .poll(async () => Number(await surface.getAttribute("data-outline-generation")))
    .toBeGreaterThan(generation);
  await expect(outline).toHaveAttribute("data-mode", "transient_latched");
  await expect(rail).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(outline).toHaveAttribute("data-mode", "transient_closed");
  await expect(rail).toBeFocused();

  await page.mouse.move(20, 20);
  await rail.hover();
  await expect(outline).toHaveAttribute("data-mode", "transient_hover");
  await page.mouse.move(20, 20);
  await expect(outline).toHaveAttribute("data-mode", "transient_closed");

  await rail.click();
  await expect(outline).toHaveAttribute("data-mode", "transient_latched");
  await on(page).messageInput().filter({ visible: true }).click();
  await expect(outline).toHaveAttribute("data-mode", "transient_closed");

  await rail.focus();
  await expect(outline).toHaveAttribute("data-mode", "transient_latched");
  await items.nth(2).focus();
  await page.keyboard.press("Tab");
  await expect(outline).toHaveAttribute("data-mode", "transient_closed");

  await rail.focus();
  await expect(outline).toHaveAttribute("data-mode", "transient_latched");
  await page.keyboard.press("Tab");
  await items.nth(1).press("Enter");
  await expect(outline).toHaveAttribute("data-mode", "transient_closed");
  await expect(rail).toBeFocused();
});

test("activation applies a pin-capable proof that arrived during a transient latch", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1_180, height: 760 });
  await openViewer(
    page,
    `<!doctype html><html><head><style>body{max-width:700px;margin:40px auto;font-family:system-ui}</style></head><body><main><h1>Adaptive plan</h1><h2>Context</h2><p>A</p><h2>Execution</h2><p style="height:500px">B</p><h2>Risks</h2><p>C</p></main></body></html>`,
    "Adaptive plan",
  );

  const outline = on(page).artifactOutline();
  const rail = on(page).artifactOutlineRail();
  await expect(outline).toHaveAttribute("data-mode", "transient_closed");
  await rail.click();
  await expect(outline).toHaveAttribute("data-mode", "transient_latched");

  const originalGeneration = Number(
    await on(page).surfaceRegion().getAttribute("data-outline-generation"),
  );
  await page.setViewportSize({ width: 2_400, height: 760 });
  await expect
    .poll(async () =>
      Number(await on(page).surfaceRegion().getAttribute("data-outline-generation")),
    )
    .toBeGreaterThan(originalGeneration);
  await expect(outline).toHaveAttribute("data-mode", "transient_latched");

  await on(page).artifactOutlineItem().nth(0).click();
  await expect(outline).toHaveAttribute("data-mode", "pinned");
});

test("keyboard-closing a rail that becomes pinned hands focus to the surface", async ({ page }) => {
  await page.setViewportSize({ width: 1_180, height: 760 });
  await openViewer(
    page,
    `<!doctype html><html><head><style>body{max-width:700px;margin:40px auto;font-family:system-ui}</style></head><body><main><h1>Keyboard plan</h1><h2>Context</h2><p>A</p><h2>Execution</h2><p style="height:500px">B</p><h2>Risks</h2><p>C</p></main></body></html>`,
    "Keyboard plan",
  );

  const outline = on(page).artifactOutline();
  const rail = on(page).artifactOutlineRail();
  await rail.focus();
  await expect(outline).toHaveAttribute("data-mode", "transient_latched");
  const originalGeneration = Number(
    await on(page).surfaceRegion().getAttribute("data-outline-generation"),
  );
  await page.setViewportSize({ width: 2_400, height: 760 });
  await expect
    .poll(async () =>
      Number(await on(page).surfaceRegion().getAttribute("data-outline-generation")),
    )
    .toBeGreaterThan(originalGeneration);
  await expect(rail).toBeFocused();

  await rail.press("Enter");
  await expect(outline).toHaveAttribute("data-mode", "pinned");
  await expect(on(page).surfaceRegion()).toBeFocused();
});

test("touch opens and activates the transient outline", async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 1_180, height: 760 },
  });
  const touchPage = await context.newPage();
  try {
    await openViewer(
      touchPage,
      `<!doctype html><html><head><style>html,body{margin:0;width:100%;font-family:system-ui}h1,h2,p{padding:0 24px}</style></head><body><main><h1>Touch plan</h1><h2>Context</h2><p>A</p><h2>Execution</h2><p style="height:600px">B</p><h2>Risks</h2><p>C</p></main></body></html>`,
      "Touch plan",
    );
    const outline = on(touchPage).artifactOutline();
    const rail = on(touchPage).artifactOutlineRail();
    await expect(outline).toHaveAttribute("data-mode", "transient_closed");
    const railBox = await rail.boundingBox();
    expect(railBox).not.toBeNull();
    if (railBox === null) return;
    await rail.tap();
    await expect(outline).toHaveAttribute("data-mode", "transient_latched");
    await rail.tap();
    await expect(outline).toHaveAttribute("data-mode", "transient_closed");
    await rail.tap();
    await expect(outline).toHaveAttribute("data-mode", "transient_latched");

    const item = on(touchPage).artifactOutlineItem().nth(1);
    const itemBox = await item.boundingBox();
    expect(itemBox).not.toBeNull();
    if (itemBox === null) return;
    await item.tap();
    await expect(outline).toHaveAttribute("data-mode", "transient_closed");
    await expect(
      surfaceOf(touchPage).getByRole("heading", { exact: true, level: 2, name: "Execution" }),
    ).toBeInViewport();
  } finally {
    await context.close();
  }
});

test("a tall pinned outline scrolls internally while the artifact scrollbar remains operable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2_400, height: 520 });
  const sections = Array.from(
    { length: 24 },
    (_, index) => `<h2>Section ${index + 1}</h2><p style="height:80px">Body ${index + 1}</p>`,
  ).join("");
  await openViewer(
    page,
    `<!doctype html><html><head><style>body{max-width:700px;margin:32px auto;font-family:system-ui}</style></head><body><h1>Long plan</h1>${sections}</body></html>`,
    "Long plan",
  );
  const outline = on(page).artifactOutline();
  const list = page.locator('nav[aria-label="Artifact sections"]');
  await expect(outline).toHaveAttribute("data-mode", "pinned");
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await list.evaluate((element) => {
    element.scrollTop = 80;
  });
  expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await surfaceOf(page)
    .locator("html")
    .evaluate((element) => {
      element.scrollTop = 120;
    });
  expect(
    await surfaceOf(page)
      .locator("html")
      .evaluate((element) => element.scrollTop),
  ).toBe(120);

  await surfaceOf(page)
    .locator("html")
    .evaluate((element) => {
      const view = element.ownerDocument.defaultView as Window & { __outlineScrollTimer?: number };
      view.__outlineScrollTimer = view.setInterval(() => {
        element.scrollTop += 1;
      }, 20);
    });
  await expect(outline).toHaveCount(0);
  await surfaceOf(page)
    .locator("html")
    .evaluate((element) => {
      const view = element.ownerDocument.defaultView as Window & { __outlineScrollTimer?: number };
      if (view.__outlineScrollTimer !== undefined) view.clearInterval(view.__outlineScrollTimer);
    });
  await expect(outline).toHaveCount(1);
});

test("gutter loss preserves focused navigation as a latched transient interaction", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2_400, height: 820 });
  await openViewer(
    page,
    `<!doctype html><html><head><style>body{max-width:700px;margin:40px auto}</style></head><body><h1>Responsive plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p><h2>Three</h2><p>C</p></body></html>`,
    "Responsive plan",
  );
  const outline = on(page).artifactOutline();
  const focusedItem = on(page).artifactOutlineItem().nth(1);
  const shell = page.locator('[data-slot="sidebar-wrapper"]');
  await expect(outline).toHaveAttribute("data-mode", "pinned");
  await focusedItem.focus();
  await expect(focusedItem).toBeFocused();

  await shell.evaluate((element) => element.style.setProperty("--sidebar-width", "1860px"));
  await expect(focusedItem).toBeFocused({ timeout: 200 });
  await expect(outline).toHaveAttribute("data-mode", "transient_latched");
  await expect(focusedItem).toBeFocused();

  await page.keyboard.press("Escape");
  const rail = on(page).artifactOutlineRail();
  await expect(outline).toHaveAttribute("data-mode", "transient_closed");
  await expect(rail).toBeFocused();
  await shell.evaluate((element) => element.style.setProperty("--sidebar-width", "640px"));
  await expect(outline).toHaveAttribute("data-mode", "pinned");
  await expect(on(page).surfaceRegion()).toBeFocused();
});

test("browser layout retains mode inside the pinned and transient hysteresis band", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2_400, height: 820 });
  await openViewer(
    page,
    `<!doctype html><html><head><style>body{max-width:700px;margin:40px auto}</style></head><body><h1>Hysteresis plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p><h2>Three</h2><p>C</p></body></html>`,
    "Hysteresis plan",
  );
  const outline = on(page).artifactOutline();
  const region = on(page).surfaceRegion();
  const shell = page.locator('[data-slot="sidebar-wrapper"]');
  const setSidebarWidth = async (
    width: number,
  ): Promise<{
    debug: Awaited<ReturnType<typeof outlineDebugInfo>>;
    mode: string;
  }> => {
    const generation = Number(await region.getAttribute("data-outline-generation"));
    await shell.evaluate((element, nextWidth) => {
      element.style.setProperty("--sidebar-width", `${nextWidth}px`);
    }, width);
    await expect
      .poll(async () => Number(await region.getAttribute("data-outline-generation")))
      .toBeGreaterThan(generation);
    await expect(outline).toHaveAttribute("data-mode", /^(?:pinned|transient_closed)$/);
    return {
      debug: await outlineDebugInfo(page),
      mode: (await outline.getAttribute("data-mode")) ?? "absent",
    };
  };
  const hasClearance = (
    state: Awaited<ReturnType<typeof setSidebarWidth>>,
    threshold: number,
  ): boolean => state.debug?.proofComplete === true && state.debug.proofClearancePx >= threshold;
  await expect(outline).toHaveAttribute("data-mode", "pinned");
  let lowerWidth = 640;
  let upperWidth = 1_856;
  let bandProbe:
    | { clearance: number; state: Awaited<ReturnType<typeof setSidebarWidth>>; width: number }
    | undefined;
  while (upperWidth - lowerWidth > 1) {
    const width = Math.floor((lowerWidth + upperWidth) / 2);
    const state = await setSidebarWidth(width);
    const clearance = state.debug?.proofClearancePx ?? 0;
    if (hasClearance(state, 12)) lowerWidth = width;
    else if (!hasClearance(state, 8)) upperWidth = width;
    else {
      bandProbe = { clearance, state, width };
      break;
    }
  }
  if (bandProbe === undefined) throw new Error("no browser hysteresis band found");
  const neighbourWidth = bandProbe.width + 2;
  const neighbour = await setSidebarWidth(neighbourWidth);
  const neighbourClearance = neighbour.debug?.proofClearancePx ?? 0;
  const clearanceSlope = (neighbourClearance - bandProbe.clearance) / 2;
  expect(clearanceSlope).toBeLessThan(0);
  const regainWidth = Math.floor(
    bandProbe.width + (12 - bandProbe.clearance) / clearanceSlope + 1e-6,
  );
  const lossWidth =
    Math.floor(bandProbe.width + (8 - bandProbe.clearance) / clearanceSlope + 1e-6) + 1;
  expect(lossWidth - regainWidth).toBeGreaterThanOrEqual(4);

  const bandWidth = Math.floor((lossWidth + regainWidth) / 2);
  await setSidebarWidth(640);
  await expect(outline).toHaveAttribute("data-mode", "pinned");
  const lost = await setSidebarWidth(lossWidth);
  expect(hasClearance(lost, 8)).toBe(false);
  await expect(outline).toHaveAttribute("data-mode", "transient_closed");
  const enteredBand = await setSidebarWidth(bandWidth);
  expect(hasClearance(enteredBand, 8)).toBe(true);
  expect(hasClearance(enteredBand, 12)).toBe(false);
  await expect(outline).toHaveAttribute("data-mode", "transient_closed");
  const regained = await setSidebarWidth(regainWidth);
  expect(hasClearance(regained, 12)).toBe(true);
  await expect(outline).toHaveAttribute("data-mode", "pinned");
  await setSidebarWidth(bandWidth);
  await expect(outline).toHaveAttribute("data-mode", "pinned");
});

test("outline removal transfers focused navigation back to the stable surface", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2_400, height: 900 });
  const artifact = `<!doctype html><html><head><style>body{max-width:700px;margin:40px auto}</style></head><body><h1>Plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p></body></html>`;
  await openViewer(page, artifact, "Plan");
  const item = on(page).artifactOutlineItem().nth(0);
  await expect(item).toBeVisible();
  await item.focus();

  await cli.write(artifact.replace("<h2>Two</h2><p>B</p>", ""));
  await expect(on(page).artifactOutline()).toHaveCount(0);
  await expect(on(page).surfaceRegion()).toBeFocused();
});

test("projection replacement never redirects focus to a different section", async ({ page }) => {
  await page.setViewportSize({ width: 2_400, height: 900 });
  const artifact = `<!doctype html><html><head><style>body{max-width:700px;margin:40px auto}</style></head><body><h1>Plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p><h2>Three</h2><p>C</p></body></html>`;
  await openViewer(page, artifact, "Plan");
  const item = page.getByRole("button", { name: "Two", exact: true });
  await item.focus();

  const reordered = artifact.replace(
    "<h2>One</h2><p>A</p><h2>Two</h2><p>B</p>",
    "<h2>Two</h2><p>B</p><h2>One</h2><p>A</p>",
  );
  await cli.write(reordered);
  await expect(on(page).surfaceRegion()).toBeFocused();

  await page.getByRole("button", { name: "Two", exact: true }).focus();
  await cli.write(reordered.replace("<h2>Two</h2><p>B</p>", ""));
  await expect(on(page).surfaceRegion()).toBeFocused();
});

test("reloading the same artifact frame replaces its private outline channel", async ({ page }) => {
  await page.setViewportSize({ width: 2_400, height: 900 });
  const artifact = `<!doctype html><html><head><style>body{max-width:700px;margin:40px auto}</style></head><body><h1>Reload plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p></body></html>`;
  await openViewer(page, artifact, "Reload plan");
  const surface = surfaceOf(page);
  await expect(on(page).artifactOutlineItem().nth(0)).toHaveAccessibleName("One");

  await surface.getByRole("heading", { exact: true, level: 2, name: "One" }).evaluate((heading) => {
    heading.textContent = "Stale one";
  });
  await expect(on(page).artifactOutlineItem().nth(0)).toHaveAccessibleName("Stale one");

  await surface.locator("body").evaluate(() => {
    window.setTimeout(() => window.location.reload(), 0);
  });
  await expect(surface.getByRole("heading", { exact: true, level: 2, name: "One" })).toBeVisible();
  await expect(on(page).artifactOutlineItem().nth(0)).toHaveAccessibleName("One");
});

test("leaving a pending projection keeps focus on the chosen chrome control", async ({ page }) => {
  await page.setViewportSize({ width: 2_400, height: 900 });
  const artifact = `<!doctype html><html><head><style>body{max-width:700px;margin:40px auto}</style></head><body><h1>Plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p><h2>Three</h2><p>C</p></body></html>`;
  await openViewer(page, artifact, "Plan");
  const item = page.getByRole("button", { name: "Two", exact: true });
  await item.focus();

  await surfaceOf(page)
    .locator("body")
    .evaluate((body) => {
      const view = body.ownerDocument.defaultView as Window & { __outlineMutation?: number };
      let sequence = 0;
      view.__outlineMutation = view.setInterval(() => {
        sequence += 1;
        body.dataset.outlineMutation = String(sequence);
      }, 20);
    });
  await expect(on(page).surfaceRegion()).toHaveAttribute("data-outline-health", "AO-005");
  await expect(item).toBeFocused();

  const input = on(page).messageInput().filter({ visible: true });
  await input.click();
  await page.waitForTimeout(650);
  await expect(input).toBeFocused();
  await surfaceOf(page)
    .locator("body")
    .evaluate((body) => {
      const view = body.ownerDocument.defaultView as Window & { __outlineMutation?: number };
      if (view.__outlineMutation !== undefined) view.clearInterval(view.__outlineMutation);
    });
});

test("panel drag, collapse, and reopen re-evaluate outline mode without shrinking the frame", async ({
  page,
}) => {
  await page.setViewportSize({ width: 2_400, height: 820 });
  const artifact = `<!doctype html><html><head><style>body{max-width:700px;margin:40px auto}</style></head><body><h1>Responsive outline</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p><h2>Three</h2><p>C</p></body></html>`;
  const withoutOutline = artifact
    .replace("<h2>Two</h2>", "<p>Two</p>")
    .replace("<h2>Three</h2>", "<p>Three</p>");
  const withScrollbar = artifact.replace("<p>C</p>", '<p style="height:1400px">C</p>');
  await openViewer(page, artifact, "Responsive outline");
  const outline = on(page).artifactOutline();
  const frame = page.locator('iframe[title="artifact surface"]');
  const surface = surfaceOf(page);
  const region = on(page).surfaceRegion();
  const geometry = async (): Promise<{
    contentWidth: number;
    frameHeight: number;
    frameWidth: number;
    parentHeight: number;
    parentWidth: number;
    viewportWidth: number;
  }> => {
    const frameGeometry = await frame.evaluate((element) => {
      const frameRect = element.getBoundingClientRect();
      const parentRect = element.parentElement?.getBoundingClientRect();
      return {
        frameHeight: frameRect.height,
        frameWidth: frameRect.width,
        parentHeight: parentRect?.height ?? 0,
        parentWidth: parentRect?.width ?? 0,
      };
    });
    const artifactGeometry = await surface.locator("body").evaluate((body) => ({
      contentWidth: Math.round(
        Math.max(
          0,
          ...Array.from(body.children)
            .filter((child) => child.id !== "__lucid_overlay_root" && child.tagName !== "SCRIPT")
            .map((child) => child.getBoundingClientRect().width),
        ),
      ),
      viewportWidth: body.ownerDocument.documentElement.clientWidth,
    }));
    return { ...frameGeometry, ...artifactGeometry };
  };
  const assertFrameFillsSurface = async () => {
    const measured = await geometry();
    expect(Math.abs(measured.frameWidth - measured.parentWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs(measured.frameHeight - measured.parentHeight)).toBeLessThanOrEqual(1);
    return measured;
  };
  const waitForFreshProjection = async (previousGeneration: number): Promise<void> => {
    await expect
      .poll(async () => Number(await region.getAttribute("data-outline-generation")))
      .toBeGreaterThan(previousGeneration);
  };
  const dragDivider = async (deltaX: number): Promise<void> => {
    const divider = page.locator('[aria-label="Resize the review panel"]');
    const box = await divider.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + deltaX, y, { steps: 12 });
    await expect(outline).toHaveCount(0);
    await page.waitForTimeout(350);
    await expect(outline).toHaveCount(0);
    await page.mouse.up();
  };

  await expect(outline).toHaveAttribute("data-mode", "pinned");
  const initialPinned = await assertFrameFillsSurface();

  let generation = Number(await region.getAttribute("data-outline-generation"));
  await cli.write(withScrollbar);
  await waitForFreshProjection(generation);
  await expect
    .poll(() =>
      surface.locator("html").evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);
  await expect(outline).toHaveAttribute("data-mode", "pinned");
  const scrolledPinned = await assertFrameFillsSurface();
  expect(scrolledPinned.frameWidth).toBe(initialPinned.frameWidth);
  expect(scrolledPinned.contentWidth).toBe(initialPinned.contentWidth);

  generation = Number(await region.getAttribute("data-outline-generation"));
  await cli.write(artifact);
  await waitForFreshProjection(generation);
  await expect
    .poll(() =>
      surface.locator("html").evaluate((element) => element.scrollHeight <= element.clientHeight),
    )
    .toBe(true);
  await expect(outline).toHaveAttribute("data-mode", "pinned");

  await cli.write(withoutOutline);
  await expect(outline).toHaveCount(0);
  const wideAbsent = await assertFrameFillsSurface();
  expect(wideAbsent.frameWidth).toBe(initialPinned.frameWidth);
  expect(wideAbsent.viewportWidth).toBe(initialPinned.viewportWidth);
  expect(wideAbsent.contentWidth).toBe(initialPinned.contentWidth);
  await cli.write(artifact);
  await expect(outline).toHaveAttribute("data-mode", "pinned");

  await dragDivider(-850);
  await expect(outline).toHaveAttribute("data-mode", "transient_closed");
  const transient = await assertFrameFillsSurface();

  await cli.write(withoutOutline);
  await expect(outline).toHaveCount(0);
  const narrowAbsent = await assertFrameFillsSurface();
  expect(narrowAbsent.frameWidth).toBe(transient.frameWidth);
  expect(narrowAbsent.viewportWidth).toBe(transient.viewportWidth);
  expect(narrowAbsent.contentWidth).toBe(transient.contentWidth);
  await cli.write(artifact);
  await expect(outline).toHaveAttribute("data-mode", "transient_closed");

  await on(page).panelToggle().click();
  await expect(outline).toHaveAttribute("data-mode", "pinned");
  await assertFrameFillsSurface();

  await on(page).panelToggle().click();
  await expect(outline).toHaveAttribute("data-mode", "transient_closed");
  await assertFrameFillsSurface();

  await dragDivider(850);
  await expect(outline).toHaveAttribute("data-mode", "pinned");
  await assertFrameFillsSurface();
});

test("wheel, scrollbar, keyboard, and outline scrolling keep the active section current", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1_180, height: 760 });
  const sections = Array.from(
    { length: 20 },
    (_, index) => `<h2>Section ${index + 1}</h2><p style="height:160px">Body ${index + 1}</p>`,
  ).join("");
  await openViewer(
    page,
    `<!doctype html><html><head><style>html{overflow-y:scroll}html::-webkit-scrollbar{width:16px}html::-webkit-scrollbar-track{background:#eee}html::-webkit-scrollbar-thumb{background:#777;border:2px solid #eee}html,body{margin:0;width:100%;font-family:system-ui}h1,h2,p{padding:0 24px}</style></head><body><h1>Scrollable outline</h1>${sections}</body></html>`,
    "Scrollable outline",
  );
  const frame = page.locator('iframe[title="artifact surface"]');
  const surface = surfaceOf(page);
  const root = surface.locator("html");
  const outline = on(page).artifactOutline();
  const rail = on(page).artifactOutlineRail();
  const items = on(page).artifactOutlineItem();
  const currentLabel = async (): Promise<string | null> =>
    items.evaluateAll(
      (elements) =>
        elements.find((element) => element.getAttribute("aria-current") === "location")
          ?.textContent ?? null,
    );

  await expect(outline).toHaveAttribute("data-mode", "transient_closed");
  await rail.focus();
  await expect(outline).toHaveAttribute("data-mode", "transient_latched");
  await expect(items.nth(0)).toHaveAttribute("aria-current", "location");
  const frameBox = await frame.boundingBox();
  const railBox = await rail.boundingBox();
  expect(frameBox).not.toBeNull();
  expect(railBox).not.toBeNull();
  if (frameBox === null || railBox === null) return;
  expect(frameBox.x + frameBox.width - (railBox.x + railBox.width)).toBeGreaterThanOrEqual(18);

  await frame.hover({ position: { x: frameBox.width / 2, y: frameBox.height / 2 } });
  await page.mouse.wheel(0, 900);
  await expect.poll(() => root.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(currentLabel).not.toBe("Section 1");

  await surface.locator("body").evaluate((body) => {
    body.tabIndex = -1;
    body.focus();
  });
  let projectionGeneration = Number(
    await on(page).surfaceRegion().getAttribute("data-outline-generation"),
  );
  await page.keyboard.press("Home");
  await expect.poll(() => root.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
  await expect
    .poll(async () =>
      Number(await on(page).surfaceRegion().getAttribute("data-outline-generation")),
    )
    .toBeGreaterThan(projectionGeneration);
  await rail.focus();
  await expect(outline).toHaveAttribute("data-mode", "transient_latched");
  await expect.poll(currentLabel).toBe("Section 1");
  await surface.locator("body").evaluate((body) => body.focus());
  projectionGeneration = Number(
    await on(page).surfaceRegion().getAttribute("data-outline-generation"),
  );
  await page.keyboard.press("End");
  await expect.poll(() => root.evaluate((element) => element.scrollTop)).toBeGreaterThan(1_000);
  await expect
    .poll(async () =>
      Number(await on(page).surfaceRegion().getAttribute("data-outline-generation")),
    )
    .toBeGreaterThan(projectionGeneration);
  await rail.focus();
  await expect(outline).toHaveAttribute("data-mode", "transient_latched");
  await expect.poll(currentLabel).not.toBe("Section 1");
  // macOS Chromium keeps its root scrollbar as an overlay even when the
  // artifact requests a deterministic CSS width. Prove the native strip still
  // belongs to the iframe; the programmatic move exercises the same root
  // scroll event and active-section path without pretending a hidden thumb was
  // dragged.
  expect(
    await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("title"), {
      x: frameBox.x + frameBox.width - 4,
      y: frameBox.y + frameBox.height / 2,
    }),
  ).toBe("artifact surface");
  const beforeScrollbarLabel = await currentLabel();
  const beforeScrollbarScroll = await root.evaluate((element) => element.scrollTop);
  await root.evaluate((element) => {
    element.scrollTo({ behavior: "instant", top: 1_200 });
  });
  await expect
    .poll(() => root.evaluate((element) => element.scrollTop))
    .not.toBe(beforeScrollbarScroll);
  await expect.poll(currentLabel).not.toBe(beforeScrollbarLabel);
  const surfaceRegion = on(page).surfaceRegion();
  await expect
    .poll(async () => {
      const chromeGeneration = Number(await surfaceRegion.getAttribute("data-outline-generation"));
      const debug = await outlineDebugInfo(page);
      return (
        debug?.pendingFrame === false &&
        debug.pendingQuietTask === false &&
        debug.generation === chromeGeneration
      );
    })
    .toBe(true);

  const beforeActivation = await currentLabel();
  await items.nth(1).click();
  await expect(outline).toHaveAttribute("data-mode", "transient_closed");
  const target = surface.getByRole("heading", { exact: true, level: 2, name: "Section 2" });
  await expect
    .poll(() =>
      target.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
      }),
    )
    .toBe(true);
  await expect(surface.locator(".section-emphasis")).toHaveCSS("animation-name", "none");
  await rail.focus();
  await expect.poll(currentLabel).not.toBe(beforeActivation);
});

test("a tall outline stays clear of stale controls, a question, and the root scrollbar", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const browserNow = Date.now.bind(Date);
    Date.now = () => browserNow() + 11 * 60 * 1_000;
  });
  await page.setViewportSize({ width: 2_400, height: 650 });
  const sections = Array.from(
    { length: 24 },
    (_, index) =>
      `<h2>Section ${index + 1}</h2><p data-lucid-id="section-${index + 1}" style="height:90px">Body ${index + 1}</p>`,
  ).join("");
  await openViewer(
    page,
    `<!doctype html><html><head><style>body{max-width:700px;margin:32px auto;font-family:system-ui}</style></head><body><h1>Busy outline</h1>${sections}</body></html>`,
    "Busy outline",
  );
  const surface = surfaceOf(page);
  const outline = on(page).artifactOutline();
  await expect(outline).toHaveAttribute("data-mode", "pinned");

  await cli.run(["intent", cli.artifact, "revise"]);
  await expect(on(page).surfaceUpdating()).toHaveAttribute("data-stale", "true");
  await surface.locator("p").nth(0).click();
  await surface
    .locator("p")
    .nth(1)
    .click({ modifiers: [mod()] });
  await expect(on(page).cancelPicks()).toBeVisible();
  const parallax = on(page).artifactParallax();
  await parallax.evaluate((element) => {
    element.setAttribute("style", "transition-duration: 2000ms");
  });
  const beforeDrawerGeneration = Number(
    await on(page).surfaceRegion().getAttribute("data-outline-generation"),
  );
  await cli.run([
    "ask",
    cli.artifact,
    "--text",
    "Which section should remain the operational checkpoint?",
    "--option",
    "Section 12|Keep the middle checkpoint",
  ]);
  await expect(on(page).questionDrawer()).toBeVisible();
  await expect(outline).toHaveCount(0);
  const divider = page.locator('[aria-label="Resize the review panel"]');
  const dividerBox = await divider.boundingBox();
  expect(dividerBox).not.toBeNull();
  if (dividerBox !== null) {
    const x = dividerBox.x + dividerBox.width / 2;
    const y = dividerBox.y + dividerBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 20, y, { steps: 4 });
    await page.mouse.up();
  }
  // Releasing the divider must not release the drawer's independent motion
  // lease and briefly re-admit stale proof.
  await expect(outline).toHaveCount(0);
  await expect
    .poll(() => parallax.evaluate((element) => getComputedStyle(element).translate))
    .toContain("-12px");
  await expect
    .poll(async () =>
      Number(await on(page).surfaceRegion().getAttribute("data-outline-generation")),
    )
    .toBeGreaterThan(beforeDrawerGeneration);
  await expect(outline).toHaveCount(1);

  const panel = on(page).artifactOutlinePanel();
  if ((await outline.getAttribute("data-mode")) !== "pinned") {
    await on(page).artifactOutlineRail().focus();
  }
  await expect(panel).toBeVisible();
  const list = page.locator('nav[aria-label="Artifact sections"]');
  const stack = on(page).surfaceControlStack();
  const drawer = on(page).questionDrawer();
  const frame = page.locator('iframe[title="artifact surface"]');
  const boxes = await Promise.all([panel.boundingBox(), frame.boundingBox()]);
  for (const box of boxes) expect(box).not.toBeNull();
  const [panelBox, frameBox] = boxes;
  if (panelBox === null || frameBox === null) return;
  expect(await overlaps(panel, stack)).toBe(false);
  expect(await overlaps(panel, drawer)).toBe(false);
  expect(frameBox.x + frameBox.width - (panelBox.x + panelBox.width)).toBeGreaterThanOrEqual(18);
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(
    await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute("title"), {
      x: frameBox.x + frameBox.width - 4,
      y: frameBox.y + frameBox.height / 2,
    }),
  ).toBe("artifact surface");

  if (process.env.LUCID_OUTLINE_EVIDENCE === "1") {
    const evidenceDir = join(process.cwd(), ".plans/02-artifact-outline/evidence");
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      fullPage: false,
      path: join(evidenceDir, "m3.3-busy-outline.png"),
    });
  }
});

test("outline geometry remains crisp at representative one-x and two-x scales", async ({
  browser,
}) => {
  cli = await makeCli(
    `<!doctype html><html><head><style>body{max-width:700px;margin:40px auto;font-family:system-ui}</style></head><body><h1>Scale outline</h1><h2>Context</h2><p>A</p><h2>Execution</h2><p style="height:500px">B</p><h2>Risks</h2><p>C</p></body></html>`,
  );
  const session = (await cli.run(["open", cli.artifact])) as { url: string };
  for (const deviceScaleFactor of [1, 2]) {
    const context = await browser.newContext({
      deviceScaleFactor,
      reducedMotion: "reduce",
      viewport: { width: 1_180, height: 760 },
    });
    try {
      const scaledPage = await context.newPage();
      await scaledPage.goto(session.url);
      await expect(surfaceOf(scaledPage).locator("h1")).toContainText("Scale outline");
      expect(await scaledPage.evaluate(() => window.devicePixelRatio)).toBe(deviceScaleFactor);
      const outline = on(scaledPage).artifactOutline();
      await expect(outline).toHaveAttribute("data-mode", "transient_closed");
      const rail = on(scaledPage).artifactOutlineRail();
      const railBox = await rail.boundingBox();
      expect(railBox?.width).toBe(18);
      if (railBox === null) throw new Error("outline rail has no rendered box");
      const railCoordinates = [
        ["left", railBox.x],
        ["top", railBox.y],
        ["right", railBox.x + railBox.width],
        ["bottom", railBox.y + railBox.height],
        ["width", railBox.width],
        ["height", railBox.height],
      ] as const;
      expect(
        railCoordinates.filter(
          ([, coordinate]) => !Number.isInteger(coordinate * deviceScaleFactor),
        ),
        JSON.stringify({ deviceScaleFactor, railCoordinates }),
      ).toEqual([]);
      const borderWidth = Number.parseFloat(
        await rail.evaluate((element) => getComputedStyle(element).borderLeftWidth),
      );
      expect(Number.isInteger(borderWidth * deviceScaleFactor)).toBe(true);

      if (process.env.LUCID_OUTLINE_EVIDENCE === "1") {
        const evidenceDir = join(process.cwd(), ".plans/02-artifact-outline/evidence");
        await mkdir(evidenceDir, { recursive: true });
        await scaledPage.screenshot({
          fullPage: false,
          path: join(evidenceDir, `m3.3-scale-${deviceScaleFactor}x-closed.png`),
        });
      }

      await rail.focus();
      await expect(rail).toBeFocused();
      await expect(rail).toHaveCSS("outline-style", "solid");
      await expect(outline).toHaveAttribute("data-mode", "transient_latched");
      const items = on(scaledPage).artifactOutlineItem();
      await expect(items.nth(0)).toHaveAttribute("aria-current", "location");
      expect(await items.nth(0).evaluate((item) => getComputedStyle(item).color)).not.toBe(
        await items.nth(1).evaluate((item) => getComputedStyle(item).color),
      );

      if (process.env.LUCID_OUTLINE_EVIDENCE === "1") {
        const evidenceDir = join(process.cwd(), ".plans/02-artifact-outline/evidence");
        await scaledPage.screenshot({
          fullPage: false,
          path: join(evidenceDir, `m3.3-scale-${deviceScaleFactor}x-open.png`),
        });
      }
    } finally {
      await context.close();
    }
  }
});

test("an attempted CSSOM child realm permanently disables pinned proof", async ({ page }) => {
  const artifact = `<!doctype html><html><head><style>
    body{max-width:700px;margin:40px auto;font-family:system-ui}main{position:static}
    </style></head><body><main><h1>Database migration plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p></main>
    <script>
      const realm = document.createElement("iframe");
      realm.hidden = true;
      document.body.append(realm);
      try {
        window.__cleanStyleSetter = realm.contentWindow.CSSStyleDeclaration.prototype.setProperty;
      } catch (error) {
        window.__cleanStyleSetterError = error instanceof Error ? error.name : "unknown";
      }
      realm.remove();
    </script></body></html>`;
  await openOutlineProbeArtifact(page, artifact);
  await expect
    .poll(
      async () =>
        ((await latestOutlineProbeSnapshot(page))?.proof as Record<string, unknown> | undefined)
          ?.reason,
    )
    .toBe("untrusted-style-realm");

  expect(
    await surfaceOf(page)
      .locator("body")
      .evaluate(
        () =>
          (window as unknown as { __cleanStyleSetterError?: string }).__cleanStyleSetterError ??
          null,
      ),
  ).toBe("SecurityError");
});

test("collection intrinsic tampering cannot omit a paint hazard from proof", async ({ page }) => {
  const artifact = `<!doctype html><html><head><style>
    body{max-width:700px;margin:40px auto;font-family:system-ui}main{position:static}
    #hazard{position:fixed;right:20px;top:120px;width:180px;height:120px;background:red}
    </style></head><body><main><h1>Database migration plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p></main>
    <aside id="hazard"></aside><script>
      const originalSlice = Array.prototype.slice;
      Array.prototype.slice = function (...args) {
        const sliced = originalSlice.apply(this, args);
        return sliced.filter((value) => value?.id !== "hazard");
      };
    </script></body></html>`;
  await openOutlineProbeArtifact(page, artifact);
  await page.waitForTimeout(250);
  expect(await outlineProbeSnapshotCount(page)).toBe(0);
});

test("a self-restoring push trap cannot capture outline observer teardown", async ({ page }) => {
  const artifact = `<!doctype html><html><head><style>
    body{max-width:700px;margin:40px auto;font-family:system-ui}main{position:static}
    </style></head><body><main><h1>Database migration plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p></main>
    <script>
      const originalPush = Array.prototype.push;
      Array.prototype.push = function (...values) {
        const result = originalPush.apply(this, values);
        if (values.length === 7 && values.every((value) => typeof value === "function")) {
          Array.prototype.push = originalPush;
          for (const stop of values) stop();
          setTimeout(() => {
            const hazard = document.createElement("aside");
            hazard.id = "late-observer-hazard";
            hazard.setAttribute("style", "position:fixed;right:20px;top:120px;width:180px;height:120px;background:red");
            document.body.append(hazard);
          }, 100);
        }
        return result;
      };
    </script></body></html>`;
  await openOutlineProbeArtifact(page, artifact);
  await page.waitForTimeout(400);
  expect(await outlineProbeSnapshotCount(page)).toBe(0);
});

test("geometry intrinsic tampering cannot move proof away from a paint hazard", async ({
  page,
}) => {
  const artifact = `<!doctype html><html><head><style>
    body{max-width:700px;margin:40px auto;font-family:system-ui}main{position:static}
    #hazard{position:fixed;right:20px;top:120px;width:180px;height:120px;background:red}
    </style></head><body><main><h1>Database migration plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p></main>
    <aside id="hazard"></aside></body></html>`;
  await openOutlineProbeArtifact(page, artifact);
  await surfaceOf(page)
    .locator("body")
    .evaluate(() => {
      const originalMax = Math.max;
      Math.max = (...values: number[]) => {
        if (values.length === 2 && values[0] === 20) return 500;
        return originalMax(...values);
      };
    });
  await page.waitForTimeout(250);
  expect(await outlineProbeSnapshotCount(page)).toBe(0);
});

test("a self-restoring Object.freeze trap cannot poison the outline policy", async ({ page }) => {
  const artifact = `<!doctype html><html><head><style>
    body{max-width:700px;margin:40px auto;font-family:system-ui}main{position:static}
    #hazard{position:fixed;right:20px;top:120px;width:180px;height:120px;background:red}
    </style></head><body><main><h1>Database migration plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p></main>
    <aside id="hazard"></aside><script>
      const originalFreeze = Object.freeze;
      Object.freeze = (value) => {
        if (value && typeof value === "object" && "proofTimeBudgetMs" in value) {
          Object.freeze = originalFreeze;
          Object.defineProperty(value, "proofTimeBudgetMs", {
            get() {
              const originalMax = Math.max;
              Math.max = (...values) => values.length === 2 && values[0] === 20
                ? 500
                : originalMax(...values);
              return 8;
            },
          });
        }
        return value;
      };
    </script></body></html>`;
  await openOutlineProbeArtifact(page, artifact);
  await expect.poll(() => outlineProbeSnapshotCount(page)).toBeGreaterThan(0);
  expect(await latestOutlineProbeSnapshot(page)).toMatchObject({
    proof: { complete: false, reason: "box-intersection" },
  });
});

test("artifact MessagePort prototype traps cannot intercept the private outline channel", async ({
  page,
}) => {
  const artifact = `<!doctype html><html><head><style>
    body{max-width:700px;margin:40px auto;font-family:system-ui}main{position:static}
    </style></head><body><main><h1>Database migration plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p></main>
    <script>
      window.__outlinePortIntercepted = false;
      for (const name of ["addEventListener", "removeEventListener", "postMessage", "start", "close"]) {
        const original = MessagePort.prototype[name];
        MessagePort.prototype[name] = function (...args) {
          window.__outlinePortIntercepted = true;
          return original.apply(this, args);
        };
      }
    </script></body></html>`;
  await openOutlineProbeArtifact(page, artifact);
  await expect.poll(() => outlineProbeSnapshotCount(page)).toBeGreaterThan(0);
  expect(
    await surfaceOf(page)
      .locator("body")
      .evaluate(
        () =>
          (window as unknown as { __outlinePortIntercepted?: boolean }).__outlinePortIntercepted ??
          null,
      ),
  ).toBe(false);
});

test("shadow-root paint permanently disables pinned proof", async ({ page }) => {
  const artifact = `<!doctype html><html><head><style>
    body{max-width:700px;margin:40px auto;font-family:system-ui}main{position:static}
    </style></head><body><main><h1>Database migration plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p>
    <span id="shadow-host"></span></main><script>
      const host = document.querySelector("#shadow-host");
      const root = host.attachShadow({ mode: "closed" });
      const hazard = document.createElement("aside");
      hazard.id = "shadow-paint-hazard";
      hazard.setAttribute("style", "position:fixed;right:20px;top:120px;width:180px;height:120px;background:red");
      root.append(hazard);
    </script></body></html>`;
  await openOutlineProbeArtifact(page, artifact);
  await expect
    .poll(
      async () =>
        ((await latestOutlineProbeSnapshot(page))?.proof as Record<string, unknown> | undefined)
          ?.reason,
    )
    .toBe("untrusted-style-realm");
});

test("runtime declarative shadow DOM permanently disables pinned proof", async ({ page }) => {
  const artifact = `<!doctype html><html><head><style>
    body{max-width:700px;margin:40px auto;font-family:system-ui}main{position:static}
    </style></head><body><main><h1>Database migration plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p></main></body></html>`;
  await openOutlineProbeArtifact(page, artifact);
  await expect
    .poll(
      async () =>
        ((await latestOutlineProbeSnapshot(page))?.proof as Record<string, unknown> | undefined)
          ?.complete ?? false,
    )
    .toBe(true);

  await surfaceOf(page)
    .locator("body")
    .evaluate((body) => {
      const unsafeDocument = Document as typeof Document & {
        parseHTMLUnsafe(markup: string): Document;
      };
      const parsed = unsafeDocument.parseHTMLUnsafe(
        '<span id="runtime-shadow-host"><template shadowrootmode="closed"><aside style="position:fixed;right:20px;top:120px;width:180px;height:120px;background:red"></aside></template></span>',
      );
      const host = parsed.querySelector("#runtime-shadow-host");
      if (!host) throw new Error("runtime shadow host missing");
      body.append(document.adoptNode(host));
    });
  await expect
    .poll(
      async () =>
        ((await latestOutlineProbeSnapshot(page))?.proof as Record<string, unknown> | undefined)
          ?.reason,
    )
    .toBe("untrusted-style-realm");
});

const openOwnedOverlayMutationProbe = async (
  page: Page,
): Promise<() => Promise<Record<string, unknown> | null>> => {
  const artifact = `<!doctype html><html><head><style>
    body{max-width:700px;margin:40px auto;font-family:system-ui}main{position:static}
    </style></head><body><main><h1>Database migration plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p></main></body></html>`;
  await openOutlineProbeArtifact(page, artifact);
  await expect
    .poll(
      async () =>
        ((await latestOutlineProbeSnapshot(page))?.proof as Record<string, unknown> | undefined)
          ?.complete ?? false,
    )
    .toBe(true);
  return () => latestOutlineProbeSnapshot(page);
};

test("artifact children cannot enter the exact owned overlay root", async ({ page }) => {
  const artifact = `<!doctype html><html><head><style>
    body{max-width:700px;margin:40px auto;font-family:system-ui}main{position:static}
    </style></head><body><main><h1>Database migration plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p></main></body></html>`;
  await openOutlineProbeArtifact(page, artifact);
  await expect
    .poll(
      async () =>
        ((await latestOutlineProbeSnapshot(page))?.proof as Record<string, unknown> | undefined)
          ?.complete ?? false,
    )
    .toBe(true);

  await surfaceOf(page)
    .locator("#__lucid_overlay_root")
    .evaluate((root) => {
      const hazard = document.createElement("aside");
      hazard.setAttribute(
        "style",
        "position:fixed;right:20px;top:120px;width:180px;height:120px;background:red",
      );
      root.append(hazard);
    });
  await expect
    .poll(
      async () =>
        ((await latestOutlineProbeSnapshot(page))?.proof as Record<string, unknown> | undefined)
          ?.reason,
    )
    .toBe("untrusted-style-realm");
});

test("artifact mutations inside the owned overlay shadow tree disable pinned proof", async ({
  page,
}) => {
  const artifact = `<!doctype html><html><head><style>
    body{max-width:700px;margin:40px auto;font-family:system-ui}main{position:static}
    </style></head><body><main><h1>Database migration plan</h1><h2>One</h2><p>A</p><h2>Two</h2><p>B</p></main></body></html>`;
  await openOutlineProbeArtifact(page, artifact);
  await expect
    .poll(
      async () =>
        ((await latestOutlineProbeSnapshot(page))?.proof as Record<string, unknown> | undefined)
          ?.complete ?? false,
    )
    .toBe(true);

  await surfaceOf(page)
    .locator("#__lucid_overlay_root")
    .evaluate((root) => {
      const overlay = root.firstElementChild as (Element & { performUpdate?: () => void }) | null;
      const shadowRoot = overlay?.shadowRoot;
      if (!shadowRoot) throw new Error("owned overlay shadow root missing");
      const hazard = document.createElement("aside");
      hazard.setAttribute(
        "style",
        "position:fixed;right:20px;top:120px;width:180px;height:120px;background:red",
      );
      shadowRoot.append(hazard);
      overlay.performUpdate?.();
    });
  await expect
    .poll(
      async () =>
        ((await latestOutlineProbeSnapshot(page))?.proof as Record<string, unknown> | undefined)
          ?.reason,
    )
    .toBe("untrusted-style-realm");
});

test("artifact declaration mutations inside the owned overlay stylesheet disable proof", async ({
  page,
}) => {
  const latest = await openOwnedOverlayMutationProbe(page);
  await surfaceOf(page)
    .locator("#__lucid_overlay_root")
    .evaluate((root) => {
      const sheet = root.firstElementChild?.shadowRoot?.adoptedStyleSheets[0];
      const rule = Array.from(sheet?.cssRules ?? []).find(
        (candidate): candidate is CSSStyleRule =>
          candidate instanceof CSSStyleRule && candidate.selectorText === ".section-emphasis",
      );
      if (!rule) throw new Error("owned section-emphasis rule missing");
      rule.style.setProperty("inset", "0", "important");
    });
  await expect
    .poll(async () => ((await latest())?.proof as Record<string, unknown> | undefined)?.reason)
    .toBe("untrusted-style-realm");
});

test("artifact style-map mutations inside the owned overlay stylesheet disable proof", async ({
  page,
}) => {
  const latest = await openOwnedOverlayMutationProbe(page);
  await surfaceOf(page)
    .locator("#__lucid_overlay_root")
    .evaluate((root) => {
      const sheet = root.firstElementChild?.shadowRoot?.adoptedStyleSheets[0];
      const rule = Array.from(sheet?.cssRules ?? []).find(
        (candidate): candidate is CSSStyleRule =>
          candidate instanceof CSSStyleRule && candidate.selectorText === ".section-emphasis",
      );
      if (!rule) throw new Error("owned section-emphasis rule missing");
      rule.styleMap.set("background-color", "red");
    });
  await expect
    .poll(async () => ((await latest())?.proof as Record<string, unknown> | undefined)?.reason)
    .toBe("untrusted-style-realm");
});

test("artifact lifecycle hooks cannot mutate the owned shadow tree during update", async ({
  page,
}) => {
  const latest = await openOwnedOverlayMutationProbe(page);
  await surfaceOf(page)
    .locator("#__lucid_overlay_root")
    .evaluate((root) => {
      const overlay = root.firstElementChild as (Element & { requestUpdate?: () => void }) | null;
      if (!overlay) throw new Error("owned overlay missing");
      const prototype = Object.getPrototypeOf(overlay) as { updated?: () => void };
      prototype.updated = function updated() {
        const shadowRoot = (this as Element).shadowRoot;
        if (!shadowRoot) return;
        const style = document.createElement("style");
        style.textContent =
          "@keyframes hostile-owned-motion{from{transform:translateX(0)}to{transform:translateX(-900px)}}#hostile-owned-motion{position:fixed;right:0;top:120px;width:180px;height:120px;background:red;animation:hostile-owned-motion 2s linear infinite}";
        const hazard = document.createElement("aside");
        hazard.id = "hostile-owned-motion";
        shadowRoot.append(style, hazard);
      };
      overlay.requestUpdate?.();
    });
  await expect
    .poll(async () => ((await latest())?.proof as Record<string, unknown> | undefined)?.reason)
    .toBe("untrusted-style-realm");
  await expect(
    surfaceOf(page).locator("#__lucid_overlay_root").locator("#hostile-owned-motion"),
  ).toHaveCount(0);
});

test("artifact base-update replacement cannot enter the trusted shadow window", async ({
  page,
}) => {
  const latest = await openOwnedOverlayMutationProbe(page);
  await surfaceOf(page)
    .locator("#__lucid_overlay_root")
    .evaluate((root) => {
      const overlay = root.firstElementChild as (Element & { requestUpdate?: () => void }) | null;
      if (!overlay) throw new Error("owned overlay missing");
      const lucidPrototype = Object.getPrototypeOf(overlay);
      const litPrototype = Object.getPrototypeOf(lucidPrototype) as {
        performUpdate?: (this: Element) => void;
      };
      litPrototype.performUpdate = function performUpdate() {
        const shadowRoot = this.shadowRoot;
        if (!shadowRoot) return;
        const hazard = document.createElement("aside");
        hazard.id = "hostile-base-update";
        hazard.setAttribute(
          "style",
          "position:fixed;right:0;top:120px;width:180px;height:120px;background:red",
        );
        shadowRoot.append(hazard);
      };
      overlay.requestUpdate?.();
    });
  await expect
    .poll(async () => ((await latest())?.proof as Record<string, unknown> | undefined)?.reason)
    .toBe("untrusted-style-realm");
  await expect(
    surfaceOf(page).locator("#__lucid_overlay_root").locator("#hostile-base-update"),
  ).toHaveCount(0);
});

test("artifact proxy render inputs execute only while shadow observation is active", async ({
  page,
}) => {
  const latest = await openOwnedOverlayMutationProbe(page);
  await surfaceOf(page)
    .locator("#__lucid_overlay_root")
    .evaluate((root) => {
      const overlay = root.firstElementChild as
        | (Element & { markers?: unknown; requestUpdate?: () => void })
        | null;
      const shadowRoot = overlay?.shadowRoot;
      if (!overlay || !shadowRoot) throw new Error("owned overlay missing");
      let injected = false;
      overlay.markers = new Proxy([], {
        get(target, property, receiver) {
          if (property === "length" && !injected) {
            injected = true;
            const style = document.createElement("style");
            style.textContent =
              "@keyframes hostile-proxy-motion{from{transform:translateX(0)}to{transform:translateX(-900px)}}#hostile-proxy-motion{position:fixed;right:0;top:120px;width:180px;height:120px;background:red;animation:hostile-proxy-motion 2s linear infinite}";
            const hazard = document.createElement("aside");
            hazard.id = "hostile-proxy-motion";
            shadowRoot.append(style, hazard);
          }
          return Reflect.get(target, property, receiver);
        },
      });
      overlay.requestUpdate?.();
    });
  await expect
    .poll(async () => ((await latest())?.proof as Record<string, unknown> | undefined)?.reason)
    .toBe("untrusted-style-realm");
});

test("artifact cannot replace Lit render inputs used during the trusted shadow update", async ({
  page,
}) => {
  const latest = await openOwnedOverlayMutationProbe(page);
  const pins = await surfaceOf(page)
    .locator("#__lucid_overlay_root")
    .evaluate(async (root) => {
      const overlay = root.firstElementChild as
        | (Element & {
            renderOptions?: unknown;
            renderRoot?: unknown;
            markers?: unknown;
            requestUpdate?: () => void;
            updateComplete?: Promise<unknown>;
          })
        | null;
      const shadowRoot = overlay?.shadowRoot;
      if (!overlay || !shadowRoot) throw new Error("owned overlay missing");
      let proxyHits = 0;
      const inject = (): void => {
        proxyHits += 1;
        const hazard = document.createElement("aside");
        hazard.id = "hostile-lit-render-input";
        hazard.setAttribute(
          "style",
          "position:fixed;right:0;top:120px;width:180px;height:120px;background:red",
        );
        shadowRoot.append(hazard);
      };
      const hostileOptions = new Proxy(
        { renderBefore: null },
        {
          get(target, property, receiver) {
            if (property === "renderBefore") inject();
            return Reflect.get(target, property, receiver);
          },
        },
      );
      try {
        Object.defineProperty(overlay, "renderOptions", { value: hostileOptions });
      } catch {
        // The bootstrap pins this property before artifact code can reach it.
      }
      try {
        Object.defineProperty(overlay, "renderRoot", {
          get() {
            inject();
            return shadowRoot;
          },
        });
      } catch {
        // The exact owned shadow root is pinned by the same boundary.
      }
      overlay.requestUpdate?.();
      await overlay.updateComplete;
      overlay.markers = [
        {
          id: "normal-second-render",
          index: 1,
          rects: [{ height: 20, left: 20, top: 20, width: 120 }],
          stackIndex: 0,
          state: "committed",
        },
      ];
      await overlay.updateComplete;
      const optionsDescriptor = Object.getOwnPropertyDescriptor(overlay, "renderOptions");
      const rootDescriptor = Object.getOwnPropertyDescriptor(overlay, "renderRoot");
      const productionFields = ["_$AL", "_$Do", "_$ES", "_$Em", "_$Ep", "_$Eq", "_$EO"];
      return {
        markerCount: shadowRoot.querySelectorAll(".marker").length,
        optionsFrozen: Object.isFrozen(overlay.renderOptions),
        optionsPinned: optionsDescriptor?.configurable === false,
        productionFieldsPinned: productionFields.every((field) => {
          const fieldDescriptor = Object.getOwnPropertyDescriptor(overlay, field);
          return fieldDescriptor?.configurable === false && "value" in fieldDescriptor;
        }),
        proxyHits,
        rootPinned: rootDescriptor?.configurable === false && rootDescriptor.value === shadowRoot,
      };
    });
  expect(pins).toEqual({
    markerCount: 1,
    optionsFrozen: true,
    optionsPinned: true,
    productionFieldsPinned: true,
    proxyHits: 0,
    rootPinned: true,
  });
  await expect(
    surfaceOf(page).locator("#__lucid_overlay_root").locator("#hostile-lit-render-input"),
  ).toHaveCount(0);
  await expect
    .poll(
      async () =>
        ((await latest())?.proof as Record<string, unknown> | undefined)?.complete ?? false,
    )
    .toBe(true);
});

test("a newly added section already in view pulses instead of offering a jump", async ({
  page,
}) => {
  const before = PLAN_V1.replace(
    '    <ol id="steps">',
    '    <section id="update-slot"></section>\n    <ol id="steps">',
  );
  const after = before.replace(
    '    <section id="update-slot"></section>',
    '    <section id="update-slot" data-lucid-id="new-summary"><h2>New summary</h2><p>The added answer is here.</p></section>',
  );
  await openViewer(page, before);
  const surface = surfaceOf(page);

  await cli.write(after);
  const target = surface.locator('[data-lucid-id="new-summary"]');
  await expect(target).toBeInViewport();
  await cli.run([
    "wait",
    cli.artifact,
    "--reply",
    "Added [the new summary](lucid:section/new-summary).",
    "--timeout",
    waitTimeoutSeconds(1),
  ]);

  await expect(surface.locator(".section-emphasis")).toHaveCount(1);
  await expect(on(page).sectionLink()).toHaveCount(0);
  await expect(page.locator('[data-role="agent"]')).toContainText("the new summary");
});

test("a newly added section off screen remains a jump target in chat", async ({ page }) => {
  const spacer = '<div style="height: 2200px">Keep reading</div>';
  const before = PLAN_V1.replace("  </article>", `    ${spacer}\n  </article>`);
  const after = before.replace(
    "  </article>",
    '    <section data-lucid-id="new-appendix"><h2>New appendix</h2><p>The added answer is down here.</p></section>\n  </article>',
  );
  await openViewer(page, before);
  const surface = surfaceOf(page);

  await cli.write(after);
  const target = surface.locator('[data-lucid-id="new-appendix"]');
  await expect(target).not.toBeInViewport();
  await cli.run([
    "wait",
    cli.artifact,
    "--reply",
    "Added [the new appendix](lucid:section/new-appendix).",
    "--timeout",
    waitTimeoutSeconds(1),
  ]);

  const chip = on(page).sectionLink();
  await expect(chip).toHaveText("the new appendix");
  await expect(surface.locator(".section-emphasis")).toHaveCount(0);
  await chip.click();
  await expect(target).toBeInViewport();
  await expect(surface.locator(".section-emphasis")).toHaveCount(1);
});

test("a blocked agent says so where the human is looking", async ({ page }) => {
  await openViewer(page);
  await on(page).messageInput().fill("Research the source and add a section.");
  await on(page).sendMessage().click();
  await expect(page.locator('[data-role="human"]')).toContainText("Research the source");

  // The turn takes delivery, declares it will revise, then hits a wall it
  // cannot clear on its own - the exact shape of a headless agent asking for a
  // permission in a terminal nobody is reading.
  await cli.run(["intent", cli.artifact, "revise"]);
  await expect(on(page).surfaceUpdating()).toBeVisible();
  await cli.run(["blocked", cli.artifact, "--reason", "needs the WebFetch permission"]);

  const blocked = on(page).agentBlocked();
  await expect(blocked).toContainText("blocked and needs you");
  await expect(blocked).toContainText("needs the WebFetch permission");
  // The document stops promising an update it is not going to get.
  await expect(on(page).surfaceUpdating()).toHaveCount(0);

  // Answering the block is the agent moving again; nothing else clears it.
  await cli.run(["progress", cli.artifact, "--label", "reading the source"]);
  await expect(on(page).agentBlocked()).toHaveCount(0);
  await expect(on(page).workingPhase()).toContainText("reading the source");
});
