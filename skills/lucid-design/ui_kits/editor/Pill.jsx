import React from "react";

/* Pill - small status/label chip. --radius-pill, sentence case, no emoji.
   Variants:
     located  - a placed annotation (brass attention mark + sage/agent meta).
     orphaned - anchor no longer attaches (rust).
     version  - a version tag like "v2" (mono, quiet).
     status   - neutral meta state (steel).
   All values reference tokens via var(--…). */

export const styles = {
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-1)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-xs)",
    fontWeight: "var(--weight-medium)",
    lineHeight: 1,
    letterSpacing: "var(--tracking-wide)",
    padding: "var(--space-1) var(--space-2)",
    borderRadius: "var(--radius-pill)",
    border: "1px solid transparent",
    whiteSpace: "nowrap",
  },

  located: {
    background: "var(--annot-fill)",
    color: "var(--accent-bright)",
    borderColor: "var(--brass-700)",
  },
  orphaned: {
    background: "var(--danger-fill)",
    color: "var(--danger)",
    borderColor: "var(--rust-500)",
  },
  version: {
    background: "var(--bg-inset)",
    color: "var(--fg-muted)",
    borderColor: "var(--border-strong)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    letterSpacing: "var(--tracking-normal)",
  },
  status: {
    background: "var(--bg-overlay)",
    color: "var(--fg-muted)",
    borderColor: "var(--border)",
    textTransform: "uppercase",
    letterSpacing: "var(--tracking-caps)",
    fontSize: "var(--text-xs)",
    fontWeight: "var(--weight-semibold)",
  },

  /* small brass dot used by the located variant */
  dot: {
    width: "5px",
    height: "5px",
    borderRadius: "var(--radius-pill)",
    background: "var(--annot-color)",
    flex: "0 0 auto",
  },
};

export function Pill({ variant = "status", children, withDot = false, style, ...rest }) {
  return (
    <span style={{ ...styles.base, ...styles[variant], ...style }} {...rest}>
      {withDot ? <span style={styles.dot} /> : null}
      {children}
    </span>
  );
}

export default Pill;
