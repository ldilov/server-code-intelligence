import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { EdgeRecord, ExtractedFileFact, ExtractedSymbol, ParserContext, RangePosition, SymbolKind } from "@local-engineering-brain/core-types";
import type { CandidateFile, FileClassification, LanguageAdapter, ParserContextV2 } from "@local-engineering-brain/language-core";
import { nowIso, pathToModuleLanguage, resolveLocalModulePath, stableId } from "@local-engineering-brain/shared-utils";

function scriptKindForFile(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".ts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.JS;
  }
}

function toRangePosition(sourceFile: ts.SourceFile, position: number): RangePosition {
  const next = sourceFile.getLineAndCharacterOfPosition(position);
  return {
    line: next.line + 1,
    column: next.character + 1
  };
}

function resolveLocalImport(context: ParserContext, importText: string): string | undefined {
  return resolveLocalModulePath(context.filePath, importText);
}

function nodeName(node: ts.Node): string | undefined {
  const candidate = (node as ts.NamedDeclaration).name;
  if (candidate && ts.isIdentifier(candidate)) {
    return candidate.text;
  }
  return undefined;
}

function symbolKindForNode(node: ts.Node): SymbolKind | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node)) {
    return "function";
  }
  if (ts.isClassDeclaration(node)) {
    return "class";
  }
  if (ts.isInterfaceDeclaration(node)) {
    return "interface";
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return "type";
  }
  if (ts.isEnumDeclaration(node)) {
    return "enum";
  }
  if (ts.isMethodDeclaration(node)) {
    return "method";
  }
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
    return "field";
  }
  if (ts.isVariableDeclaration(node)) {
    return "constant";
  }
  return undefined;
}

