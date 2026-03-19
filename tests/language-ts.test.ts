import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TypeScriptExtractor } from "@local-engineering-brain/language-ts";

const fixturePath = path.resolve("tests/fixtures/sample-repo/src/api/checkout-service.ts");

describe("TypeScriptExtractor", () => {
  it("extracts symbols and local import edges", async () => {
    const extractor = new TypeScriptExtractor();
    const sourceText = await readFile(fixturePath, "utf8");
    const fact = extractor.extract(
      {
        workspaceId: "workspace_test",
        workspaceRoot: path.resolve("tests/fixtures/sample-repo"),
        repoId: "repo_test",
        packageId: "package_test",
        filePath: fixturePath.replace(/\\/g, "/"),
        relativePath: "src/api/checkout-service.ts",
        hash: "hash_test",
        now: new Date().toISOString()
      },
      sourceText
    );

    assert.ok(fact.module.publicExports.includes("calculateTotal"));
    assert.ok(fact.edges.some((edge) => edge.type === "imports" && edge.targetType === "module"));
    assert.ok(fact.edges.some((edge) => edge.type === "calls"));
  });
});
