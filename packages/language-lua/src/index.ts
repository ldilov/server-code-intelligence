import fs from "node:fs";
import path from "node:path";
import type { EdgeRecord, ExtractedFileFact, ExtractedSymbol, SummaryRecord } from "@local-engineering-brain/core-types";
import { resolveWorkspaceModuleReference, type CandidateFile, type FileClassification, type LanguageAdapter, type ParserContextV2 } from "@local-engineering-brain/language-core";
import { pathToModuleLanguage, stableId } from "@local-engineering-brain/shared-utils";

const luaIdentifier = "[A-Za-z_][A-Za-z0-9_]*";
const luaPathExpression = `${luaIdentifier}(?:\\.${luaIdentifier})*`;
const tableDeclarationPattern = new RegExp(
  `^\\s*(local\\s+)?(${luaIdentifier})\\s*=\\s*(\\{\\s*\\}|Create(?:AndInit)?FromMixins\\b.*|setmetatable\\b.*)$`
);
const namedFunctionPattern = new RegExp(`^\\s*(local\\s+)?function\\s+(${luaIdentifier})\\s*\\(`);
const tableFunctionPattern = new RegExp(`^\\s*function\\s+(${luaPathExpression})([:.])(${luaIdentifier})\\s*\\(`);
const assignedTableFunctionPattern = new RegExp(`^\\s*(${luaPathExpression})([:.])(${luaIdentifier})\\s*=\\s*function\\s*\\(`);
const returnIdentifierPattern = new RegExp(`^\\s*return\\s+(${luaIdentifier})\\s*$`);
const requirePattern = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
const runtimeModuleLookupPattern = /[:.]GetModule\s*\(\s*["']([^"']+)["']\s*\)/g;

interface PendingLuaSymbol {
  symbol: ExtractedSymbol;
  exported: boolean;
  containerName?: string;
}

function toRange(lineNumber: number, startColumn: number, textLength: number) {
  return {
    start: {
      line: lineNumber,
      column: startColumn
    },
    end: {
      line: lineNumber,
      column: startColumn + Math.max(1, textLength)
    }
  };
}

function summaryForSymbol(kind: ExtractedSymbol["kind"], name: string, relativePath: string) {
  return `lua ${kind} ${name} declared in ${relativePath}`;
}

function lineColumn(line: string, fragment: string) {
  const index = line.indexOf(fragment);
  return index >= 0 ? index + 1 : 1;
}