function isNodeExported(node: ts.Node): boolean {
  return Boolean(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) || Boolean((node as ts.Node & { modifiers?: ts.NodeArray<ts.Modifier> }).modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
}

function summarizeSymbol(kind: SymbolKind, name: string, context: ParserContext): string {
  return `${kind} ${name} declared in ${context.relativePath}`;
}

export class TypeScriptExtractor {
  public readonly extractorVersion = "phase1-ts-graph-v1";
  public readonly parserVersion = ts.version;

  public extract(context: ParserContext, sourceText: string): ExtractedFileFact {
    const now = context.now || nowIso();
    const sourceFile = ts.createSourceFile(context.filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForFile(context.filePath));
    const fileId = stableId("file", context.workspaceId, context.filePath);
    const moduleId = stableId("module", context.workspaceId, context.filePath);
    const language = pathToModuleLanguage(context.filePath);
    const warnings: string[] = [];
    const symbols: ExtractedSymbol[] = [];
    const symbolLookup = new Map<string, ExtractedSymbol>();
    const importBindings = new Map<string, { moduleId: string; symbolId: string; modulePath: string }>();
    const localModuleImports = new Map<string, string>();
    const edges: EdgeRecord[] = [];
    const exportedNames = new Set<string>();

    const addEdge = (edge: Omit<EdgeRecord, "id">) => {
      const id = stableId("edge", edge.type, edge.sourceId, edge.targetId, edge.ownerFilePath);
      if (!edges.some((existing) => existing.id === id)) {
        edges.push({ id, ...edge });
      }
    };

    sourceFile.forEachChild((node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const importText = node.moduleSpecifier.text;
        const resolved = resolveLocalImport(context, importText);
        if (!resolved) {
          return;
        }

        const targetModuleId = stableId("module", context.workspaceId, resolved);
        localModuleImports.set(importText, targetModuleId);
        addEdge({
          workspaceId: context.workspaceId,
          sourceId: moduleId,
          sourceType: "module",
          targetId: targetModuleId,
          targetType: "module",
          type: "imports",
          ownerFilePath: context.filePath,
          confidence: 1,
          metadata: { importText, resolvedPath: resolved },
          createdAt: now,
          updatedAt: now
        });

        const bindings = node.importClause;
        if (bindings?.name) {
          importBindings.set(bindings.name.text, {
            moduleId: targetModuleId,
            symbolId: stableId("symbol", context.workspaceId, resolved, "default"),
            modulePath: resolved
          });
        }

        if (bindings?.namedBindings && ts.isNamedImports(bindings.namedBindings)) {
          for (const element of bindings.namedBindings.elements) {
            importBindings.set(element.name.text, {
              moduleId: targetModuleId,
              symbolId: stableId("symbol", context.workspaceId, resolved, element.propertyName?.text ?? element.name.text),
              modulePath: resolved
            });
          }
        }
      }
    });

    const collectDeclaration = (node: ts.Node) => {
      const kind = symbolKindForNode(node);
      const name = nodeName(node);
      if (!kind || !name) {
        return;
      }

      const symbol: ExtractedSymbol = {
        id: stableId("symbol", context.workspaceId, context.filePath, name),
        localName: name,
        qualifiedName: `${context.relativePath}#${name}`,
        kind,
        exported: isNodeExported(node),
        signature: node.getText(sourceFile).split("\n")[0]?.slice(0, 180),
        range: {
          start: toRangePosition(sourceFile, node.getStart(sourceFile)),
          end: toRangePosition(sourceFile, node.getEnd())
        },
        summary: summarizeSymbol(kind, name, context)
      };

      symbols.push(symbol);
      symbolLookup.set(symbol.localName, symbol);
      if (symbol.exported) {
        exportedNames.add(symbol.localName);
      }
    };

    const declarationVisitor = (node: ts.Node): void => {
      collectDeclaration(node);
      ts.forEachChild(node, declarationVisitor);
    };

    declarationVisitor(sourceFile);

    addEdge({
      workspaceId: context.workspaceId,
      sourceId: fileId,
      sourceType: "file",
      targetId: moduleId,
      targetType: "module",
      type: "contains",
      ownerFilePath: context.filePath,
      confidence: 1,
      createdAt: now,
      updatedAt: now
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
        createdAt: now,
        updatedAt: now
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
        createdAt: now,
        updatedAt: now
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
          confidence: 1,
          createdAt: now,
          updatedAt: now
        });
      }
    }

    const symbolStack: ExtractedSymbol[] = [];
    const referenceVisitor = (node: ts.Node): void => {
      const localSymbol = nodeName(node) ? symbolLookup.get(nodeName(node)!) : undefined;
      const shouldPush = Boolean(localSymbol) && (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node));

      if (shouldPush && localSymbol) {
        symbolStack.push(localSymbol);
      }

      const currentSymbol = symbolStack.at(-1);
      if (currentSymbol && ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : undefined;
        if (callee) {
          const localTarget = symbolLookup.get(callee);
          const importedTarget = importBindings.get(callee);
          if (localTarget) {
            addEdge({
              workspaceId: context.workspaceId,
              sourceId: currentSymbol.id,
              sourceType: "symbol",
              targetId: localTarget.id,
              targetType: "symbol",
              type: "calls",
              ownerFilePath: context.filePath,
              confidence: 0.95,
              createdAt: now,
              updatedAt: now
            });
          } else if (importedTarget) {
            addEdge({
              workspaceId: context.workspaceId,
              sourceId: currentSymbol.id,
              sourceType: "symbol",
              targetId: importedTarget.symbolId,
              targetType: "symbol",
              type: "calls",
              ownerFilePath: context.filePath,
              confidence: 0.65,
              metadata: { targetModuleId: importedTarget.moduleId, targetModulePath: importedTarget.modulePath },
              createdAt: now,
              updatedAt: now
            });
          }
        }
      }

      if (currentSymbol && ts.isIdentifier(node)) {
        const localTarget = symbolLookup.get(node.text);
        const importedTarget = importBindings.get(node.text);
        if (localTarget && localTarget.id !== currentSymbol.id) {
          addEdge({
            workspaceId: context.workspaceId,
            sourceId: currentSymbol.id,
            sourceType: "symbol",
            targetId: localTarget.id,
            targetType: "symbol",
            type: "references",
            ownerFilePath: context.filePath,
            confidence: 0.9,
            createdAt: now,
            updatedAt: now
          });
        } else if (importedTarget) {
          addEdge({
            workspaceId: context.workspaceId,
            sourceId: currentSymbol.id,
            sourceType: "symbol",
            targetId: importedTarget.symbolId,
            targetType: "symbol",
            type: "references",
            ownerFilePath: context.filePath,
            confidence: 0.6,
            metadata: { targetModuleId: importedTarget.moduleId, targetModulePath: importedTarget.modulePath },
            createdAt: now,
            updatedAt: now
          });
        }
      }

      ts.forEachChild(node, referenceVisitor);

      if (shouldPush) {
        symbolStack.pop();
      }
    };

    referenceVisitor(sourceFile);

    if (symbols.length === 0) {
      warnings.push(`No extractable top-level symbols found in ${context.relativePath}.`);
    }

    const fileSummary = `Module ${context.relativePath} exports ${exportedNames.size} symbol(s) and imports ${localModuleImports.size} local module(s).`;

    return {
      file: {
        id: fileId,
        workspaceId: context.workspaceId,
        repoId: context.repoId,
        packageId: context.packageId,
        path: context.filePath,
        language,
        summary: fileSummary,
        authored: true,
        hash: context.hash,
        updatedAt: now
      },
      module: {
        id: moduleId,
        workspaceId: context.workspaceId,
        fileId,
        packageId: context.packageId,
        canonicalPath: context.filePath,
        language,
        summary: fileSummary,
        publicExports: [...exportedNames],
        inboundDependencyCount: 0,
        outboundDependencyCount: localModuleImports.size,
        updatedAt: now
      },
      symbols,
      edges,
      summary: {
        id: stableId("summary", context.workspaceId, moduleId),
        workspaceId: context.workspaceId,
        entityId: moduleId,
        entityType: "module",
        summary: fileSummary,
        source: "language-ts",
        updatedAt: now
      },
      warnings
    };
  }
}

export class TypeScriptLanguageAdapter implements LanguageAdapter<ExtractedFileFact> {
  public readonly id = "language-ts";
  public readonly displayName = "TypeScript / JavaScript";

  public constructor(private readonly extractor = new TypeScriptExtractor()) {}

  public supports(candidate: CandidateFile, classification: FileClassification): boolean {
    return (
      (classification.kind === "source" || classification.kind === "test") &&
      ["typescript", "javascript"].includes(classification.language ?? pathToModuleLanguage(candidate.absPath))
    );
  }

  public extract(context: ParserContextV2, sourceText: string) {
    const parserContext: ParserContext = {
      workspaceId: context.workspaceId,
      workspaceRoot: context.workspaceRoot,
      repoId: context.repoId,
      packageId: context.packageId,
      filePath: context.filePath,
      relativePath: context.relativePath,
      hash: context.hash,
      now: context.now
    };

    return {
      facts: this.extractor.extract(parserContext, sourceText),
      warnings: []
    };
  }
}
