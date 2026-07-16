import React from "react";
import { Pill } from "./Pill.jsx";

/* TopBar - the editor top bar.
   Wordmark/title on the left (serif italic, the Lucid brand voice + the brass mark),
   a version pill, and quiet ghost controls on the right.
   Rule 5: no shadow; a hairline bottom border separates it from the chrome below.
   All values reference tokens via var(--…). */

export const styles = {
  bar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-3)",
    height: "52px",
    padding: "0 var(--space-4)",
    background: "var(--bg-raised)",
    borderBottom: "1px solid var(--border)",
    flex: "0 0 auto",
  },
  brand: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2)",
    minWidth: 0,
  },
  /* the compact brass annotation mark, matching assets/lucid-mark.svg */
  mark: {
    width: "22px",
    height: "22px",
    flex: "0 0 auto",
    display: "block",
    color: "var(--accent)",
  },
  wordmark: {
    fontFamily: "var(--font-serif)",
    fontStyle: "italic",
    fontWeight: "var(--weight-medium)",
    fontSize: "var(--text-lg)",
    lineHeight: 1,
    letterSpacing: "var(--tracking-tight)",
    color: "var(--fg-strong)",
  },
  title: {
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    color: "var(--fg-muted)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    borderLeft: "1px solid var(--border)",
    paddingLeft: "var(--space-3)",
    marginLeft: "var(--space-1)",
  },
  controls: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-1)",
    flex: "0 0 auto",
  },
  control: {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2)",
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-1) var(--space-2)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    color: "var(--fg-muted)",
    cursor: "pointer",
    transition: "background var(--dur-base) var(--ease), color var(--dur-base) var(--ease)",
  },
};

/* Lucide-style inline mark: a surface holding one element in a brass bracket.
   stroke 1.5, stroke=currentColor, no fills. */
function BrandMark() {
  return (
    <svg
      style={styles.mark}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="3" stroke="var(--border-strong)" />
      <line x1="7" y1="8.5" x2="14" y2="8.5" stroke="var(--fg-faint)" />
      <line x1="7" y1="15.5" x2="12" y2="15.5" stroke="var(--fg-faint)" />
      <rect x="5.5" y="11" width="13" height="3.4" rx="1.2" stroke="var(--accent)" />
      <circle cx="5.5" cy="12.7" r="1.1" fill="var(--accent)" stroke="var(--accent)" />
    </svg>
  );
}

function QuietControl({ children, onClick }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...styles.control,
        ...(hover ? { background: "var(--bg-overlay)", color: "var(--fg)" } : null),
      }}
    >
      {children}
    </button>
  );
}

export function TopBar({ title = "Database migration plan", version = "v2" }) {
  return (
    <header style={styles.bar}>
      <div style={styles.brand}>
        <BrandMark />
        <span style={styles.wordmark}>Lucid</span>
        <span style={styles.title}>{title}</span>
      </div>
      <div style={styles.controls}>
        <Pill variant="version">{version}</Pill>
        <QuietControl>History</QuietControl>
        <QuietControl>Share</QuietControl>
      </div>
    </header>
  );
}

export default TopBar;
