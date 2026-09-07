import type { ComponentProps } from "react";

interface ButtonProps extends ComponentProps<"button"> {
  readonly variant?: "default" | "outline" | "ghost";
}

// shadcn/ui Button (MIT), limited to the variants used by the hub.
// Native button only; class composition is local and no polymorphic slot is needed.
export function Button(props: ButtonProps) {
  const { className, type = "button", variant = "default", ...rest } = props;
  return (
    <button
      className={[
        "cursor-pointer inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap outline-none disabled:pointer-events-none disabled:opacity-50",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-slot="button"
      data-variant={variant}
      type={type}
      {...rest}
    />
  );
}
