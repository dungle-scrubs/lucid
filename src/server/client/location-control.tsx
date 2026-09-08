import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { SettingsPopover } from "./settings-popover.js";
import { Button } from "./ui/button.js";

export interface LocationState {
  readonly workingDirectory: string | null;
  readonly projectDirectory: string | null;
  readonly revision: number;
  readonly status: string;
}
export function LocationControl(props: {
  readonly location: LocationState;
  readonly onSave: (folder: string, revision: number) => Promise<string | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    defaultValues: { folder: props.location.workingDirectory ?? "" },
    onSubmit: async ({ value }) => {
      try {
        setError(await props.onSave(value.folder, props.location.revision));
      } catch {
        setError("Folder was not confirmed. Reload before trying again.");
      }
    },
  });
  return (
    <SettingsPopover
      label={
        props.location.status === "available"
          ? `Working folder: ${props.location.workingDirectory}`
          : "Choose a working folder before execution"
      }
    >
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="folder">
          {(field) => (
            <label>
              Working folder
              <input
                data-slot="input"
                required
                value={field.state.value}
                placeholder="/absolute/path/to/project"
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </label>
          )}
        </form.Field>
        {error ? (
          <p role="alert" className="settings-error">
            {error}
          </p>
        ) : null}
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(busy) => (
            <Button type="submit" variant="outline" disabled={busy}>
              Save folder
            </Button>
          )}
        </form.Subscribe>
      </form>
    </SettingsPopover>
  );
}
