import React from "react";
import { Pill } from "./Pill.jsx";

/* AnnotationCard - a FLOATING card that points at a mark on the surface.
   This is the one in-product surface allowed a shadow (rule 5): it floats above
   the paper, so it carries --shadow-floating and --radius-lg.
   Anatomy: captured snippet (mono, the literal anchored text) → note (sans, the
   editorial remark) → attribution + small actions.
   All values reference tokens via var(--…). */

export const styles = {
  card: {
    position: "relative",
    width: "300px",
    background: "var(--bg-raised)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-floating)",
    padding: "var(--space-4)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-3)",
    fontFamily: "var(--font-sans)",
  },
  /* a small brass pointer connecting the card to its mark on the surface */
  beak: {
    position: "absolute",
    left: "-6px",
    top: "var(--space-5)",
    width: "10px",
    height: "10px",
    background: "var(--bg-raised)",
    borderLeft: "1px solid var(--border-strong)",
    borderBottom: "1px solid var(--border-strong)",
    transform: "rotate(45deg)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-2)",
  },
  cursor: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    color: "var(--fg-faint)",
    letterSpacing: "var(--tracking-normal)",
  },
  snippet: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-snug)",
    color: "var(--fg)",
    background: "var(--bg-inset)",
    border: "1px solid var(--border-inset)",
    borderLeft: "2px solid var(--annot-color)",
    borderRadius: "var(--radius-sm)",
    padding: "var(--space-2) var(--space-3)",
  },
  note: {
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-normal)",
    color: "var(--fg-strong)",
    margin: 0,
  },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-2)",
    paddingTop: "var(--space-1)",
    borderTop: "1px solid var(--border)",
  },
  attribution: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-xs)",
    color: "var(--fg-muted)",
  },
  who: {
    fontWeight: "var(--weight-semibold)",
    textTransform: "uppercase",
    letterSpacing: "var(--tracking-caps)",
  },
  whoUser: { color: "var(--user)" },
  whoAgent: { color: "var(--agent)" },
  actions: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-1)",
  },
  action: {
    background: "transparent",
    border: "none",
    borderRadius: "var(--radius-sm)",
    padding: "var(--space-1) var(--space-2)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-xs)",
    color: "var(--fg-muted)",
    cursor: "pointer",
    transition: "background var(--dur-base) var(--ease), color var(--dur-base) var(--ease)",
  },
  actionDanger: {
    color: "var(--danger)",
  },
};

function CardAction({ children, danger = false, onClick }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...styles.action,
        ...(danger ? styles.actionDanger : null),
        ...(hover
          ? {
              background: danger ? "var(--danger-fill)" : "var(--bg-overlay)",
              color: danger ? "var(--danger)" : "var(--fg)",
            }
          : null),
      }}
    >
      {children}
    </button>
  );
}

export function AnnotationCard({
  cursor = "evt_00042",
  snippet,
  note,
  who = "user",
  version = "v2",
  withBeak = true,
  onResolve,
  onDiscard,
  style,
}) {
  const isUser = who === "user";
  return (
    <article style={{ ...styles.card, ...style }}>
      {withBeak ? <span style={styles.beak} /> : null}
      <div style={styles.header}>
        <Pill variant="located" withDot>
          located · {version}
        </Pill>
        <span style={styles.cursor}>{cursor}</span>
      </div>
      {snippet ? <div style={styles.snippet}>{snippet}</div> : null}
      <p style={styles.note}>{note}</p>
      <div style={styles.footer}>
        <span style={styles.attribution}>
          <span style={{ ...styles.who, ...(isUser ? styles.whoUser : styles.whoAgent) }}>
            {isUser ? "You" : "The agent"}
          </span>
        </span>
        <span style={styles.actions}>
          <CardAction onClick={onResolve}>Resolve</CardAction>
          <CardAction danger onClick={onDiscard}>
            Discard
          </CardAction>
        </span>
      </div>
    </article>
  );
}

export default AnnotationCard;
