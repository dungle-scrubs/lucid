import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { HubError } from "../protocol/hub-errors.js";

// Fixed script: no browser values are interpolated into native code.
// https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/PromptforaFileorFolder.html
const CHOOSE_FOLDER = `
activate
try
  return POSIX path of (choose folder with prompt "Choose a project folder for Lucid")
on error number -128
  return ""
end try
`;

const pickerError = () =>
  new HubError(
    "The folder picker could not finish. Try choosing a folder again.",
    "E-HUB-04",
    503,
    ["Choose folder"],
  );

export function chooseNativeFolder(signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(pickerError());
    const child = spawn("/usr/bin/osascript", ["-e", CHOOSE_FOLDER], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    let failed = false;
    const abort = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timeout = setTimeout(abort, 120_000);
    timeout.unref();
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 65_536) abort();
    });
    child.on("error", () => {
      failed = true;
    });
    // Wait for close even on abort: the next dialog cannot overlap this child.
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (failed || code !== 0) return reject(pickerError());
      const folder = output.replace(/\r?\n$/, "");
      if (folder === "") return resolve(null);
      if (!isAbsolute(folder)) return reject(pickerError());
      resolve(folder);
    });
  });
}

export function createFolderPicker(
  choose = chooseNativeFolder,
  available = process.platform === "darwin",
) {
  let active: AbortController | null = null;
  return {
    available,
    close: () => active?.abort(),
    async select(signal: AbortSignal) {
      if (!available)
        throw new HubError(
          "Native folder selection is available on the Mac running Lucid.",
          "E-HUB-04",
          503,
        );
      if (active)
        throw new HubError(
          "A folder picker is already open. Finish or cancel it first.",
          "E-HUB-04",
          409,
        );
      active = new AbortController();
      try {
        const folder = await choose(AbortSignal.any([signal, active.signal]));
        return folder === null
          ? { status: "cancelled" as const }
          : { status: "selected" as const, workingDirectory: folder };
      } catch {
        throw pickerError();
      } finally {
        active = null;
      }
    },
  };
}
