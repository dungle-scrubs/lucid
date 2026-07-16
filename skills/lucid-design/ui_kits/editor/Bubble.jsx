import React from "react";

/* Bubble - a conversation message.
   Variant "agent" (sage = the machine) or "user" (amber = the human).
   Brass is NOT used here: in the log, color marks WHO is speaking, not attention.
   The attribution eyebrow is uppercase, tracked-out meta. No shadow (in-panel).
   All values reference tokens via var(--…). */

export const styles = {
  row: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-1)",
  },
  rowUser: {
    alignItems: "flex-end",
  },
  rowAgent: {
    alignItems: "flex-start",
  },
  eyebrow: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-xs)",
    fontWeight: "var(--weight-semibold)",
    textTransform: "uppercase",
    letterSpacing: "var(--tracking-caps)",
  },
  eyebrowAgent: { color: "var(--agent)" },
  eyebrowUser: { color: "var(--user)" },
  time: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    fontWeight: "var(--weight-regular)",
    letterSpacing: "var(--tracking-normal)",
    color: "var(--fg-faint)",
    textTransform: "none",
  },
  bubble: {
    maxWidth: "85%",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-normal)",
    color: "var(--fg)",
    padding: "var(--space-2) var(--space-3)",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border)",
    boxShadow: "var(--shadow-none)",
  },
  bubbleAgent: {
    background: "var(--agent-fill)",
    borderColor: "var(--border)",
    borderTopLeftRadius: "var(--radius-sm)",
  },
  bubbleUser: {
    background: "var(--user-fill)",
    borderColor: "var(--border)",
    borderTopRightRadius: "var(--radius-sm)",
  },
};

export function Bubble({ variant = "agent", author, time, children }) {
  const isUser = variant === "user";
  const label = author || (isUser ? "You" : "The agent");
  return (
    <div style={{ ...styles.row, ...(isUser ? styles.rowUser : styles.rowAgent) }}>
      <span
        style={{
          ...styles.eyebrow,
          ...(isUser ? styles.eyebrowUser : styles.eyebrowAgent),
        }}
      >
        {label}
        {time ? <span style={styles.time}>{time}</span> : null}
      </span>
      <div
        style={{
          ...styles.bubble,
          ...(isUser ? styles.bubbleUser : styles.bubbleAgent),
        }}
      >
        {children}
      </div>
    </div>
  );
}

export default Bubble;
