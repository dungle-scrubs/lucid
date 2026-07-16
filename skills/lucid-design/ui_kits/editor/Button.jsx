import React from "react";

/* Button - Lucid chrome control.
   Variants: primary (brass), secondary, ghost, danger (rust). Supports disabled.
   Rule 5: buttons NEVER carry a shadow. They lean on a border + background step.
   Every value references a token from colors_and_type.css via var(--…). */

export const styles = {
  base: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--space-2)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    fontWeight: "var(--weight-medium)",
    lineHeight: "var(--leading-snug)",
    letterSpacing: "var(--tracking-normal)",
    padding: "var(--space-2) var(--space-4)",
    borderRadius: "var(--radius-md)",
    border: "1px solid transparent",
    cursor: "pointer",
    userSelect: "none",
    boxShadow: "var(--shadow-none)",
    transition:
      "background var(--dur-base) var(--ease), border-color var(--dur-base) var(--ease), color var(--dur-base) var(--ease)",
  },

  primary: {
    background: "var(--accent)",
    color: "var(--on-accent)",
    borderColor: "var(--accent)",
  },
  primaryHover: {
    background: "var(--accent-bright)",
    borderColor: "var(--accent-bright)",
  },

  secondary: {
    background: "var(--bg-overlay)",
    color: "var(--fg)",
    borderColor: "var(--border-strong)",
  },
  secondaryHover: {
    background: "var(--bg-raised)",
    borderColor: "var(--border-strong)",
  },

  ghost: {
    background: "transparent",
    color: "var(--fg-muted)",
    borderColor: "transparent",
  },
  ghostHover: {
    background: "var(--bg-overlay)",
    color: "var(--fg)",
  },

  danger: {
    background: "transparent",
    color: "var(--danger)",
    borderColor: "var(--border-strong)",
  },
  dangerHover: {
    background: "var(--danger-fill)",
    borderColor: "var(--danger)",
  },

  good: {
    background: "var(--agent-fill)",
    color: "var(--agent)",
    borderColor: "var(--border-strong)",
  },
  goodHover: {
    background: "var(--agent-fill)",
    borderColor: "var(--agent)",
  },

  disabled: {
    background: "transparent",
    color: "var(--fg-faint)",
    borderColor: "var(--border)",
    cursor: "not-allowed",
  },
};

export function Button({
  variant = "secondary",
  disabled = false,
  children,
  onClick,
  type = "button",
  style,
  ...rest
}) {
  const [hover, setHover] = React.useState(false);

  const variantStyle = disabled
    ? styles.disabled
    : { ...styles[variant], ...(hover ? styles[`${variant}Hover`] : null) };

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...styles.base, ...variantStyle, ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}

export default Button;
