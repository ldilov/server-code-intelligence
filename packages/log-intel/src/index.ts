import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { IncidentRecord, LogEventRecord, LogIntelConfig, LogLevel, LogSourceConfig } from "@local-engineering-brain/core-types";
import {
  defaultJsonLogLevelFields,
  defaultJsonLogMessageFields,
  defaultJsonLogServiceFields,
  defaultJsonLogTimestampFields,
  defaultLineLogPattern,
  defaultLogConfigCandidates,
  defaultWorkspaceIgnoreDirectories,
  defaultWorkspaceLogDiscoveryDirectoryHints,
  defaultWorkspaceLogDiscoveryExtensions,
  defaultWorkspaceLogDiscoveryNamePattern,
  normalizePath,
  nowIso,
  stableId
} from "@local-engineering-brain/shared-utils";

const ignoredDirectoryNames = new Set<string>(defaultWorkspaceIgnoreDirectories);
const likelyLogFilePattern = new RegExp(`(^|/)(${defaultWorkspaceLogDiscoveryDirectoryHints.join("|").replace("/", "\\/")})/`, "i");
const likelyLogNamePattern = defaultWorkspaceLogDiscoveryNamePattern;

function dedupeLogSources(workspaceRoot: string, sources: LogSourceConfig[]): LogSourceConfig[] {
  const byPath = new Map<string, LogSourceConfig>();
  for (const source of sources) {
    const normalizedPath = normalizePath(path.join(workspaceRoot, source.path));
    byPath.set(normalizedPath, source);
  }
  return [...byPath.values()];
}

function looksLikeLogFile(relativePath: string): boolean {
  const fileName = path.basename(relativePath);
  return (
    likelyLogFilePattern.test(relativePath) ||
    likelyLogNamePattern.test(fileName) ||
    defaultWorkspaceLogDiscoveryExtensions.some((extension) => fileName.toLowerCase().endsWith(extension))
  );
}

function inferLogSource(relativePath: string): LogSourceConfig {
  const normalizedRelativePath = relativePath.replace(/\\/g, "/");
  const segments = normalizedRelativePath.split("/").filter(Boolean);
  const fileName = segments[segments.length - 1] ?? normalizedRelativePath;
  const extension = path.extname(fileName).toLowerCase();
  const stem = fileName.replace(/\.(jsonl|ndjson|log|txt|out)$/i, "");
  const directorySegments = segments.slice(0, -1);
  const genericSegments = new Set(["logs", "log", "var"]);
  const logDirIndex = directorySegments.findIndex((segment) => segment.toLowerCase() === "logs" || segment.toLowerCase() === "log");
  const previousContext = logDirIndex > 0 ? directorySegments[logDirIndex - 1] : undefined;
  const nextContext = logDirIndex >= 0 ? directorySegments[logDirIndex + 1] : undefined;
  const fallbackContext = [...directorySegments].reverse().find((segment) => !genericSegments.has(segment.toLowerCase()) && !segment.startsWith("."));
  const service = (previousContext && !genericSegments.has(previousContext.toLowerCase())
    ? previousContext
    : nextContext && !genericSegments.has(nextContext.toLowerCase())
      ? nextContext
      : fallbackContext) ?? stem.split(/[.-]/)[0] ?? "workspace";
  const contextLabel = [...directorySegments]
    .filter((segment) => !genericSegments.has(segment.toLowerCase()) && !segment.startsWith("."))
    .slice(-2)
    .join("-");
  return {
    name: contextLabel ? `auto-${contextLabel}-${stem}` : `auto-${service}-${stem}`,
    path: normalizedRelativePath,
    service,
    format: extension === ".jsonl" || extension === ".ndjson" ? "jsonl" : "line"
  };
}

