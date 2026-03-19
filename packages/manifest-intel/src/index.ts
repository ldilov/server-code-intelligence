import path from "node:path";
import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import type { WorkspaceHint } from "@local-engineering-brain/language-core";
import { normalizeSlashes } from "@local-engineering-brain/language-core";
import { defaultManifestDiscoveryPatterns } from "@local-engineering-brain/shared-utils";

function relativeToWorkspace(workspaceRoot: string, absolutePath: string): string {
  const relative = normalizeSlashes(path.relative(workspaceRoot, absolutePath));
  return relative === "." ? "" : relative;
}

function joinRelative(workspaceRoot: string, baseDirAbs: string, child: string): string {
  return relativeToWorkspace(workspaceRoot, path.join(baseDirAbs, child));
}

function analyzePackageJson(workspaceRoot: string, manifestPath: string, sourceText: string): WorkspaceHint | undefined {
  try {
    const parsed = JSON.parse(sourceText) as {
      workspaces?: string[] | { packages?: string[] };
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const baseDirAbs = path.dirname(manifestPath);
    const workspaceEntries = Array.isArray(parsed.workspaces)
      ? parsed.workspaces
      : Array.isArray(parsed.workspaces?.packages)
        ? parsed.workspaces.packages
        : [];

    const trimmedWorkspaces = workspaceEntries
      .map((entry) => entry.replace(/[\\/]*\*.*$/, ""))
      .filter((entry) => entry.length > 0)
      .map((entry) => joinRelative(workspaceRoot, baseDirAbs, entry));

    const deps = Object.assign({}, parsed.dependencies ?? {}, parsed.devDependencies ?? {});
    const languages = ["javascript", deps.typescript ? "typescript" : undefined].filter(Boolean) as string[];

    return {
      originPath: relativeToWorkspace(workspaceRoot, manifestPath),
      sourceRoots: [joinRelative(workspaceRoot, baseDirAbs, "src"), joinRelative(workspaceRoot, baseDirAbs, "app")].filter(Boolean),
      testRoots: [joinRelative(workspaceRoot, baseDirAbs, "test"), joinRelative(workspaceRoot, baseDirAbs, "tests"), joinRelative(workspaceRoot, baseDirAbs, "spec")].filter(Boolean),
      packageRoots: [relativeToWorkspace(workspaceRoot, baseDirAbs), ...trimmedWorkspaces].filter(Boolean),
      generatedDirectories: [joinRelative(workspaceRoot, baseDirAbs, "dist"), joinRelative(workspaceRoot, baseDirAbs, "build"), joinRelative(workspaceRoot, baseDirAbs, ".next")].filter(Boolean),
      ignoredDirectories: [joinRelative(workspaceRoot, baseDirAbs, "node_modules"), joinRelative(workspaceRoot, baseDirAbs, "dist"), joinRelative(workspaceRoot, baseDirAbs, "build")].filter(Boolean),
      languages,
      buildSystems: ["node"],
      metadata: {
        workspaceCount: workspaceEntries.length,
        manifestKind: "package.json"
      }
    };
  } catch {
    return undefined;
  }
}

function analyzePyprojectToml(workspaceRoot: string, manifestPath: string, sourceText: string): WorkspaceHint {
  const baseDirAbs = path.dirname(manifestPath);
  const buildBackend = /build-backend\s*=\s*"([^"]+)"/.exec(sourceText)?.[1];
  const usesSrcLayout = /^\s*packages\s*=|^\s*package-dir\s*=|^\s*where\s*=\s*\["src"\]/m.test(sourceText);

  return {
    originPath: relativeToWorkspace(workspaceRoot, manifestPath),
    sourceRoots: [joinRelative(workspaceRoot, baseDirAbs, usesSrcLayout ? "src" : "")].filter(Boolean),
    testRoots: [joinRelative(workspaceRoot, baseDirAbs, "tests")].filter(Boolean),
    packageRoots: [relativeToWorkspace(workspaceRoot, baseDirAbs)].filter(Boolean),
    generatedDirectories: [joinRelative(workspaceRoot, baseDirAbs, "dist"), joinRelative(workspaceRoot, baseDirAbs, "build")].filter(Boolean),
    ignoredDirectories: [joinRelative(workspaceRoot, baseDirAbs, ".venv"), joinRelative(workspaceRoot, baseDirAbs, "dist"), joinRelative(workspaceRoot, baseDirAbs, "build")].filter(Boolean),
    languages: ["python"],
    buildSystems: [buildBackend ?? "python"],
    metadata: { manifestKind: "pyproject.toml", buildBackend }
  };
}

