import * as React from "react";

/** shadcn textarea pattern with one initial row and content-sized height. */
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className = "", onInput, ...props }, ref) {
  return (
    <textarea
      {...props}
      ref={ref}
      rows={1}
      data-slot="textarea"
      className={`block w-full min-w-0 resize-none rounded-md border border-[var(--color-divider)] bg-[var(--paper)] px-3 py-2 text-base text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-50 ${className}`}
      style={{ fieldSizing: "content", ...props.style }}
      onInput={(event) => {
        event.currentTarget.style.height = "auto";
        event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
        onInput?.(event);
      }}
    />
  );
});
