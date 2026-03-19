import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CSharpLanguageAdapter } from "@local-engineering-brain/language-csharp";

describe("CSharpLanguageAdapter", () => {
  it("produces evidence-backed facts for csharp source files", () => {
    const adapter = new CSharpLanguageAdapter();
    const extraction = adapter.extract(
      {
        workspaceId: "workspace_test",
        workspaceRoot: "D:/workspace",
        repoId: "repo_test",
        packageId: "package_test",
        filePath: "D:/workspace/src/App/Program.cs",
        relativePath: "src/App/Program.cs",
        hash: "hash_test",
        now: new Date().toISOString(),
        classification: {
          kind: "source",
          language: "csharp",
          roles: [],
          tags: [],
          generated: false,
          confidence: 0.95,
          reasons: ["extension .cs maps to csharp"],
          signals: []
        },
        moduleIdentity: {
          moduleIdSeed: "D:/workspace/src/App/Program.cs",
          canonicalPath: "D:/workspace/src/App/Program.cs",
          displayPath: "src/App/Program.cs",
          moduleKind: "file",
          tags: []
        }
      },
      "namespace Demo; public class Program { }"
    );

    assert.equal(extraction.facts.file.language, "csharp");
    assert.equal(extraction.facts.module.publicExports.length, 0);
    assert.ok(extraction.facts.summary.summary.includes("file-level evidence"));
  });
});
