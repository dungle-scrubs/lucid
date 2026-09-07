import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface FolderAssociation {
  readonly projectDirectory: string;
  readonly workingDirectory: string;
}

export const associateFolder = (directory: string): FolderAssociation => {
  const workingDirectory = realpathSync(directory);
  if (!statSync(workingDirectory).isDirectory())
    throw new Error("working folder is not a directory");
  let candidate = workingDirectory;
  while (!existsSync(join(candidate, ".git"))) {
    const parent = dirname(candidate);
    if (parent === candidate) return { projectDirectory: workingDirectory, workingDirectory };
    candidate = parent;
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  try {
    const projectDirectory = realpathSync(
      execFileSync("git", ["-C", workingDirectory, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    );
    return { projectDirectory, workingDirectory };
  } catch {
    // A Git marker is only a hint. If Git cannot resolve a root, this is a folder conversation.
    return { projectDirectory: workingDirectory, workingDirectory };
  }
};
