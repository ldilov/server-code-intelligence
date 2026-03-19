import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkspaceModuleCatalog } from "@local-engineering-brain/language-core";
import { LuaLanguageAdapter } from "@local-engineering-brain/language-lua";

describe("LuaLanguageAdapter", () => {
  it("extracts wow-style module tables and methods", () => {
    const adapter = new LuaLanguageAdapter();
    const extraction = adapter.extract(
      {
        workspaceId: "workspace_test",
        workspaceRoot: "D:/workspace",
        repoId: "repo_test",
        packageId: "package_test",
        filePath: "D:/workspace/AddOns/MyAddon/SessionClassifier.lua",
        relativePath: "AddOns/MyAddon/SessionClassifier.lua",
        hash: "hash_test",
        now: new Date().toISOString(),
        classification: {
          kind: "source",
          language: "lua",
          roles: [],
          tags: [],
          generated: false,
          confidence: 0.95,
          reasons: ["extension .lua maps to lua"],
          signals: []
        },
        moduleIdentity: {
          moduleIdSeed: "D:/workspace/AddOns/MyAddon/SessionClassifier.lua",
          canonicalPath: "D:/workspace/AddOns/MyAddon/SessionClassifier.lua",
          displayPath: "AddOns/MyAddon/SessionClassifier.lua",
          moduleKind: "file",
          tags: []
        }
      },
      [
        "local SessionClassifier = {}",
        "",
        "function SessionClassifier:ResolveContext()",
        "  return self:IsWorldPvpEvent()",
        "end",
        "",
        "function SessionClassifier:IsWorldPvpEvent()",
        "  return false",
        "end",
        "",
        "return SessionClassifier"
      ].join("\n")
    );

    const symbolNames = extraction.facts.symbols.map((symbol) => symbol.qualifiedName);

    assert.ok(symbolNames.some((name) => name.endsWith("#SessionClassifier")));
    assert.ok(symbolNames.some((name) => name.endsWith("#SessionClassifier.ResolveContext")));
    assert.ok(symbolNames.some((name) => name.endsWith("#SessionClassifier.IsWorldPvpEvent")));
    assert.ok(
      extraction.facts.edges.some(
        (edge) =>
          edge.type === "calls" &&
          edge.sourceType === "symbol" &&
          edge.targetType === "symbol"
      )
    );
    assert.ok(extraction.facts.module.publicExports.includes("SessionClassifier"));
    assert.ok(extraction.facts.module.publicExports.includes("ResolveContext"));
    assert.ok(extraction.facts.module.summary.includes("indexes 3 symbol"));
  });

  it("resolves runtime-linked module lookups through the workspace catalog", () => {
    const adapter = new LuaLanguageAdapter();
    const extraction = adapter.extract(
      {
        workspaceId: "workspace_test",
        workspaceRoot: "D:/workspace",
        repoId: "repo_test",
        packageId: "package_test",
        filePath: "D:/workspace/AddOns/MyAddon/CombatTracker.lua",
        relativePath: "AddOns/MyAddon/CombatTracker.lua",
        hash: "hash_test",
        now: new Date().toISOString(),
        classification: {
          kind: "source",
          language: "lua",
          roles: [],
          tags: [],
          generated: false,
          confidence: 0.95,
          reasons: ["extension .lua maps to lua"],
          signals: []
        },
        moduleIdentity: {
          moduleIdSeed: "D:/workspace/AddOns/MyAddon/CombatTracker.lua",
          canonicalPath: "D:/workspace/AddOns/MyAddon/CombatTracker.lua",
          displayPath: "AddOns/MyAddon/CombatTracker.lua",
          moduleKind: "file",
          tags: []
        },
        workspaceModuleCatalog: createWorkspaceModuleCatalog([
          {
            path: "D:/workspace/AddOns/MyAddon/CombatTracker.lua",
            relativePath: "AddOns/MyAddon/CombatTracker.lua",
            language: "lua"
          },
          {
            path: "D:/workspace/AddOns/MyAddon/SpellAttributionPipeline.lua",
            relativePath: "AddOns/MyAddon/SpellAttributionPipeline.lua",
            language: "lua"
          }
        ])
      },
      [
        "local CombatTracker = {}",
        "local _, ns = ...",
        "",
        "function CombatTracker:BuildSpellSource()",
        "  local pipeline = ns.Addon:GetModule(\"SpellAttributionPipeline\")",
        "  return pipeline",
        "end",
        "",
        "return CombatTracker"
      ].join("\n")
    );

    const importEdge = extraction.facts.edges.find((edge) => edge.type === "imports");

    assert.equal(importEdge?.metadata?.resolvedPath, "D:/workspace/AddOns/MyAddon/SpellAttributionPipeline.lua");
    assert.equal(extraction.facts.module.outboundDependencyCount, 1);
    assert.match(extraction.facts.module.summary, /1 module dependency link/);
  });
});
