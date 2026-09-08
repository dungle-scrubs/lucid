import { useForm, useStore } from "@tanstack/react-form";
import { useId, useState } from "react";
import { PROFILES } from "../../protocol/driver-settings.js";
import type { DriverChoices } from "./driver-menus.js";
import { Button } from "./ui/button.js";

export interface SettingsValues {
  readonly harness: string;
  readonly model: string;
  readonly effort: string;
  readonly profile: string;
  readonly provider?: string;
}
export function SettingsForm(props: {
  readonly initial: SettingsValues;
  readonly choices: DriverChoices | null;
  readonly workingDirectory?: string;
  readonly onChooseFolder?: () => Promise<string | null>;
  readonly submitLabel: string;
  readonly onSave: (settings: SettingsValues, folder: string) => Promise<string | null>;
}) {
  const formId = useId();
  const [error, setError] = useState<string | null>(null);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const form = useForm({
    defaultValues: {
      ...props.initial,
      provider: props.initial.provider ?? "",
      workingDirectory: props.workingDirectory ?? "",
    },
    onSubmit: async ({ value }) => {
      setError(null);
      try {
        const { workingDirectory, provider, ...settings } = value;
        setError(
          await props.onSave({ ...settings, ...(provider ? { provider } : {}) }, workingDirectory),
        );
      } catch {
        setError("The response was lost. Retry with the same choices to check the result.");
      }
    },
  });
  const harness = useStore(form.store, (state) => state.values.harness);
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  const vocabulary = props.choices?.vocabulary[harness];
  return (
    <form
      className="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (choosingFolder) return;
        void form.handleSubmit();
      }}
    >
      {props.workingDirectory !== undefined ? (
        <form.Field name="workingDirectory">
          {(field) => (
            <fieldset className="settings-folder">
              <legend>
                Project folder <span className="folder-optional">(optional)</span>
              </legend>
              <div className="folder-choice">
                <span className={field.state.value ? "folder-path" : "folder-empty"} role="status">
                  {field.state.value || "No project folder"}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  disabled={choosingFolder || submitting || !props.onChooseFolder}
                  onClick={async () => {
                    if (!props.onChooseFolder) return;
                    setChoosingFolder(true);
                    setError(null);
                    try {
                      const folder = await props.onChooseFolder();
                      if (folder !== null) field.handleChange(folder);
                    } catch (cause) {
                      setError(
                        cause instanceof Error ? cause.message : "Cannot open the folder picker.",
                      );
                    } finally {
                      setChoosingFolder(false);
                    }
                  }}
                >
                  {choosingFolder ? "Choosing…" : field.state.value ? "Change" : "Choose folder"}
                </Button>
                {field.state.value ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={choosingFolder || submitting}
                    onClick={() => field.handleChange("")}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
              <p>Without a project folder, Lucid keeps files in its own workspace.</p>
              {!props.onChooseFolder ? (
                <p>Folder selection is available on the Mac running Lucid.</p>
              ) : null}
            </fieldset>
          )}
        </form.Field>
      ) : null}
      <div className="settings-fields">
        {(["harness", "model", "effort", "profile"] as const).map((name) => (
          <form.Field key={name} name={name}>
            {(field) => {
              const options =
                name === "harness"
                  ? (props.choices?.harnesses ?? [])
                  : name === "model"
                    ? (vocabulary?.models ?? [])
                    : name === "effort"
                      ? (vocabulary?.efforts ?? [])
                      : [...PROFILES];
              return (
                <label htmlFor={`${formId}-${name}`}>
                  {name === "profile" ? "Mode" : name.charAt(0).toUpperCase() + name.slice(1)}
                  {name === "model" && vocabulary?.extensible ? (
                    <input
                      id={`${formId}-${name}`}
                      data-slot="input"
                      required
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                    />
                  ) : (
                    <select
                      id={`${formId}-${name}`}
                      data-slot="native-select"
                      value={field.state.value}
                      required
                      onChange={(e) => {
                        field.handleChange(e.target.value);
                        if (name === "harness") {
                          form.setFieldValue("model", "");
                          form.setFieldValue("provider", "");
                          if (
                            !props.choices?.vocabulary[e.target.value]?.efforts.includes(
                              form.state.values.effort,
                            )
                          )
                            form.setFieldValue("effort", "");
                        }
                      }}
                    >
                      {!options.includes(field.state.value) ? (
                        <option value={field.state.value}>{field.state.value || "Choose…"}</option>
                      ) : null}
                      {options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
              );
            }}
          </form.Field>
        ))}
        {vocabulary?.provider ? (
          <form.Field name="provider">
            {(field) => (
              <label>
                Provider
                <input
                  data-slot="input"
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </label>
            )}
          </form.Field>
        ) : null}
      </div>
      <p>
        Headless turn starts a process for each prompt. Headless session keeps the harness session.
        Interactive attaches to a terminal session you own.
      </p>
      {error ? (
        <p role="alert" className="settings-error">
          {error}
        </p>
      ) : null}
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(busy) => (
          <Button variant="outline" type="submit" disabled={busy || choosingFolder}>
            {busy ? "Saving…" : props.submitLabel}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
