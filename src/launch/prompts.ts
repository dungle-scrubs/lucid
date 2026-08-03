import { type Anchor, anchorText } from "../anchors/anchor.ts";
import { shellArg } from "../core/escape.ts";
import type { PayloadImage, WaitPayload } from "../core/payload.ts";

/**
 * The agent-facing prompt builders: the whole instruction a driven turn ever
 * reads. Lucid drives three kinds of turn - author a forked artifact, author
 * one the human asked the hub for, and revise one under review - and their
 * prompts share a protocol no other channel can carry, because a headless turn
 * never reads the skill.
 *
 * The clauses below are that shared protocol, factored so a turn spawned by
 * the fork launcher and a turn spawned by the hub cannot be told different
 * things. Every value reaches the harness as argv - nothing here is ever shell
 * -interpolated - but the command lines INSIDE a prompt are pasted into the
 * agent's own shell, which is why each one is quoted with `shellArg`: a path
 * with a space otherwise splits into two arguments and the command targets a
 * file that does not exist.
 */

/**
 * The narration line every driven turn carries. Only the turn knows WHICH
 * phase it is in, and a long headless turn is otherwise a several-minute
 * spinner with nothing to read. Each report also refreshes the working window,
 * so a long narrated turn cannot go stale mid-edit. It works before `lucid
 * open` too - the CLI appends straight to the log when no server answers, and
 * the hub's heartbeat reads the newest label from there.
 */
const progressNarration = (artifact: string, examples: readonly string[]): string =>
  `As you work, report each phase as you enter it: \`lucid progress ${shellArg(artifact)} --label "<what you are doing, in a few words>"\` - for example ${examples.map((e) => `"${e}"`).join(", ")}. The human watches these one-liners while they wait.`;

/** How an authoring turn ends: the artifact exists, and a human is looking at
 *  it. A turn that writes the file and stops leaves nothing to review. */
const openForReview = (artifact: string): readonly string[] => [
  "Then open it for review by running:",
  `  lucid open ${shellArg(artifact)}`,
];

/** The blast radius of an authoring turn. Unquoted on purpose - this one is
 *  prose about a path, not a command line the agent runs. */
const writeOnly = (artifact: string): string =>
  `Write only ${artifact}; do not modify other files.`;

/** The fork create instruction: the seed says what to author, this says where
 *  to put it and what to do with it afterwards. */
export const createPrompt = (seedPath: string, artifact: string): string =>
  [
    "You are picking up a spun-off task from a Lucid review.",
    `Read the fork seed at ${seedPath}.`,
    `Author the artifact it describes as a single self-contained HTML file written to exactly ${artifact}.`,
    ...openForReview(artifact),
    writeOnly(artifact),
  ].join("\n");

/** The create-from-nothing instruction (D3/D16): author the artifact, then put
 *  it in front of the human. The human's request rides as data, and every value
 *  reaches the harness as argv - nothing is ever shell-interpolated. The one
 *  command line inside the prompt is quoted for the shell the AGENT will run it
 *  in, which is the only shell in this path. */
export const createArtifactPrompt = (artifact: string, request: string, title?: string): string =>
  [
    "You are authoring a new Lucid artifact for human review.",
    `Write a single self-contained HTML document to exactly ${artifact}.`,
    // The human named the document; the shell shows that name on its tab by
    // reading the artifact's own <title>, so the agent must not retitle it.
    ...(title
      ? [`Its <title> must be exactly: ${title}`, "Use that as the document's heading too."]
      : []),
    "It must answer this request from the human:",
    request,
    // The one flow Lucid itself commissions a document in, so it says the
    // house rules outright rather than trusting the skill to trigger: an
    // artifact is read as paper, and a SCREEN is reviewed as a wireframe
    // (labelled regions, hatched placeholders) until someone asks for a
    // finished design.
    "Follow the lucid-design skill if it is available. Otherwise: a warm cream",
    "ground with near-black type, one accent, and no external requests. Every",
    "picture - diagram, flow, chart, timeline, screen - is built from real",
    "elements or inline SVG, never ASCII or box-drawing characters, so a",
    "reviewer can annotate one part of it. A mockup of a screen is a WIREFRAME",
    "(labelled regions, hatched placeholders carrying their spec), not finished",
    "visual design, unless the request asks for a specific design.",
    // Prose is half of what gets marked up, so the writing bar is stated here
    // beside the visual one rather than left to the skill. Orwell's rules,
    // compressed: a reviewer pays attention for every word before the claim.
    "Write to Orwell's six rules: no figure of speech you are used to seeing in",
    "print; no long word where a short one will do; cut every word that can go;",
    "active voice over passive; an everyday English word over a jargon or",
    "foreign one; and break any of these sooner than write something barbarous.",
    progressNarration(artifact, [
      "planning the sections",
      "writing the comparison table",
      "final read-through",
    ]),
    ...openForReview(artifact),
    writeOnly(artifact),
  ].join("\n");

