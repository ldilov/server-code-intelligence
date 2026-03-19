import os from "node:os";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export function parseArgs(argv: string[]) {
  const parsed: { dataDir?: string; workspace?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--data-dir" && next) {
      parsed.dataDir = next;
      index += 1;
    } else if (current === "--workspace" && next) {
      parsed.workspace = next;
      index += 1;
    }
  }
  return parsed;
}

export function detectBootstrapWorkspace(
  argvWorkspace: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  currentWorkingDirectory = process.cwd()
) {
  if (argvWorkspace) {
    return argvWorkspace;
  }

  const envWorkspace =
    env.LOCAL_ENGINEERING_BRAIN_WORKSPACE ??
    env.MCP_WORKSPACE_ROOT ??
    env.CLAUDE_PROJECT_DIR ??
    env.CLAUDE_WORKING_DIR ??
    env.CODEX_WORKSPACE_ROOT ??
    env.INIT_CWD;

  if (envWorkspace?.trim()) {
    const normalizedEnvWorkspace = path.resolve(envWorkspace);
    if (isSafeWorkspaceCandidate(normalizedEnvWorkspace, env)) {
      return normalizedEnvWorkspace;
    }
  }

  const normalizedCwd = path.resolve(currentWorkingDirectory);
  if (!isSafeWorkspaceCandidate(normalizedCwd, env) || !hasWorkspaceMarker(normalizedCwd)) {
    return undefined;
  }

  return normalizedCwd;
}

function isSafeWorkspaceCandidate(candidatePath: string, env: NodeJS.ProcessEnv) {
  if (!existsSync(candidatePath)) {
    return false;
  }

  let stats;
  try {
    stats = statSync(candidatePath);
  } catch {
    return false;
  }

  if (!stats.isDirectory()) {
    return false;
  }

  const normalizedCandidate = path.resolve(candidatePath);
  const homeDirectory = path.resolve(os.homedir());
  const tempDirectory = path.resolve(os.tmpdir());
  const windowsDirectory = path.resolve(env.SystemRoot ?? "C:\\Windows");
  const programFiles = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.ProgramW6432
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));

  if (normalizedCandidate === homeDirectory || normalizedCandidate.startsWith(tempDirectory)) {
    return false;
  }

  if (normalizedCandidate === windowsDirectory || normalizedCandidate.startsWith(`${windowsDirectory}${path.sep}`)) {
    return false;
  }

  if (programFiles.some((directory) => normalizedCandidate === directory || normalizedCandidate.startsWith(`${directory}${path.sep}`))) {
    return false;
  }

  return true;
}

function hasWorkspaceMarker(candidatePath: string) {
  try {
    const entries = readdirSync(candidatePath, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name.toLowerCase()));

    if (
      names.has(".git") ||
      names.has("package.json") ||
      names.has("pnpm-workspace.yaml") ||
      names.has("tsconfig.json") ||
      names.has("pyproject.toml") ||
      names.has("cargo.toml") ||
      names.has("go.mod") ||
      names.has("pom.xml") ||
      names.has("build.gradle") ||
      names.has("build.gradle.kts") ||
      names.has("composer.json") ||
      names.has("gemfile") ||
      names.has("makefile") ||
      names.has("justfile") ||
      names.has(".claude") ||
      names.has(".codex")
    ) {
      return true;
    }

    return entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".sln"));
  } catch {
    return false;
  }
}
