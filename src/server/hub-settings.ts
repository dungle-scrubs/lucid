import { isAbsolute, resolve } from "node:path";
import { type ConfigLocation, readUserConfig } from "../config/user-config.js";
import {
  type CompatibilityDiagnostic,
  diagnosticMessage,
  failureDiagnostic,
  hcnDiagnostic,
  safeFact,
  selectionDiagnostic,
  selectionProblem,
  unknownInstallation,
} from "../harness/compatibility.js";
import { createHcnRunner } from "../harness/hcn-runner.js";
import { type HarnessStartup, prepareNodeHarness } from "../harness/node-deps.js";
import type { HarnessRunner } from "../harness/runner.js";
import { isProfile, SETTINGS_FIELDS, type Settings } from "../protocol/driver-settings.js";
import { HubError } from "../protocol/hub-errors.js";
import { createWithReceipt } from "../store/creation.js";
import type { DiscoveryIndex } from "../store/discovery.js";
import { isDriverField, isDriverHarness, preferenceState } from "../store/driver-preference.js";
import { readRecordMetadata } from "../store/record-identity.js";
import { locationProjection, replaceSettings } from "../store/settings.js";
import { driverChoices, driverChoicesFromFacts } from "./driver-choices.js";
import { createRecoveryAvailability } from "./recovery-availability.js";

const objectBody = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HubError("Expected an object.", "E-HUB-03");
  return value as Record<string, unknown>;
};
function settingsShape(value: unknown): Settings {
  const choice = objectBody(value);
  if (!isDriverHarness(choice.harness))
    throw new HubError("Choose a supported harness.", "E-HUB-03");
  for (const field of ["model", "effort", ...(choice.provider === undefined ? [] : ["provider"])]) {
    if (!isDriverField(choice[field]))
      throw new HubError(
        `${field} must be a nonempty, control-free string of at most 128 characters.`,
        "E-HUB-03",
      );
  }
  if (!isProfile(choice.profile)) throw new HubError("Choose a supported mode.", "E-HUB-03");
  return {
    harness: choice.harness,
    model: String(choice.model),
    effort: String(choice.effort),
    profile: choice.profile,
    ...(choice.provider === undefined ? {} : { provider: String(choice.provider) }),
  };
}
export async function resolveSettings(value: unknown, runner: HarnessRunner): Promise<Settings> {
  const choice = settingsShape(value);
  const refuse = (
    code: "inspection-unavailable" | "selection-unsupported",
    detail?: string,
  ): never => {
    const diagnostic = selectionProblem(choice, runner.installation, code, detail);
    throw new HubError(
      diagnosticMessage(diagnostic),
      "E-HUB-03",
      400,
      ["Review settings"],
      diagnostic,
    );
  };
  const inspectionFailure = (error: unknown): never => {
    const diagnostic = failureDiagnostic(error);
    if (!diagnostic) return refuse("inspection-unavailable");
    throw new HubError(
      diagnosticMessage(diagnostic),
      "E-HUB-03",
      400,
      ["Review settings"],
      diagnostic,
    );
  };
  const facts = await runner.inspect(choice.harness).catch(inspectionFailure);
  const vocabulary = facts.vocabulary;
  if (!vocabulary) return refuse("inspection-unavailable");
  const model = vocabulary.aliases?.[choice.model] ?? choice.model;
  if (!vocabulary.extensible && !vocabulary.models.includes(model))
    refuse(
      "selection-unsupported",
      `Model ${safeFact(model)} is unavailable on ${choice.harness}. Choose a supported model`,
    );
  if (!vocabulary.efforts.includes(choice.effort))
    refuse("selection-unsupported", `Effort ${choice.effort} is unavailable on ${choice.harness}`);
  if (choice.provider !== undefined && !vocabulary.provider)
    refuse("selection-unsupported", "This harness does not support a provider choice");
  if (choice.profile === "headless-session" && !facts.session)
    refuse(
      "selection-unsupported",
      "This harness does not support headless-session. Choose another mode",
    );
  const selected = { ...choice, model };
  await runner.inspect(selected.harness, selected).catch(inspectionFailure);
  return selected;
}