/** The revise instruction for a feedback batch, or null when the batch carries
 *  nothing to act on (e.g. only an approval) - so no caller ever drives an
 *  empty resume turn. Mirrors the signals `runWait` counts as feedback. Shared
 *  with the hub's attend engine: one wording for every headless revise Lucid
 *  drives, launcher or hub. */
export const revisePrompt = (payload: WaitPayload, artifact: string): string | null => {
  const lines: string[] = [];
  // Attachments ride as absolute paths the agent can read. A screenshot with
  // no words is a whole piece of feedback; dropping it turned an image-only
  // item into an empty bullet, or into "nothing to act on".
  const withImages = (text: string, images?: readonly PayloadImage[]): string =>
    images && images.length > 0
      ? `${text}${text ? " " : ""}(images: ${images.map((i) => i.path).join(", ")})`
      : text;
  // One clipped location per anchor. A multi-target annotation lists every
  // spot its note covers; dropping the tail would apply the note to only the
  // first of the places the human pointed at.
  const clip = (t: Anchor): string => anchorText(t, { maxChars: 100 });
  for (const a of payload.annotations) {
    const where = (a.targets ?? [a.target]).map(clip).join("; ");
    lines.push(`- ${withImages(a.note, a.images)} (at: ${where})`);
  }
  for (const m of payload.messages) {
    if (m.role !== "human") continue;
    const text = withImages(m.text, m.images);
    if (text) lines.push(`- ${text}`);
  }
  for (const r of payload.reverts ?? []) lines.push(`- revert to v${r.targetVersion}: ${r.why}`);
  for (const q of payload.questions ?? []) {
    if (!q.answered || q.skipped) continue;
    // A re-ask is an instruction, not an answer: the human did not understand.
    // Reading it as an answer delivered their confusion note AS the decision,
    // and a bare one (no note) made the whole turn look non-actionable.
    if (q.unclear) {
      const note = q.answer ? ` They said: "${q.answer}".` : "";
      lines.push(
        `- the question "${q.text}" was UNCLEAR to the human.${note} Ask it again with lucid ask - the same question, shorter and plainer. Do not treat this as an answer.`,
      );
      continue;
    }
    // Chosen options ARE the answer when the human picked rather than typed;
    // reading only the free text silently dropped the whole reply.
    const answer = [...(q.answerOptions ?? []), ...(q.answer ? [q.answer] : [])].join("; ");
    // Pinned regions are part of the answer too - a pin says WHERE the words
    // apply, and a pin alone is a whole answer (pointing instead of typing).
    const pins = q.answerAnchors ?? (q.answerAnchor ? [q.answerAnchor] : []);
    const pinned = pins.length > 0 ? `(pinned: ${pins.map(clip).join("; ")})` : "";
    const said = withImages(answer, q.answerImages);
    if (said || pinned) {
      lines.push(`- answer to "${q.text}": ${[said, pinned].filter(Boolean).join(" ")}`);
    }
  }
  if (lines.length === 0) return null;
  return [
    `Review feedback arrived on ${artifact}. Apply it and save the file (the viewer live-reloads):`,
    ...lines,
    `Edit only ${artifact}.`,
    // The turn is the ONLY party that can know whether this feedback produces
    // an edit or an answer - whoever spawned it delivered the feedback without
    // reading it. This prompt is the whole instruction a driven turn gets, so
    // the skill's version of this line cannot reach it: without this the
    // viewer can never say "Updating the artifact…" truthfully, and says only
    // "Agent responding…" for every turn.
    `First, declare which is coming: \`lucid intent ${shellArg(artifact)} revise\` if you are going to change the file, or \`lucid intent ${shellArg(artifact)} reply\` if you are only answering. Then do the work.`,
    progressNarration(artifact, [
      "reading the feedback",
      "rewriting the capabilities table",
      "verifying the result",
    ]),
  ].join("\n");
};
