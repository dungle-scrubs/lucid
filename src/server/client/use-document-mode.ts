import * as React from "react";

/** Held modifiers are view state, shared with the sandboxed document. */
export function useDocumentMode() {
  const [held, setHeld] = React.useState(false);
  const [touchAnnotate, setTouchAnnotate] = React.useState(false);

  React.useEffect(() => {
    const update = (event: KeyboardEvent | MouseEvent): void => {
      if (!event.isTrusted) return;
      setHeld(event.altKey && !event.getModifierState("AltGraph"));
    };
    const reset = (): void => {
      // Focusing the iframe also blurs the outer window. The frame owns
      // modifier updates until focus comes back; this is not an app exit.
      if (document.activeElement instanceof HTMLIFrameElement && document.hasFocus()) return;
      setHeld(false);
    };
    const visibility = (): void => {
      if (document.hidden) setHeld(false);
    };
    window.addEventListener("keydown", update, true);
    window.addEventListener("keyup", update, true);
    window.addEventListener("mousemove", update, true);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", update, true);
      window.removeEventListener("keyup", update, true);
      window.removeEventListener("mousemove", update, true);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  return {
    held,
    mode: held || touchAnnotate ? ("annotate" as const) : ("edit" as const),
    setHeld,
    toggleTouch: (): void => setTouchAnnotate((current) => !current),
    touchAnnotate,
  };
}
