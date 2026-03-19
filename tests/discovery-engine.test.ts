import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  FileClassifier,
  createDefaultDetectors,
  createRuntimeConventions,
  discoverCandidateFiles,
  readCandidateText
} from "@local-engineering-brain/discovery-engine";
import { collectManifestHints } from "@local-engineering-brain/manifest-intel";

const createdDirectories: string[] = [];

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "leb-discovery-"));
  createdDirectories.push(root);
  return root.replace(/\\/g, "/");
}

async function writeWorkspaceFile(workspaceRoot: string, relativePath: string, content: string): Promise<void> {
  const targetPath = path.join(workspaceRoot, relativePath);
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content);
}

afterEach(async () => {
  while (createdDirectories.length > 0) {
    const current = createdDirectories.pop();
    if (current) {
      await rm(current, { recursive: true, force: true });
    }
  }
});

describe("discovery engine", () => {
  it("infers csharp workspace hints from csproj manifests", async () => {
    const workspaceRoot = await createWorkspace();
    await writeWorkspaceFile(
      workspaceRoot,
      "src/App/App.csproj",
      "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>"
    );

    const hints = await collectManifestHints(workspaceRoot);
    const csharpHint = hints.find((hint) => hint.metadata?.manifestKind === "csproj");

    assert.ok(csharpHint);
    assert.ok(csharpHint.languages?.includes("csharp"));
    assert.deepEqual(csharpHint.packageRoots, ["src/App"]);
    assert.ok(csharpHint.ignoredDirectories?.includes("src/App/obj"));
  });

  it("classifies source, test, log, doc, generated, and manifest files across the workspace", async () => {
    const workspaceRoot = await createWorkspace();
    await writeWorkspaceFile(
      workspaceRoot,
      "src/App/App.csproj",
      "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>"
    );
    await writeWorkspaceFile(workspaceRoot, "src/App/Program.cs", "namespace Demo; public class Program { public static void Main() {} }");
    await writeWorkspaceFile(workspaceRoot, "src/App/ProgramTests.cs", "using Xunit; public class ProgramTests { [Fact] public void Works() {} }");
    await writeWorkspaceFile(workspaceRoot, "docs/ADR-0001.md", "# Decision\n");
    await writeWorkspaceFile(workspaceRoot, "logs/api/app.log", "2026-03-19T10:00:05.000Z ERROR api Payment authorization failed");
    await writeWorkspaceFile(workspaceRoot, "Generated/Client.g.cs", "// auto-generated\nnamespace Demo.Generated; public partial class Client {}");

    const hints = await collectManifestHints(workspaceRoot);
    const runtimeConventions = createRuntimeConventions(hints);
    const classifier = new FileClassifier(createDefaultDetectors());
    const detectionContext = {
      workspaceRoot,
      runtimeConventions,
      workspaceHints: hints
    };
    const candidates = await discoverCandidateFiles(workspaceRoot, runtimeConventions);
    const byRelativePath = new Map<string, ReturnType<FileClassifier["classify"]>>();

    for (const candidate of candidates) {
      const sourceText = await readCandidateText(candidate, runtimeConventions);
      byRelativePath.set(candidate.relPath, classifier.classify(candidate, sourceText, detectionContext));
    }

    assert.equal(byRelativePath.get("src/App/App.csproj")?.kind, "manifest");
    assert.equal(byRelativePath.get("src/App/Program.cs")?.kind, "source");
    assert.equal(byRelativePath.get("src/App/Program.cs")?.language, "csharp");
    assert.equal(byRelativePath.get("src/App/ProgramTests.cs")?.kind, "test");
    assert.equal(byRelativePath.get("docs/ADR-0001.md")?.kind, "doc");
    assert.equal(byRelativePath.get("logs/api/app.log")?.kind, "log");
    assert.equal(byRelativePath.get("Generated/Client.g.cs")?.kind, "generated");
  });
});
