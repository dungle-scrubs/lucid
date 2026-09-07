import { isAbsolute, resolve } from "node:path";
import { type ConfigLocation, readUserConfig } from "../config/user-config.js";
import { createHcnRunner } from "../harness/hcn-runner.js";
import { nodeHarnessDeps } from "../harness/node-deps.js";
import type { HarnessRunner } from "../harness/runner.js";
import { isProfile, SETTINGS_FIELDS, type Settings } from "../protocol/driver-settings.js";
import { HubError } from "../protocol/hub-errors.js";
import { createWithReceipt } from "../store/creation.js";
import type { DiscoveryIndex } from "../store/discovery.js";
import { isDriverField, isDriverHarness, preferenceState } from "../store/driver-preference.js";
import { readRecordMetadata } from "../store/record-identity.js";
import { locationProjection, replaceSettings } from "../store/settings.js";
import { driverChoices } from "./driver-choices.js";

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
  const facts = await runner.inspect(choice.harness);
  const vocabulary = facts.vocabulary;
  if (!vocabulary)
    throw new HubError(
      "Harness inspection is unavailable. Repair hcn and restart Lucid.",
      "E-HUB-03",
    );
  const model = vocabulary.aliases?.[choice.model] ?? choice.model;
  if (!vocabulary.extensible && !vocabulary.models.includes(model))
    throw new HubError(
      `Model ${model} is unavailable on ${choice.harness}. Choose a supported model.`,
      "E-HUB-03",
    );
  if (!vocabulary.efforts.includes(choice.effort))
    throw new HubError(`Effort ${choice.effort} is unavailable on ${choice.harness}.`, "E-HUB-03");
  if (choice.provider !== undefined && !vocabulary.provider)
    throw new HubError("This harness does not support a provider choice.", "E-HUB-03");
  if (choice.profile === "headless-session" && !facts.session)
    throw new HubError(
      "This harness does not support headless-session. Choose another mode.",
      "E-HUB-03",
    );
  const selected = { ...choice, model };
  await runner.inspect(selected.harness, selected);
  return selected;
}

export function createHubSettings(
  root: string,
  configLocation: ConfigLocation | undefined,
  injected?: HarnessRunner,
  rootPinned = false,
  receiptIndex?: DiscoveryIndex,
) {
  let localRunner = injected;
  let runnerError: Error | undefined;
  const runner = (): HarnessRunner => {
    if (runnerError) throw runnerError;
    try {
      localRunner ??= createHcnRunner(nodeHarnessDeps());
      return localRunner;
    } catch {
      runnerError = new HubError(
        "Harness inspection is unavailable. Repair hcn and restart Lucid.",
        "E-HUB-03",
      );
      throw runnerError;
    }
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
  const choices = () => (choiceLists ??= driverChoices(runner()));
  const project = async (dir: string, actual: Partial<Settings> = {}) => {
    const state = preferenceState(dir);
    const location = locationProjection(readRecordMetadata(dir));
    const base = { location, driverPreference: state.preference };
    try {
      if (state.error) throw new HubError(state.error, "E-HUB-03");
      const saved = state.preference;
      if (saved?.model && saved.effort && saved.profile && saved.revision) {
        const selected = await validate(saved);
        return {
          ...base,
          conversationSettings: { selected, revision: state.revision, error: null },
        };
      }
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
      return { ...base, conversationSettings: { selected, revision: state.revision, error: null } };
    } catch (error) {
      return {
        ...base,
        conversationSettings: {
          selected: null,
          revision: state.revision,
          error: error instanceof Error ? error.message : "Settings unavailable",
        },
      };
    }
  };
  return {
    choices,
    project,
    async defaults() {
      const lists = await choices();
      try {
        const config = readUserConfig(configLocation);
        return {
          selected: await validate(config.defaults),
          choices: lists,
          configPath: config.path,
          restartRequired: !rootPinned && resolve(config.recordsDir) !== root,
          rootPinned,
          error: null,
        };
      } catch (error) {
        return {
          selected: null,
          choices: lists,
          restartRequired: false,
          rootPinned,
          error: error instanceof Error ? error.message : "Configuration unavailable",
        };
      }
    },
    async update(dir: string, id: string, value: unknown) {
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
      if (typeof request.workingDirectory !== "string" || !isAbsolute(request.workingDirectory))
        throw new HubError("Choose an absolute working folder.", "E-HUB-04", 400, [
          "Choose a working folder",
        ]);
      const normalized = {
        workingDirectory: resolve(request.workingDirectory),
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
