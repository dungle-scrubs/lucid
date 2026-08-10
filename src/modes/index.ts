/**
 * Owns the integration modes that map normalizer HarnessEvents into protocol
 * frames: headless-turn and headless-session batch modes, plus the interactive
 * adapters spanning the claude-hooks, cooperative, and observe-only rungs. It
 * only translates and delivers events and is NOT responsible for any protocol
 * decisions; those remain the sole domain of the hosted reducer.
 */
export {};
