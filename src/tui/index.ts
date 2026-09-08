/**
 * Owns the minimal terminal test surface rendered over the folded conversation
 * log: a conversation view, an input box, a state and rung indicator, and
 * per-item disposition marks. It is a deliberately thin observer for manual and
 * exploratory testing, NOT the review surface. Nothing review-shaped lives in
 * this directory. The view-model (buildView) is a pure projection of the
 * store's transcript (D-009: the view IS fold(log)); render/paint only paint it.
 */

export {
  type InputOptions,
  type InputResult,
  NotTTYError,
  runInputLoop,
  type SubmitMode,
} from "./input.js";
export { paint, renderLines } from "./render.js";
export {
  buildView,
  type ConversationLine,
  type TuiView,
} from "./view.js";