function resolveLuaRequire(workspaceRoot: string, fromFilePath: string, requireText: string): string | undefined {
  const normalizedRequire = requireText.replace(/\./g, "/");
  const currentDirectory = path.dirname(fromFilePath);
  const candidates = [
    path.resolve(currentDirectory, normalizedRequire),
    path.resolve(workspaceRoot, normalizedRequire)
  ]
    .flatMap((basePath) => [`${basePath}.lua`, path.join(basePath, "init.lua")])
    .map((candidate) => candidate.replace(/\\/g, "/"));

  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

export class LuaLanguageAdapter implements LanguageAdapter<ExtractedFileFact> {
  public readonly id = "language-lua";
  public readonly displayName = "Lua";
  public readonly extractorVersion = "language-lua-v3";
  public readonly parserVersion = "lua-structural-v2";

  public supports(_candidate: CandidateFile, classification: FileClassification): boolean {
    return (classification.kind === "source" || classification.kind === "test") && classification.language === "lua";
  }

  public extract(context: ParserContextV2, sourceText: string) {
    const fileId = stableId("file", context.workspaceId, context.filePath);
    const moduleId = stableId("module", context.workspaceId, context.filePath);
    const language = context.classification.language ?? pathToModuleLanguage(context.filePath);
    const lines = sourceText.split(/\r?\n/);
    const warnings: string[] = [];
    const edges: EdgeRecord[] = [];
    const symbolRecords = new Map<string, PendingLuaSymbol>();
    const exportedContainers = new Set<string>();
    const importedModules = new Set<string>();

    const addEdge = (edge: Omit<EdgeRecord, "id">) => {
      const existing = edges.find(
        (candidate) =>
          candidate.type === edge.type &&
          candidate.sourceId === edge.sourceId &&
          candidate.targetId === edge.targetId &&
          candidate.ownerFilePath === edge.ownerFilePath
      );

      if (existing) {
        if (edge.confidence > existing.confidence) {
          existing.confidence = edge.confidence;
        }
        existing.metadata = existing.metadata ?? edge.metadata;
        return;
      }

      const id = stableId("edge", edge.type, edge.sourceId, edge.targetId, edge.ownerFilePath);
      edges.push({ id, ...edge });
    };

    const upsertSymbol = (
      symbolKey: string,
      localName: string,
      qualifiedName: string,
      kind: ExtractedSymbol["kind"],
      lineNumber: number,
      lineText: string,
      exported: boolean,
      containerName?: string
    ) => {
      const id = stableId("symbol", context.workspaceId, context.filePath, symbolKey);
      const symbol: ExtractedSymbol = {
        id,
        localName,
        qualifiedName,
        kind,
        exported,
        signature: lineText.trim().slice(0, 180),
        range: toRange(lineNumber, lineColumn(lineText, localName), localName.length),
        summary: summaryForSymbol(kind, qualifiedName.split("#").pop() ?? localName, context.relativePath)
      };

      const existing = symbolRecords.get(id);
      if (!existing) {
        symbolRecords.set(id, {
          symbol,
          exported,
          containerName
        });
        return;
      }

      existing.exported = existing.exported || exported;
      existing.containerName = existing.containerName ?? containerName;
      existing.symbol.exported = existing.exported;
      existing.symbol.signature = existing.symbol.signature ?? symbol.signature;
    };

    for (const [index, line] of lines.entries()) {
      const lineNumber = index + 1;

      for (const requireMatch of line.matchAll(requirePattern)) {
        const requireText = requireMatch[1];
        if (!requireText) {
          continue;
        }

        const resolved = resolveLuaRequire(context.workspaceRoot, context.filePath, requireText);
        if (!resolved) {
          continue;
        }

        const targetModuleId = stableId("module", context.workspaceId, resolved);
        importedModules.add(resolved);
        addEdge({
          workspaceId: context.workspaceId,
          sourceId: moduleId,
          sourceType: "module",
          targetId: targetModuleId,
          targetType: "module",
          type: "imports",
          ownerFilePath: context.filePath,
          confidence: 0.75,
          metadata: { requireText, resolvedPath: resolved },
          createdAt: context.now,
          updatedAt: context.now
        });
      }

      for (const runtimeLookup of line.matchAll(runtimeModuleLookupPattern)) {
        const moduleReference = runtimeLookup[1];
        if (!moduleReference) {
          continue;
        }

        const resolved = resolveWorkspaceModuleReference(context.workspaceModuleCatalog, moduleReference, {
          fromFilePath: context.filePath,
          language
        });
        if (!resolved) {
          continue;
        }

        const targetModuleId = stableId("module", context.workspaceId, resolved.path);
        importedModules.add(resolved.path);
        addEdge({
          workspaceId: context.workspaceId,
          sourceId: moduleId,
          sourceType: "module",
          targetId: targetModuleId,
          targetType: "module",
          type: "imports",
          ownerFilePath: context.filePath,
          confidence: 0.72,
          metadata: {
            referenceText: moduleReference,
            resolvedPath: resolved.path,
            resolver: "workspace-module-catalog",
            pattern: "GetModule"
          },
          createdAt: context.now,
          updatedAt: context.now
        });
      }

      const returnMatch = line.match(returnIdentifierPattern);
      if (returnMatch?.[1]) {
        exportedContainers.add(returnMatch[1]);
      }

      const tableDeclaration = line.match(tableDeclarationPattern);
      if (tableDeclaration?.[2]) {
        const isLocal = Boolean(tableDeclaration[1]);
        const tableName = tableDeclaration[2];
        upsertSymbol(
          `table:${tableName}`,
          tableName,
          `${context.relativePath}#${tableName}`,
          "constant",
          lineNumber,
          line,
          !isLocal,
          tableName
        );
      }

      const namedFunction = line.match(namedFunctionPattern);
      if (namedFunction?.[2]) {
        const isLocal = Boolean(namedFunction[1]);
        const functionName = namedFunction[2];
        upsertSymbol(
          `function:${functionName}`,
          functionName,
          `${context.relativePath}#${functionName}`,
          "function",
          lineNumber,
          line,
          !isLocal
        );
        continue;
      }

      const tableFunction = line.match(tableFunctionPattern) ?? line.match(assignedTableFunctionPattern);
      if (tableFunction?.[1] && tableFunction[3]) {
        const containerPath = tableFunction[1];
        const localContainerName = containerPath.split(".").pop() ?? containerPath;
        const methodName = tableFunction[3];
        const qualifiedMemberName = `${containerPath}.${methodName}`;

        upsertSymbol(
          `table:${containerPath}`,
          localContainerName,
          `${context.relativePath}#${containerPath}`,
          "constant",
          lineNumber,
          line,
          exportedContainers.has(localContainerName),
          localContainerName
        );
        upsertSymbol(
          `member:${qualifiedMemberName}`,
          methodName,
          `${context.relativePath}#${qualifiedMemberName}`,
          "method",
          lineNumber,
          line,
          exportedContainers.has(localContainerName),
          localContainerName
        );
      }
    }

    for (const containerName of exportedContainers) {
      for (const record of symbolRecords.values()) {
        if (record.symbol.localName === containerName || record.containerName === containerName) {
          record.exported = true;
          record.symbol.exported = true;
        }
      }
    }

    const symbols = [...symbolRecords.values()].map((record) => record.symbol);
    const symbolByLocalName = new Map<string, ExtractedSymbol[]>();
    const memberByQualifiedName = new Map<string, ExtractedSymbol>();
    for (const record of symbolRecords.values()) {
      const existing = symbolByLocalName.get(record.symbol.localName) ?? [];
      existing.push(record.symbol);
      symbolByLocalName.set(record.symbol.localName, existing);
      if (record.containerName) {
        memberByQualifiedName.set(`${record.containerName}.${record.symbol.localName}`, record.symbol);
      }
    }

    let currentFunctionSymbol: PendingLuaSymbol | undefined;
    for (const line of lines) {
      const namedFunction = line.match(namedFunctionPattern);
      if (namedFunction?.[2]) {
        currentFunctionSymbol = symbolRecords.get(stableId("symbol", context.workspaceId, context.filePath, `function:${namedFunction[2]}`));
      } else {
        const tableFunction = line.match(tableFunctionPattern) ?? line.match(assignedTableFunctionPattern);
        if (tableFunction?.[1] && tableFunction[3]) {
          currentFunctionSymbol = symbolRecords.get(
            stableId("symbol", context.workspaceId, context.filePath, `member:${tableFunction[1]}.${tableFunction[3]}`)
          );
        }
      }

      if (currentFunctionSymbol) {
        for (const match of line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)([:.])([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
          const baseName = match[1] ?? "";
          const methodName = match[3] ?? "";
          if (!baseName || !methodName) {
            continue;
          }
          const target =
            (baseName === "self" && currentFunctionSymbol.containerName
              ? memberByQualifiedName.get(`${currentFunctionSymbol.containerName}.${methodName}`)
              : memberByQualifiedName.get(`${baseName}.${methodName}`)) ??
            symbolByLocalName.get(methodName)?.[0];
          if (!target || target.id === currentFunctionSymbol.symbol.id) {
            continue;
          }
          addEdge({
            workspaceId: context.workspaceId,
            sourceId: currentFunctionSymbol.symbol.id,
            sourceType: "symbol",
            targetId: target.id,
            targetType: "symbol",
            type: "calls",
            ownerFilePath: context.filePath,
            confidence: 0.72,
            createdAt: context.now,
            updatedAt: context.now
          });
        }

        for (const match of line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
          const callee = match[1] ?? "";
          if (!callee) {
            continue;
          }
          if (["function", "if", "for", "while", "return", "local"].includes(callee)) {
            continue;
          }
          const target = symbolByLocalName.get(callee)?.[0];
          if (!target || target.id === currentFunctionSymbol.symbol.id) {
            continue;
          }
          addEdge({
            workspaceId: context.workspaceId,
            sourceId: currentFunctionSymbol.symbol.id,
            sourceType: "symbol",
            targetId: target.id,
            targetType: "symbol",
            type: "calls",
            ownerFilePath: context.filePath,
            confidence: 0.65,
            createdAt: context.now,
            updatedAt: context.now
          });
        }
      }

      if (line.trim() === "end") {
        currentFunctionSymbol = undefined;
      }
    }

    const publicExports = symbols.filter((symbol) => symbol.exported).map((symbol) => symbol.localName);

    addEdge({
      workspaceId: context.workspaceId,
      sourceId: fileId,
      sourceType: "file",
      targetId: moduleId,
      targetType: "module",
      type: "contains",
      ownerFilePath: context.filePath,
      confidence: 1,
      createdAt: context.now,
      updatedAt: context.now
    });

    if (context.packageId) {
      addEdge({
        workspaceId: context.workspaceId,
        sourceId: moduleId,
        sourceType: "module",
        targetId: context.packageId,
        targetType: "package",
        type: "belongs_to_package",
        ownerFilePath: context.filePath,
        confidence: 1,
        createdAt: context.now,
        updatedAt: context.now
      });
    }

    for (const symbol of symbols) {
      addEdge({
        workspaceId: context.workspaceId,
        sourceId: moduleId,
        sourceType: "module",
        targetId: symbol.id,
        targetType: "symbol",
        type: "declares",
        ownerFilePath: context.filePath,
        confidence: 1,
        createdAt: context.now,
        updatedAt: context.now
      });

      if (symbol.exported) {
        addEdge({
          workspaceId: context.workspaceId,
          sourceId: moduleId,
          sourceType: "module",
          targetId: symbol.id,
          targetType: "symbol",
          type: "exports",
          ownerFilePath: context.filePath,
          confidence: 0.95,
          createdAt: context.now,
          updatedAt: context.now
        });
      }
    }

    if (symbols.length === 0) {
      warnings.push(`No extractable Lua symbols were found in ${context.relativePath}.`);
    }

    const summaryText =
      `Lua module ${context.relativePath} indexes ${symbols.length} symbol(s), ` +
      `${publicExports.length} exported symbol(s), and ${importedModules.size} module dependency link(s).`;

    const summary: SummaryRecord = {
      id: stableId("summary", context.workspaceId, moduleId),
      workspaceId: context.workspaceId,
      entityId: moduleId,
      entityType: "module",
      summary: summaryText,
      source: this.id,
      updatedAt: context.now
    };

    return {
      facts: {
        file: {
          id: fileId,
          workspaceId: context.workspaceId,
          repoId: context.repoId,
          packageId: context.packageId,
          path: context.filePath,
          language,
          summary: summaryText,
          authored: true,
          hash: context.hash,
          updatedAt: context.now
        },
        module: {
          id: moduleId,
          workspaceId: context.workspaceId,
          fileId,
          packageId: context.packageId,
          canonicalPath: context.moduleIdentity.canonicalPath,
          language,
          summary: summaryText,
          publicExports: [...new Set(publicExports)],
          inboundDependencyCount: 0,
          outboundDependencyCount: importedModules.size,
          updatedAt: context.now
        },
        symbols,
        edges,
        summary,
        warnings
      },
      warnings
    };
  }
}