function parseScalar(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function parseYamlConfig(sourceText: string): LogIntelConfig {
  const lines = sourceText
    .split(/\r?\n/)
    .map((raw) => raw.replace(/#.*$/, ""))
    .filter((line) => line.trim().length > 0);

  const logs: LogSourceConfig[] = [];
  let current: Partial<LogSourceConfig> | undefined;

  const flush = () => {
    if (!current?.name || !current.path) {
      current = undefined;
      return;
    }
    logs.push({
      name: current.name,
      path: current.path,
      service: current.service,
      format: current.format === "jsonl" ? "jsonl" : "line"
    });
    current = undefined;
  };

  for (const rawLine of lines) {
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const line = rawLine.trim();
    if (indent === 0 && line !== "logs:") {
      continue;
    }
    if (indent === 2 && line.startsWith("- ")) {
      flush();
      current = {};
      const inline = line.slice(2).trim();
      if (inline.includes(":")) {
        const separator = inline.indexOf(":");
        const key = inline.slice(0, separator).trim() as keyof LogSourceConfig;
        current[key] = parseScalar(inline.slice(separator + 1)) as never;
      }
      continue;
    }
    if (current && indent >= 4 && line.includes(":")) {
      const separator = line.indexOf(":");
      const key = line.slice(0, separator).trim() as keyof LogSourceConfig;
      current[key] = parseScalar(line.slice(separator + 1)) as never;
    }
  }

  flush();
  return { logs };
}

function parseConfigText(configPath: string, sourceText: string): LogIntelConfig {
  if (configPath.endsWith(".json")) {
    const parsed = JSON.parse(sourceText) as Partial<LogIntelConfig>;
    return {
      logs: parsed.logs ?? []
    };
  }
  return parseYamlConfig(sourceText);
}

function normalizeLevel(value: string | undefined): LogLevel {
  switch ((value ?? "").toLowerCase()) {
    case "trace":
      return "trace";
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warn":
    case "warning":
      return "warn";
    case "error":
      return "error";
    case "fatal":
      return "fatal";
    default:
      return "unknown";
  }
}

function summarizeIncidentTitle(message: string): string {
  return message.slice(0, 120);
}

function pickFirstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function parseLineLogEvent(
  line: string,
  lineNumber: number,
  source: LogSourceConfig,
  workspaceId: string,
  absolutePath: string,
  fallbackTimestamp: string
): LogEventRecord {
  const match = line.match(defaultLineLogPattern);
  const timestamp = match?.[1] ?? fallbackTimestamp;
  const level = normalizeLevel(match?.[2]);
  const service = source.service ?? match?.[3] ?? source.name;
  const message = match?.[4] ?? line.trim();
  return {
    id: stableId("log-event", workspaceId, absolutePath, String(lineNumber), timestamp, message),
    workspaceId,
    sourceName: source.name,
    filePath: absolutePath,
    service,
    level,
    timestamp,
    message,
    rawLine: line,
    updatedAt: fallbackTimestamp
  };
}

function parseJsonLogEvent(
  line: string,
  lineNumber: number,
  source: LogSourceConfig,
  workspaceId: string,
  absolutePath: string,
  fallbackTimestamp: string
): LogEventRecord | undefined {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const timestamp = pickFirstString(parsed, defaultJsonLogTimestampFields) ?? fallbackTimestamp;
    const message = pickFirstString(parsed, defaultJsonLogMessageFields) ?? line.trim();
    const service = pickFirstString(parsed, defaultJsonLogServiceFields) ?? source.service ?? source.name;
    return {
      id: stableId("log-event", workspaceId, absolutePath, String(lineNumber), timestamp, message),
      workspaceId,
      sourceName: source.name,
      filePath: absolutePath,
      service,
      level: normalizeLevel(pickFirstString(parsed, defaultJsonLogLevelFields)),
      timestamp,
      message,
      rawLine: line,
      updatedAt: fallbackTimestamp
    };
  } catch {
    return undefined;
  }
}

export async function loadLogIntelConfig(workspaceRoot: string): Promise<LogIntelConfig> {
  let configuredLogs: LogSourceConfig[] = [];
  for (const candidate of defaultLogConfigCandidates) {
    const configPath = path.join(workspaceRoot, candidate);
    try {
      const raw = await readFile(configPath, "utf8");
      configuredLogs = parseConfigText(configPath, raw).logs ?? [];
      break;
    } catch {
      continue;
    }
  }

  const discoveredLogs = await discoverWorkspaceLogSources(workspaceRoot);
  return {
    logs: dedupeLogSources(workspaceRoot, [...discoveredLogs, ...configuredLogs])
  };
}

export async function discoverWorkspaceLogSources(workspaceRoot: string): Promise<LogSourceConfig[]> {
  const root = normalizePath(workspaceRoot);
  const discovered: LogSourceConfig[] = [];

  const visit = async (currentPath: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectoryNames.has(entry.name)) {
          await visit(entryPath);
        }
        continue;
      }

      const relativePath = path.relative(root, entryPath).replace(/\\/g, "/");
      if (looksLikeLogFile(relativePath)) {
        discovered.push(inferLogSource(relativePath));
      }
    }
  };

  await visit(root);

  return discovered;
}

export interface LogCollectionResult {
  events: LogEventRecord[];
  incidents: IncidentRecord[];
  warnings: string[];
}

export async function collectConfiguredLogs(workspaceRoot: string, workspaceId: string, config: LogIntelConfig): Promise<LogCollectionResult> {
  const events: LogEventRecord[] = [];
  const warnings: string[] = [];

  for (const source of config.logs) {
    const absolutePath = normalizePath(path.join(workspaceRoot, source.path));
    try {
      const fileStat = await stat(absolutePath);
      const fallbackTimestamp = fileStat.mtime.toISOString();
      const raw = await readFile(absolutePath, "utf8");
      const lines = raw.split(/\r?\n/).filter(Boolean);
      for (const [index, line] of lines.entries()) {
        const event = source.format === "jsonl"
          ? parseJsonLogEvent(line, index + 1, source, workspaceId, absolutePath, fallbackTimestamp)
          : parseLineLogEvent(line, index + 1, source, workspaceId, absolutePath, fallbackTimestamp);
        if (event) {
          events.push(event);
        }
      }
    } catch (error) {
      warnings.push(`Failed to read configured log source ${source.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const incidentsByKey = new Map<string, IncidentRecord>();
  for (const event of events.filter((candidate) => candidate.level === "error" || candidate.level === "fatal")) {
    const key = `${event.service}::${summarizeIncidentTitle(event.message)}`;
    const existing = incidentsByKey.get(key);
    if (!existing) {
      incidentsByKey.set(key, {
        id: stableId("incident", workspaceId, event.service, event.message),
        workspaceId,
        service: event.service,
        title: summarizeIncidentTitle(event.message),
        level: event.level,
        firstSeenAt: event.timestamp,
        lastSeenAt: event.timestamp,
        eventCount: 1,
        latestLogEventId: event.id,
        updatedAt: event.updatedAt
      });
      continue;
    }

    existing.eventCount += 1;
    if (event.timestamp < existing.firstSeenAt) {
      existing.firstSeenAt = event.timestamp;
    }
    if (event.timestamp >= existing.lastSeenAt) {
      existing.lastSeenAt = event.timestamp;
      existing.latestLogEventId = event.id;
      existing.level = event.level;
    }
    existing.updatedAt = event.updatedAt;
  }

  return {
    events: events.sort((left, right) => right.timestamp.localeCompare(left.timestamp)),
    incidents: [...incidentsByKey.values()].sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt)),
    warnings
  };
}