export function createHubSettings(
  root: string,
  configLocation: ConfigLocation | undefined,
  injected?: HarnessRunner,
  rootPinned = false,
  receiptIndex?: DiscoveryIndex,
  harnessStartup?: Promise<HarnessStartup>,
) {
  let localRunner = injected;
  let runnerError: Error | undefined;
  let runtimeDiagnostics: readonly CompatibilityDiagnostic[] = [];
  let pending = injected === undefined;
  const startup = injected
    ? Promise.resolve()
    : Promise.resolve()
        .then(() => harnessStartup ?? prepareNodeHarness())
        .catch(() => ({
          deps: null,
          diagnostics: [
            hcnDiagnostic(
              unknownInstallation,
              "runtime-start",
              "the selected installation could not be inspected",
            ),
          ].filter((diagnostic): diagnostic is CompatibilityDiagnostic => diagnostic !== null),
        }))
        .then((result) => {
          pending = false;
          runtimeDiagnostics = result.diagnostics;
          if (result.deps) localRunner = createHcnRunner(result.deps);
          else
            runnerError = new HubError(
              `Harness inspection is unavailable. ${result.diagnostics.map(diagnosticMessage).join(" ")}`,
              "E-HUB-03",
              400,
              ["Review settings"],
              result.diagnostics[0],
            );
        });
  const runner = (): HarnessRunner => {
    if (runnerError) throw runnerError;
    if (!localRunner)
      throw new HubError(
        "Harness inspection is unavailable while the startup check is pending.",
        "E-HUB-03",
      );
    return localRunner;
  };
  const checked = new Map<string, Promise<Settings>>();
  const validate = (choice: unknown): Promise<Settings> => {
    const normalized = settingsShape(choice);
    const key = JSON.stringify(normalized);
    const existing = checked.get(key);
    const pending = existing ?? resolveSettings(normalized, runner());
    checked.delete(key);
    checked.set(key, pending);
    if (checked.size > 100) checked.delete(checked.keys().next().value ?? "");
    return pending;
  };
  let choiceLists: ReturnType<typeof driverChoices> | undefined;
  interface Observation {
    readonly owners: Set<string>;
    diagnostics: readonly CompatibilityDiagnostic[];
  }
  const observations = new Map<string, Observation>();
  const selectedObservations = new Map<string, string>();
  const releaseObservation = (dir: string): void => {
    const previous = selectedObservations.get(dir);
    if (previous === undefined) return;
    const entry = observations.get(previous);
    entry?.owners.delete(dir);
    if (entry?.owners.size === 0) observations.delete(previous);
    selectedObservations.delete(dir);
  };
  const observe = (
    dir: string,
    choice: Settings,
    cwd: string | null,
    resume?: string,
  ): readonly CompatibilityDiagnostic[] => {
    if (pending || runnerError || !cwd || choice.profile === "interactive") {
      releaseObservation(dir);
      return [];
    }
    const selectedRunner = runner();
    const key = JSON.stringify([selectedRunner.installation, choice, cwd, resume]);
    if (selectedObservations.get(dir) !== key) releaseObservation(dir);
    selectedObservations.set(dir, key);
    const existing = observations.get(key);
    if (existing) {
      existing.owners.add(dir);
      return existing.diagnostics;
    }
    const entry: Observation = { owners: new Set([dir]), diagnostics: [] };
    observations.set(key, entry);
    void selectedRunner
      .inspect(choice.harness, { ...choice, runtime: { cwd, profile: choice.profile, resume } })
      .then((facts) => {
        const diagnostic = selectionDiagnostic(facts, choice, selectedRunner.installation);
        entry.diagnostics = diagnostic ? [diagnostic] : [];
      })
      .catch((error) => {
        const diagnostic =
          failureDiagnostic(error) ?? selectionProblem(choice, selectedRunner.installation);
        entry.diagnostics = [{ ...diagnostic, severity: "warning" }];
      });
    return entry.diagnostics;
  };
  const choices = (): ReturnType<typeof driverChoices> => {
    if (pending) return Promise.resolve(driverChoicesFromFacts({}));
    if (choiceLists) return choiceLists;
    try {
      choiceLists = driverChoices(runner());
    } catch {
      // Runner construction can fail before driverChoices can degrade an
      // unavailable hcn. Keep record reads independent of harness availability.
      choiceLists = Promise.resolve(driverChoicesFromFacts({}));
    }
    return choiceLists;
  };
  const project = async (
    dir: string,
    actual: Partial<Settings> = {},
    sessions: Readonly<Partial<Record<Settings["harness"], string>>> = {},
  ) => {
    const state = preferenceState(dir);
    const location = locationProjection(readRecordMetadata(dir));
    const base = {
      compatibility: runtimeDiagnostics,
      location,
      driverPreference: state.preference,
    };
    const compatibility = (selected: Settings): readonly CompatibilityDiagnostic[] => [
      ...runtimeDiagnostics,
      ...observe(
        dir,
        selected,
        location.status === "available" ? location.workingDirectory : null,
        sessions[selected.harness],
      ),
    ];
    try {
      if (state.error) throw new HubError(state.error, "E-HUB-03");
      const saved = state.preference;
      if (saved?.model && saved.effort && saved.profile && saved.revision) {
        const selected = await validate(saved);
        return {
          ...base,
          compatibility: compatibility(selected),
          conversationSettings: { selected, revision: state.revision, error: null },
        };
      }
      releaseObservation(dir);
      const defaults = readUserConfig(configLocation).defaults;
      const harness = saved?.harness ?? actual.harness ?? defaults.harness;
      const compatible = actual.harness === harness ? actual : {};
      const model =
        saved?.model ??
        compatible.model ??
        (defaults.harness === harness ? defaults.model : undefined);
      if (!model) throw new HubError("Choose a model for the saved harness.", "E-HUB-03");
      const vocabulary = (await choices()).vocabulary[harness];
      const matchingActual =
        compatible.model && vocabulary?.aliases?.[model] === compatible.model
          ? compatible.model
          : model;
      const selected = await validate({
        harness,
        model: matchingActual,
        effort: saved?.effort ?? compatible.effort ?? defaults.effort,
        profile: saved?.profile ?? compatible.profile ?? defaults.profile,
        ...(saved?.provider
          ? { provider: saved.provider }
          : compatible.provider
            ? { provider: compatible.provider }
            : defaults.harness === harness && defaults.provider
              ? { provider: defaults.provider }
              : {}),
      });
      return {
        ...base,
        compatibility: runtimeDiagnostics,
        conversationSettings: { selected, revision: state.revision, error: null },
      };
    } catch (error) {
      releaseObservation(dir);
      const diagnostic = failureDiagnostic(error);
      return {
        ...base,
        compatibility: [...runtimeDiagnostics, ...(diagnostic ? [diagnostic] : [])],
        conversationSettings: {
          selected: null,
          errorInCompatibility: diagnostic !== undefined,
          revision: state.revision,
          error: error instanceof Error ? error.message : "Settings unavailable",
        },
      };
    }
  };
  return {
    compatibility: () => runtimeDiagnostics,
    choices,
    project,
    recovery: createRecoveryAvailability(runner),
    async defaults() {
      await startup;
      const lists = await choices();
      try {
        const config = readUserConfig(configLocation);
        return {
          compatibility: runtimeDiagnostics,
          selected: await validate(config.defaults),
          choices: lists,
          configPath: config.path,
          restartRequired: !rootPinned && resolve(config.recordsDir) !== root,
          rootPinned,
          error: null,
        };
      } catch (error) {
        return {
          compatibility: runtimeDiagnostics,
          selected: null,
          errorInCompatibility: failureDiagnostic(error) !== undefined,
          choices: lists,
          restartRequired: false,
          rootPinned,
          error: error instanceof Error ? error.message : "Configuration unavailable",
        };
      }
    },
    async update(dir: string, id: string, value: unknown) {
      await startup;
      const request = objectBody(value);
      if (!Number.isSafeInteger(request.expectedRevision) || Number(request.expectedRevision) < 0)
        throw new HubError("An expected settings revision is required.", "E-HUB-03", 400, [
          "Reload settings",
        ]);
      if (request.v !== undefined && request.v !== 1)
        throw new HubError("Settings version must be 1.", "E-HUB-03");
      for (const key of Object.keys(request))
        if (![...SETTINGS_FIELDS, "v", "expectedRevision"].includes(key))
          throw new HubError(`Unknown settings field: ${key}`, "E-HUB-03");
      return replaceSettings(dir, id, Number(request.expectedRevision), await validate(request));
    },
    async create(value: unknown) {
      await startup;
      const request = objectBody(value);
      for (const key of Object.keys(request))
        if (!["creationId", "workingDirectory", "settings"].includes(key))
          throw new HubError(`Unknown creation field: ${key}`, "E-HUB-03");
      const explicit = request.settings === undefined ? {} : objectBody(request.settings);
      for (const key of Object.keys(explicit))
        if (!(SETTINGS_FIELDS as readonly string[]).includes(key))
          throw new HubError(`Unknown settings field: ${key}`, "E-HUB-03");
      if (!isDriverField(request.creationId))
        throw new HubError("A creation ID is required.", "E-HUB-02");
      const folder = request.workingDirectory;
      const managed = folder == null || (typeof folder === "string" && folder.trim() === "");
      if (!managed && (typeof folder !== "string" || !isAbsolute(folder)))
        throw new HubError("Choose an absolute working folder.", "E-HUB-04", 400, [
          "Choose a working folder",
        ]);
      const normalized = {
        workingDirectory: managed ? null : resolve(folder as string),
        ...(Object.keys(explicit).length
          ? {
              settings: Object.fromEntries(
                Object.entries(explicit).sort(([a], [b]) => a.localeCompare(b)),
              ),
            }
          : {}),
      };
      return createWithReceipt(
        root,
        request.creationId,
        normalized,
        async () => {
          let defaults: Partial<Settings> = {};
          try {
            defaults = readUserConfig(configLocation).defaults;
          } catch (error) {
            try {
              settingsShape(explicit);
            } catch {
              throw error;
            }
          }
          return validate({ ...defaults, ...explicit });
        },
        receiptIndex,
      );
    },
  };
}
