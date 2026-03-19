import path from "node:path";
import ts from "typescript";
import { resolveLocalModulePath, stableId, toRelativePath } from "@local-engineering-brain/shared-utils";
function toRangePosition(sourceFile, position) {
    const next = sourceFile.getLineAndCharacterOfPosition(position);
    return {
        line: next.line + 1,
        column: next.character + 1
    };
}
function scriptKindForFile(filePath) {
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
function firstArgumentText(node) {
    const first = node.arguments[0];
    if (first && ts.isStringLiteralLike(first)) {
        return first.text;
    }
    return undefined;
}
function callName(node) {
    if (ts.isIdentifier(node.expression)) {
        return node.expression.text;
    }
    if (ts.isPropertyAccessExpression(node.expression)) {
        const segments = [];
        let current = node.expression;
        while (ts.isPropertyAccessExpression(current)) {
            segments.unshift(current.name.text);
            current = current.expression;
        }
        if (ts.isIdentifier(current)) {
            segments.unshift(current.text);
        }
        return segments.join(".");
    }
    return "";
}
function detectFramework(sourceText, sourceFile) {
    let framework = "unknown";
    sourceFile.forEachChild((node) => {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) {
            return;
        }
        const specifier = node.moduleSpecifier.text;
        if (specifier === "@playwright/test") {
            framework = "playwright";
        }
        else if (specifier === "vitest") {
            framework = "vitest";
        }
        else if (specifier === "@jest/globals" || specifier === "jest") {
            framework = "jest";
        }
    });
    if (framework !== "unknown") {
        return framework;
    }
    if (/\bdescribe\s*\(/.test(sourceText) || /\bit\s*\(/.test(sourceText) || /\btest\s*\(/.test(sourceText)) {
        return "jest";
    }
    return "unknown";
}
export function isLikelyTestFile(relativePath) {
    return /(^|\/)(tests?|__tests__)\//.test(relativePath) || /\.(test|spec)\.[jt]sx?$/.test(relativePath);
}
export class TestIntelExtractor {
    extract(context, sourceText) {
        if (!isLikelyTestFile(context.relativePath)) {
            return undefined;
        }
        const sourceFile = ts.createSourceFile(context.filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKindForFile(context.filePath));
        const framework = detectFramework(sourceText, sourceFile);
        const suiteId = stableId("test-suite", context.workspaceId, context.filePath);
        const suiteName = path.basename(context.relativePath);
        const importedModules = new Set();
        const cases = [];
        const warnings = [];
        sourceFile.forEachChild((node) => {
            if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
                const resolved = resolveLocalModulePath(context.filePath, node.moduleSpecifier.text);
                if (resolved) {
                    importedModules.add(resolved);
                }
            }
        });
        const visit = (node, suiteStack) => {
            if (ts.isCallExpression(node)) {
                const name = callName(node);
                const title = firstArgumentText(node);
                if ((name === "describe" || name === "test.describe") && title) {
                    const callback = node.arguments[1];
                    const nextStack = [...suiteStack, title];
                    if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callback.body) {
                        ts.forEachChild(callback.body, (child) => visit(child, nextStack));
                    }
                    return;
                }
                const isTestCall = name === "it" ||
                    name === "test" ||
                    name === "specify" ||
                    name === "it.only" ||
                    name === "it.skip" ||
                    name === "test.only" ||
                    name === "test.skip";
                if (isTestCall && title) {
                    const resolvedSuiteName = suiteStack.length > 0 ? suiteStack.join(" > ") : suiteName;
                    const start = toRangePosition(sourceFile, node.getStart(sourceFile));
                    const end = toRangePosition(sourceFile, node.getEnd());
                    cases.push({
                        id: stableId("test-case", context.workspaceId, context.filePath, resolvedSuiteName, title, String(start.line)),
                        workspaceId: context.workspaceId,
                        suiteId,
                        filePath: context.filePath,
                        name: title,
                        range: { start, end },
                        updatedAt: context.now
                    });
                }
            }
            ts.forEachChild(node, (child) => visit(child, suiteStack));
        };
        visit(sourceFile, []);
        if (cases.length === 0) {
            const start = { line: 1, column: 1 };
            const end = toRangePosition(sourceFile, sourceText.length);
            cases.push({
                id: stableId("test-case", context.workspaceId, context.filePath, suiteName, "file"),
                workspaceId: context.workspaceId,
                suiteId,
                filePath: context.filePath,
                name: suiteName,
                range: { start, end },
                updatedAt: context.now
            });
            warnings.push(`Fell back to file-level test case detection for ${toRelativePath(context.workspaceRoot, context.filePath)}.`);
        }
        const edges = [];
        const addEdge = (edge) => {
            const id = stableId("edge", edge.type, edge.sourceId, edge.targetId, edge.ownerFilePath);
            if (!edges.some((existing) => existing.id === id)) {
                edges.push({ id, ...edge });
            }
        };
        for (const testCase of cases) {
            for (const modulePath of importedModules) {
                addEdge({
                    workspaceId: context.workspaceId,
                    sourceId: testCase.id,
                    sourceType: "test_case",
                    targetId: stableId("module", context.workspaceId, modulePath),
                    targetType: "module",
                    type: "tests",
                    ownerFilePath: context.filePath,
                    confidence: 0.9,
                    metadata: { modulePath },
                    createdAt: context.now,
                    updatedAt: context.now
                });
            }
        }
        return {
            suite: {
                id: suiteId,
                workspaceId: context.workspaceId,
                filePath: context.filePath,
                framework,
                name: suiteName,
                updatedAt: context.now
            },
            testCases: cases,
            edges,
            warnings
        };
    }
}
//# sourceMappingURL=index.js.map