function analyzeCargoToml(workspaceRoot: string, manifestPath: string): WorkspaceHint {
  const baseDirAbs = path.dirname(manifestPath);
  return {
    originPath: relativeToWorkspace(workspaceRoot, manifestPath),
    sourceRoots: [joinRelative(workspaceRoot, baseDirAbs, "src")].filter(Boolean),
    testRoots: [joinRelative(workspaceRoot, baseDirAbs, "tests"), joinRelative(workspaceRoot, baseDirAbs, "benches")].filter(Boolean),
    packageRoots: [relativeToWorkspace(workspaceRoot, baseDirAbs)].filter(Boolean),
    generatedDirectories: [joinRelative(workspaceRoot, baseDirAbs, "target")].filter(Boolean),
    ignoredDirectories: [joinRelative(workspaceRoot, baseDirAbs, "target")].filter(Boolean),
    languages: ["rust"],
    buildSystems: ["cargo"],
    metadata: { manifestKind: "Cargo.toml" }
  };
}

function analyzeGoMod(workspaceRoot: string, manifestPath: string): WorkspaceHint {
  const baseDirAbs = path.dirname(manifestPath);
  return {
    originPath: relativeToWorkspace(workspaceRoot, manifestPath),
    sourceRoots: [joinRelative(workspaceRoot, baseDirAbs, "cmd"), joinRelative(workspaceRoot, baseDirAbs, "pkg"), joinRelative(workspaceRoot, baseDirAbs, "internal")].filter(Boolean),
    testRoots: [joinRelative(workspaceRoot, baseDirAbs, "pkg"), joinRelative(workspaceRoot, baseDirAbs, "internal")].filter(Boolean),
    packageRoots: [relativeToWorkspace(workspaceRoot, baseDirAbs)].filter(Boolean),
    generatedDirectories: [joinRelative(workspaceRoot, baseDirAbs, "vendor")].filter(Boolean),
    ignoredDirectories: [joinRelative(workspaceRoot, baseDirAbs, "vendor")].filter(Boolean),
    languages: ["go"],
    buildSystems: ["go"],
    metadata: { manifestKind: "go.mod" }
  };
}

function analyzeCsproj(workspaceRoot: string, manifestPath: string): WorkspaceHint {
  const baseDirAbs = path.dirname(manifestPath);
  const isTestProject = /test/i.test(path.basename(manifestPath));
  return {
    originPath: relativeToWorkspace(workspaceRoot, manifestPath),
    sourceRoots: [relativeToWorkspace(workspaceRoot, baseDirAbs)].filter(Boolean),
    testRoots: isTestProject ? [relativeToWorkspace(workspaceRoot, baseDirAbs)].filter(Boolean) : [],
    packageRoots: [relativeToWorkspace(workspaceRoot, baseDirAbs)].filter(Boolean),
    generatedDirectories: [joinRelative(workspaceRoot, baseDirAbs, "obj"), joinRelative(workspaceRoot, baseDirAbs, "bin")].filter(Boolean),
    ignoredDirectories: [joinRelative(workspaceRoot, baseDirAbs, "obj"), joinRelative(workspaceRoot, baseDirAbs, "bin"), joinRelative(workspaceRoot, baseDirAbs, "TestResults")].filter(Boolean),
    languages: ["csharp"],
    buildSystems: ["dotnet", "msbuild"],
    metadata: { manifestKind: "csproj", isTestProject }
  };
}

export async function collectManifestHints(workspaceRoot: string): Promise<WorkspaceHint[]> {
  const absolutePaths = await fg([...defaultManifestDiscoveryPatterns], {
    cwd: workspaceRoot,
    absolute: true,
    onlyFiles: true,
    dot: true,
    suppressErrors: true
  });

  const hints: WorkspaceHint[] = [];
  for (const absolutePath of absolutePaths) {
    const normalizedPath = normalizeSlashes(absolutePath);
    const fileName = path.basename(normalizedPath).toLowerCase();
    const sourceText = await readFile(normalizedPath, "utf8").catch(() => "");

    const hint =
      fileName === "package.json" ? analyzePackageJson(workspaceRoot, normalizedPath, sourceText) :
      fileName === "pyproject.toml" ? analyzePyprojectToml(workspaceRoot, normalizedPath, sourceText) :
      fileName === "cargo.toml" ? analyzeCargoToml(workspaceRoot, normalizedPath) :
      fileName === "go.mod" ? analyzeGoMod(workspaceRoot, normalizedPath) :
      fileName.endsWith(".csproj") ? analyzeCsproj(workspaceRoot, normalizedPath) :
      undefined;

    if (hint) {
      hints.push(hint);
    }
  }

  return hints;
}
