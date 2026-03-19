import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type WorkspaceRecord } from "@local-engineering-brain/core-types";
import { normalizePath, nowIso, stableId } from "@local-engineering-brain/shared-utils";

export interface AppPaths {
  baseDir: string;
  configPath: string;
  databasePath: string;
  logsDir: string;
  workspacesDir: string;
}

export interface WorkspaceRegistration {
  workspace: WorkspaceRecord;
  alreadyRegistered: boolean;
}

export interface AppConfig {
  workspaces: WorkspaceRecord[];
  featureFlags: Record<string, boolean>;
}

export function resolveAppPaths(baseDir = path.join(os.homedir(), ".local-engineering-brain")): AppPaths {
  const normalizedBase = normalizePath(baseDir);
  return {
    baseDir: normalizedBase,
    configPath: `${normalizedBase}/config.json`,
    databasePath: `${normalizedBase}/brain.db`,
    logsDir: `${normalizedBase}/logs`,
    workspacesDir: `${normalizedBase}/workspaces`
  };
}

export async function ensureAppPaths(appPaths: AppPaths): Promise<void> {
  await Promise.all([
    mkdir(appPaths.baseDir, { recursive: true }),
    mkdir(appPaths.logsDir, { recursive: true }),
    mkdir(appPaths.workspacesDir, { recursive: true })
  ]);
}

export async function loadAppConfig(appPaths: AppPaths): Promise<AppConfig> {
  try {
    const raw = await readFile(appPaths.configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return {
      workspaces: parsed.workspaces ?? [],
      featureFlags: parsed.featureFlags ?? {}
    };
  } catch {
    return {
      workspaces: [],
      featureFlags: {}
    };
  }
}

export async function saveAppConfig(appPaths: AppPaths, config: AppConfig): Promise<void> {
  await ensureAppPaths(appPaths);
  await writeFile(appPaths.configPath, JSON.stringify(config, null, 2));
}

export async function registerWorkspace(appPaths: AppPaths, rootPath: string, label?: string): Promise<WorkspaceRegistration> {
  const normalizedRoot = normalizePath(rootPath);
  const rootStat = await stat(normalizedRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${normalizedRoot}`);
  }

  await ensureAppPaths(appPaths);
  const config = await loadAppConfig(appPaths);
  const existing = config.workspaces.find((workspace) => workspace.rootPath === normalizedRoot);
  if (existing) {
    return {
      workspace: existing,
      alreadyRegistered: true
    };
  }

  const now = nowIso();
  const workspace: WorkspaceRecord = {
    id: stableId("workspace", normalizedRoot),
    rootPath: normalizedRoot,
    label: label ?? path.basename(normalizedRoot),
    createdAt: now,
    updatedAt: now
  };

  config.workspaces.push(workspace);
  await saveAppConfig(appPaths, config);
  await mkdir(`${appPaths.workspacesDir}/${workspace.id}`, { recursive: true });

  return {
    workspace,
    alreadyRegistered: false
  };
}

export async function findWorkspaceById(appPaths: AppPaths, workspaceId: string): Promise<WorkspaceRecord | undefined> {
  const config = await loadAppConfig(appPaths);
  return config.workspaces.find((workspace) => workspace.id === workspaceId);
}

export async function listApprovedWorkspaces(appPaths: AppPaths): Promise<WorkspaceRecord[]> {
  const config = await loadAppConfig(appPaths);
  return config.workspaces;
}
