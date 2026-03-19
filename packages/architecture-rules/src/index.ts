import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ArchitectureRuleRecord, ArchitectureRulesConfig, ArchitectureViolationRecord, EdgeRecord, ModuleRecord } from "@local-engineering-brain/core-types";
import {
  defaultArchitectureConfigCandidates,
  defaultGeneratedPatterns,
  globToRegExp,
  normalizePath,
  nowIso,
  stableId,
  toRelativePath
} from "@local-engineering-brain/shared-utils";

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function parseScalar(value: string): string | boolean {
  const normalized = stripQuotes(value.trim());
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return normalized;
}

function parseYamlConfig(sourceText: string): ArchitectureRulesConfig {
  const lines = sourceText
    .split(/\r?\n/)
    .map((raw) => raw.replace(/#.*$/, ""))
    .filter((line) => line.trim().length > 0);

  const generatedPatterns: string[] = [];
  const rules: ArchitectureRuleRecord[] = [];
  let section: "generatedPatterns" | "rules" | undefined;
  let currentRule: Partial<ArchitectureRuleRecord> | undefined;
  let currentException: { from?: string; to?: string } | undefined;
  let inExcept = false;

  const flushRule = () => {
    if (!currentRule) {
      return;
    }
    rules.push({
      id: String(currentRule.id ?? stableId("arch-rule", String(currentRule.from ?? ""), String(currentRule.to ?? ""), String(rules.length))),
      from: String(currentRule.from ?? "**"),
      to: String(currentRule.to ?? "**"),
      kind: currentRule.kind === "allow" ? "allow" : "forbid",
      severity: currentRule.severity === "warning" ? "warning" : "error",
      except: currentRule.except ?? [],
      allowGenerated: currentRule.allowGenerated === true
    });
    currentRule = undefined;
    currentException = undefined;
    inExcept = false;
  };

  for (const rawLine of lines) {
    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const line = rawLine.trim();

    if (indent === 0) {
      flushRule();
      if (line === "generatedPatterns:") {
        section = "generatedPatterns";
      } else if (line === "rules:") {
        section = "rules";
      }
      continue;
    }

    if (section === "generatedPatterns" && indent >= 2 && line.startsWith("- ")) {
      generatedPatterns.push(String(parseScalar(line.slice(2))));
      continue;
    }

    if (section !== "rules") {
      continue;
    }

    if (indent === 2 && line.startsWith("- ")) {
      flushRule();
      currentRule = { except: [] };
      const inline = line.slice(2).trim();
      if (inline.length > 0 && inline.includes(":")) {
        const separatorIndex = inline.indexOf(":");
        const key = inline.slice(0, separatorIndex).trim() as keyof ArchitectureRuleRecord;
        const value = parseScalar(inline.slice(separatorIndex + 1));
        (currentRule as Record<string, unknown>)[key] = value;
      }
      continue;
    }

    if (!currentRule) {
      continue;
    }

    if (indent === 4 && line === "except:") {
      inExcept = true;
      continue;
    }

    if (inExcept && indent === 6 && line.startsWith("- ")) {
      currentException = {};
      currentRule.except ??= [];
      currentRule.except.push(currentException);
      const inline = line.slice(2).trim();
      if (inline.length > 0 && inline.includes(":")) {
        const separatorIndex = inline.indexOf(":");
        const key = inline.slice(0, separatorIndex).trim() as "from" | "to";
        currentException[key] = String(parseScalar(inline.slice(separatorIndex + 1)));
      }
      continue;
    }

    if (inExcept && currentException && indent >= 8 && line.includes(":")) {
      const separatorIndex = line.indexOf(":");
      const key = line.slice(0, separatorIndex).trim() as "from" | "to";
      currentException[key] = String(parseScalar(line.slice(separatorIndex + 1)));
      continue;
    }

    if (indent >= 4 && line.includes(":")) {
      const separatorIndex = line.indexOf(":");
      const key = line.slice(0, separatorIndex).trim() as keyof ArchitectureRuleRecord;
      const value = parseScalar(line.slice(separatorIndex + 1));
      (currentRule as Record<string, unknown>)[key] = value;
      inExcept = false;
    }
  }

  flushRule();
  return { generatedPatterns, rules };
}

function parseConfigText(configPath: string, sourceText: string): ArchitectureRulesConfig {
  if (configPath.endsWith(".json")) {
    const parsed = JSON.parse(sourceText) as ArchitectureRulesConfig;
    return {
      generatedPatterns: [...new Set([...(parsed.generatedPatterns ?? []), ...defaultGeneratedPatterns])],
      rules: parsed.rules ?? []
    };
  }
  const parsed = parseYamlConfig(sourceText);
  return {
    generatedPatterns: [...new Set([...(parsed.generatedPatterns ?? []), ...defaultGeneratedPatterns])],
    rules: parsed.rules
  };
}

function isPathMatch(pattern: string, candidate: string): boolean {
  return globToRegExp(pattern).test(candidate);
}

function isGenerated(config: ArchitectureRulesConfig, relativePath: string): boolean {
  return (config.generatedPatterns ?? []).some((pattern) => isPathMatch(pattern, relativePath));
}

function isExceptionMatch(
  rule: ArchitectureRuleRecord,
  sourceRelativePath: string,
  targetRelativePath: string
): boolean {
  return (rule.except ?? []).some((exception) => {
    const sourceOk = exception.from ? isPathMatch(exception.from, sourceRelativePath) : true;
    const targetOk = exception.to ? isPathMatch(exception.to, targetRelativePath) : true;
    return sourceOk && targetOk;
  });
}

function isRuleMatch(rule: ArchitectureRuleRecord, sourceRelativePath: string, targetRelativePath: string): boolean {
  return isPathMatch(rule.from, sourceRelativePath) && isPathMatch(rule.to, targetRelativePath);
}

export async function loadArchitectureRules(workspaceRoot: string): Promise<ArchitectureRulesConfig> {
  for (const candidate of defaultArchitectureConfigCandidates) {
    const configPath = path.join(workspaceRoot, candidate);
    try {
      const raw = await readFile(configPath, "utf8");
      return parseConfigText(configPath, raw);
    } catch {
      continue;
    }
  }

  return {
    generatedPatterns: [...defaultGeneratedPatterns],
    rules: []
  };
}

export interface ArchitectureEvaluationInput {
  workspaceId: string;
  workspaceRoot: string;
  modules: ModuleRecord[];
  importEdges: EdgeRecord[];
  config: ArchitectureRulesConfig;
}

export function evaluateArchitectureRules(input: ArchitectureEvaluationInput): ArchitectureViolationRecord[] {
  const modulesById = new Map(input.modules.map((module) => [module.id, module]));
  const now = nowIso();
  const violations: ArchitectureViolationRecord[] = [];

  for (const edge of input.importEdges) {
    const sourceModule = modulesById.get(edge.sourceId);
    const targetModule = modulesById.get(edge.targetId);
    if (!sourceModule || !targetModule) {
      continue;
    }

    const sourceRelativePath = toRelativePath(input.workspaceRoot, normalizePath(sourceModule.canonicalPath));
    const targetRelativePath = toRelativePath(input.workspaceRoot, normalizePath(targetModule.canonicalPath));
    const sourceGenerated = isGenerated(input.config, sourceRelativePath);
    const targetGenerated = isGenerated(input.config, targetRelativePath);

    for (const rule of input.config.rules.filter((candidate) => candidate.kind === "forbid")) {
      if (!isRuleMatch(rule, sourceRelativePath, targetRelativePath)) {
        continue;
      }
      if (isExceptionMatch(rule, sourceRelativePath, targetRelativePath)) {
        continue;
      }
      if (rule.allowGenerated && (sourceGenerated || targetGenerated)) {
        continue;
      }

      violations.push({
        id: stableId("architecture-violation", input.workspaceId, rule.id, edge.id),
        workspaceId: input.workspaceId,
        ruleId: rule.id,
        sourceModuleId: sourceModule.id,
        sourcePath: sourceModule.canonicalPath,
        targetModuleId: targetModule.id,
        targetPath: targetModule.canonicalPath,
        severity: rule.severity,
        explanation: `${sourceRelativePath} must not import ${targetRelativePath}.`,
        evidenceEdgeId: edge.id,
        updatedAt: now
      });
    }

    const allowRules = input.config.rules.filter((candidate) => candidate.kind === "allow" && isPathMatch(candidate.from, sourceRelativePath));
    if (allowRules.length === 0) {
      continue;
    }

    const isAllowed = allowRules.some((rule) => {
      if (rule.allowGenerated && (sourceGenerated || targetGenerated)) {
        return true;
      }
      if (isExceptionMatch(rule, sourceRelativePath, targetRelativePath)) {
        return true;
      }
      return isPathMatch(rule.to, targetRelativePath);
    });

    if (isAllowed) {
      continue;
    }

    const rule = allowRules[0];
    if (!rule) {
      continue;
    }
    violations.push({
      id: stableId("architecture-violation", input.workspaceId, rule.id, edge.id),
      workspaceId: input.workspaceId,
      ruleId: rule.id,
      sourceModuleId: sourceModule.id,
      sourcePath: sourceModule.canonicalPath,
      targetModuleId: targetModule.id,
      targetPath: targetModule.canonicalPath,
      severity: rule.severity,
      explanation: `${sourceRelativePath} is only allowed to import ${rule.to}, but it imports ${targetRelativePath}.`,
      evidenceEdgeId: edge.id,
      updatedAt: now
    });
  }

  return violations;
}
