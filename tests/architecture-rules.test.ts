import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { EdgeRecord, ModuleRecord } from "@local-engineering-brain/core-types";
import { evaluateArchitectureRules, loadArchitectureRules } from "@local-engineering-brain/architecture-rules";

const createdDirectories: string[] = [];

afterEach(async () => {
  while (createdDirectories.length > 0) {
    const current = createdDirectories.pop();
    if (current) {
      await rm(current, { recursive: true, force: true });
    }
  }
});

describe("architecture-rules", () => {
  it("loads YAML rules and evaluates violations with exceptions", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "leb-arch-"));
    createdDirectories.push(workspaceRoot);
    await writeFile(
      path.join(workspaceRoot, "architecture-rules.yaml"),
      [
        "generatedPatterns:",
        "  - src/generated/**",
        "rules:",
        "  - id: api-boundary",
        "    kind: forbid",
        "    from: src/api/**",
        "    to: src/lib/**",
        "    severity: error",
        "    except:",
        "      - from: src/api/allowed/**"
      ].join("\n")
    );

    const config = await loadArchitectureRules(workspaceRoot);
    assert.equal(config.rules.length, 1);
    assert.ok(config.generatedPatterns?.includes("src/generated/**"));
    assert.ok(config.generatedPatterns?.includes("**/__generated__/**"));
    assert.ok(config.generatedPatterns?.includes("**/*.generated.*"));

    const modules: ModuleRecord[] = [
      {
        id: "module_api",
        workspaceId: "workspace_test",
        fileId: "file_api",
        canonicalPath: path.join(workspaceRoot, "src/api/checkout-service.ts").replace(/\\/g, "/"),
        language: "typescript",
        summary: "",
        publicExports: [],
        inboundDependencyCount: 0,
        outboundDependencyCount: 1,
        updatedAt: new Date().toISOString()
      },
      {
        id: "module_lib",
        workspaceId: "workspace_test",
        fileId: "file_lib",
        canonicalPath: path.join(workspaceRoot, "src/lib/math.ts").replace(/\\/g, "/"),
        language: "typescript",
        summary: "",
        publicExports: [],
        inboundDependencyCount: 1,
        outboundDependencyCount: 0,
        updatedAt: new Date().toISOString()
      }
    ];
    const edges: EdgeRecord[] = [
      {
        id: "edge_import",
        workspaceId: "workspace_test",
        sourceId: "module_api",
        sourceType: "module",
        targetId: "module_lib",
        targetType: "module",
        type: "imports",
        ownerFilePath: modules[0]!.canonicalPath,
        confidence: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ];

    const violations = evaluateArchitectureRules({
      workspaceId: "workspace_test",
      workspaceRoot,
      modules,
      importEdges: edges,
      config
    });

    assert.equal(violations.length, 1);
    assert.equal(violations[0]?.ruleId, "api-boundary");
  });
});
