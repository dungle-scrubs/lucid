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
              // Installed pairs (RFC-27) carry the provider with the
              // model, because one id can exist under two providers.
              // The row label splits on pick into the model plus
              // provider fields; a bare id keeps whatever provider
              // stands. A custom row holds a typed id the lists do
              // not carry, so free entry survives inside the menu.
              const installed = name === "model" ? (vocabulary?.installed ?? []) : [];
              const qualified = (pair: { provider: string; model: string }): string =>
                `${pair.provider}/${pair.model}`;
              const modelRows =
                name === "model"
                  ? [
                      ...installed.map((pair) => ({
                        key: qualified(pair),
                        label: qualified(pair),
                        model: pair.model,
                        provider: pair.provider,
                      })),
                      ...options
                        .filter((option) => !installed.some((pair) => pair.model === option))
                        .map((option) => ({
                          key: option,
                          label: option,
                          model: option,
                          provider: undefined as string | undefined,
                        })),
                    ]
                  : [];
              // The select's value is the row label: a qualified
              // provider/model pair where one exists, else the bare id.
              // A saved id that rows carry selects its own row; a saved
              // custom id selects its own custom row plus the typing box.
              const selectedKey =
                name === "model"
                  ? (modelRows.find((row) => row.model === field.state.value)?.key ??
                    field.state.value)
                  : field.state.value;
              const customRow =
                name === "model" &&
                field.state.value !== "" &&
                !modelRows.some((row) => row.model === field.state.value) ? (
                  <option value={field.state.value}>{field.state.value} (custom)</option>
                ) : null;
              const showCustomInput =
                name === "model" &&
                field.state.value !== "" &&
                !modelRows.some((row) => row.model === field.state.value);
              return (
                <label htmlFor={`${formId}-${name}`}>
                  {name === "profile" ? "Mode" : name.charAt(0).toUpperCase() + name.slice(1)}
                  {name === "model" && vocabulary?.extensible ? (
                    <>
                      <select
                        id={`${formId}-${name}`}
                        data-slot="native-select"
                        value={selectedKey}
                        required
                        onChange={(e) => {
                          const picked = e.target.value;
                          if (picked === "custom:new") return;
                          const hit = modelRows.find((row) => row.key === picked);
                          if (hit === undefined) {
                            field.handleChange(picked);
                            return;
                          }
                          field.handleChange(hit.model);
                          if (hit.provider !== undefined)
                            form.setFieldValue("provider", hit.provider);
                        }}
                      >
                        {field.state.value === "" ? <option value="">Choose…</option> : null}
                        {modelRows.map((row) => (
                          <option key={row.key} value={row.key}>
                            {row.label}
                          </option>
                        ))}
                        {customRow}
                        <option value="custom:new">Type another id…</option>
                      </select>
                      {showCustomInput ? (
                        <input
                          id={`${formId}-${name}-custom`}
                          data-slot="input"
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="Type a model id…"
                          aria-label="Another model id"
                        />
                      ) : null}
                    </>
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
