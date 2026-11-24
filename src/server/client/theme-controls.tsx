import * as Popover from "@radix-ui/react-popover";
import * as React from "react";
import { type ArtifactTheme, preferredArtifactTheme } from "./artifact-theme.js";
import { getBrowserTheme } from "./browser-theme.js";
import { InfoDuotone, MoonDuotone, SunDuotone } from "./icons.js";
import { type Appearance, parseThemePreference } from "./theme.js";
import { Tooltip } from "./tooltip.js";
import { useTheme } from "./use-theme.js";

export function AppearanceSettings() {
  const state = useTheme();
  return (
    <div className="settings-form appearance-settings">
      <label>
        Appearance
        <select
          value={state.preference}
          onChange={(event) => getBrowserTheme().choose(parseThemePreference(event.target.value))}
        >
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="system">Follow system</option>
        </select>
      </label>
      {!state.persisted ? (
        <p role="status">Appearance applies here but could not be saved.</p>
      ) : null}
    </div>
  );
}

/** How the document on screen relates to the app's appearance, when the
 * toggle cannot change it. `null` for adaptive documents and for pages
 * with no document, where the toggle changes everything. */
export function documentThemeNote(
  policy: ArtifactTheme | null,
  appearance: Appearance,
  systemDark: boolean,
): { readonly help: string; readonly mismatch: string | null } | null {
  if (policy === null || policy === "adaptive") return null;
  if (policy === "unmanaged") {
    const page: Appearance = systemDark ? "dark" : "light";
    return {
      help: "This document does not declare light and dark versions, so it follows your system setting. The light and dark toggle changes Lucid around it, not the document.",
      mismatch: page === appearance ? null : `Page follows system (${page})`,
    };
  }
  return {
    help: `This document has a fixed ${policy} theme. The light and dark toggle changes Lucid around it, not the document.`,
    mismatch: policy === appearance ? null : `Page is ${policy} only`,
  };
}

const useSystemDark = (): boolean =>
  React.useSyncExternalStore(
    (listener) => {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => false,
  );

export function ThemeControls(props: { readonly documentBytes?: string | null }) {
  const state = useTheme();
  const systemDark = useSystemDark();
  const dark = state.appearance === "dark";
  const action = dark ? "Switch to light mode" : "Switch to dark mode";
  const following = state.preference === "system" ? " · Following system" : "";
  const bytes = props.documentBytes ?? null;
  const policy = React.useMemo(
    () => (bytes === null ? null : preferredArtifactTheme(bytes)),
    [bytes],
  );
  const note = documentThemeNote(policy, state.appearance, systemDark);
  const button = (
    <button
      type="button"
      className="theme-toggle"
      aria-label={note ? `${action}. ${note.help}` : action}
      title={note ? undefined : `${action}${following}`}
      onClick={() => getBrowserTheme().choose(dark ? "light" : "dark")}
    >
      {dark ? <SunDuotone size={16} /> : <MoonDuotone size={16} />}
    </button>
  );
  if (!note) return <div className="theme-controls">{button}</div>;
  return (
    <div className="theme-controls">
      {note.mismatch ? (
        // A button, not hover help, so the reason also reaches touch screens,
        // where tooltips never open. Small screens keep only its icon.
        <Popover.Root>
          <Popover.Trigger
            className="theme-document-note"
            aria-label={`${note.mismatch}. Why the toggle leaves this document unchanged`}
          >
            <InfoDuotone size={14} />
            <span className="theme-document-note-label">{note.mismatch}</span>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              className="settings-popover theme-document-popover"
              side="bottom"
              align="end"
              sideOffset={8}
              collisionPadding={16}
            >
              <Popover.Title className="sr-only">
                Why the toggle leaves this document unchanged
              </Popover.Title>
              <p>{note.help}</p>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
      <Tooltip.Provider delayDuration={250}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>{button}</Tooltip.Trigger>
          <Tooltip.Content className="theme-document-help" align="end">
            <p>
              {action}
              {following}.
            </p>
            <p>{note.help}</p>
          </Tooltip.Content>
        </Tooltip.Root>
      </Tooltip.Provider>
    </div>
  );
}
