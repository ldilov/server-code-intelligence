import { readFile } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TestIntelExtractor } from "@local-engineering-brain/test-intel";

describe("test-intel", () => {
  it("extracts suites, cases, and module test edges from vitest-style files", async () => {
    const workspaceRoot = path.resolve("tests/fixtures/sample-repo");
    const filePath = path.resolve("tests/fixtures/sample-repo/tests/checkout.test.ts").replace(/\\/g, "/");
    const sourceText = await readFile(filePath, "utf8");
    const extractor = new TestIntelExtractor();

    const fact = extractor.extract(
      {
        workspaceId: "workspace_test",
        workspaceRoot,
        repoId: "repo_test",
        packageId: "package_test",
        filePath,
        relativePath: "tests/checkout.test.ts",
        hash: "hash_test",
        now: new Date().toISOString()
      },
      sourceText
    );

    assert.ok(fact);
    assert.equal(fact?.suite.framework, "vitest");
    assert.equal(fact?.testCases.length, 1);
    assert.ok(fact?.edges.some((edge) => edge.type === "tests" && edge.targetType === "module"));
  });
});
