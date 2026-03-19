import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { GraphEngine } from "@local-engineering-brain/graph-engine";
import { WorkspaceIndexer } from "@local-engineering-brain/indexer";
import { RetrievalEngine } from "@local-engineering-brain/retrieval-engine";
import { BrainDatabase } from "@local-engineering-brain/storage-sqlite";
import { registerWorkspace, resolveAppPaths } from "@local-engineering-brain/workspace-manager";

const createdDirectories: string[] = [];

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "leb-polyglot-"));
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

describe("polyglot indexing", () => {
  it("indexes csharp files as evidence-backed modules while keeping retrieval functional", async () => {
    const workspaceRoot = await createWorkspace();
    await writeWorkspaceFile(
      workspaceRoot,
      "src/App/App.csproj",
      "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>"
    );
    await writeWorkspaceFile(
      workspaceRoot,
      "src/App/Program.cs",
      "namespace Demo; public class Program { public static void Main(string[] args) { System.Console.WriteLine(\"hi\"); } }"
    );
    await writeWorkspaceFile(workspaceRoot, "docs/ARCHITECTURE.md", "# Architecture\n");

    const appPaths = resolveAppPaths(path.join(workspaceRoot, ".leb-data"));
    const registration = await registerWorkspace(appPaths, workspaceRoot, "polyglot");
    const database = new BrainDatabase(appPaths.databasePath);
    database.init();
    database.upsertWorkspace(registration.workspace);

    const indexer = new WorkspaceIndexer(database);
    const indexResult = await indexer.indexWorkspace(registration.workspace);
    const retrieval = new RetrievalEngine(database, new GraphEngine(database));

    assert.ok(indexResult.filesDiscovered >= 3);
    assert.ok(!indexResult.warnings.some((warning) => warning.includes("Program.cs")));

    const csharpModule = retrieval.findModule(registration.workspace.id, "Program.cs");
    assert.equal(csharpModule.structured_data.module?.language, "csharp");
    assert.match(csharpModule.structured_data.module?.summary ?? "", /file-level evidence/i);

    const search = retrieval.searchCode(registration.workspace.id, "Program", 10);
    assert.ok(search.structured_data.hits.some((hit) => hit.path.endsWith("/src/App/Program.cs")));

    database.close();
  });

  it("indexes wow-style lua addon symbols in a non-git workspace and resolves multi-term search", async () => {
    const workspaceRoot = await createWorkspace();
    await writeWorkspaceFile(
      workspaceRoot,
      "AddOns/WorldEvents/SessionClassifier.lua",
      [
        "local SessionClassifier = {}",
        "",
        "function SessionClassifier:ResolveContext()",
        "  if self:IsWorldPvpEvent() then",
        "    return 'world_pvp'",
        "  end",
        "  return 'none'",
        "end",
        "",
        "function SessionClassifier:IsWorldPvpEvent()",
        "  return false",
        "end",
        "",
        "return SessionClassifier"
      ].join("\n")
    );

    const appPaths = resolveAppPaths(path.join(workspaceRoot, ".leb-data"));
    const registration = await registerWorkspace(appPaths, workspaceRoot, "wow-addon");
    const database = new BrainDatabase(appPaths.databasePath);
    database.init();
    database.upsertWorkspace(registration.workspace);

    const indexer = new WorkspaceIndexer(database);
    const indexResult = await indexer.indexWorkspace(registration.workspace);
    const retrieval = new RetrievalEngine(database, new GraphEngine(database));

    assert.ok(indexResult.filesIndexed >= 1);
    assert.ok(indexResult.warnings.some((warning) => warning.includes("not a git repository")) || indexResult.warnings.length === 0);

    const symbolLookup = retrieval.findSymbol(registration.workspace.id, "ResolveContext");
    assert.ok(symbolLookup.structured_data.symbols.some((symbol) => symbol.qualifiedName.endsWith("SessionClassifier.ResolveContext")));

    const search = retrieval.searchCode(
      registration.workspace.id,
      "ResolveContext IsWorldPvpEvent SessionClassifier",
      10
    );
    assert.ok(search.structured_data.hits.length > 0);
    assert.ok(
      search.structured_data.hits.some(
        (hit) =>
          hit.path.endsWith("/AddOns/WorldEvents/SessionClassifier.lua") &&
          (hit.entityType === "module" || hit.entityType === "symbol")
      )
    );

    database.close();
  });

  it("traverses runtime-linked lua addon dependencies through the graph tools", async () => {
    const workspaceRoot = await createWorkspace();
    await writeWorkspaceFile(
      workspaceRoot,
      "AddOns/WorldEvents/ArenaRoundTracker.lua",
      [
        "local ArenaRoundTracker = {}",
        "local _, ns = ...",
        "",
        "function ArenaRoundTracker:BuildCombatTracker()",
        "  return ns.Addon:GetModule(\"CombatTracker\")",
        "end",
        "",
        "return ArenaRoundTracker"
      ].join("\n")
    );
    await writeWorkspaceFile(
      workspaceRoot,
      "AddOns/WorldEvents/CombatTracker.lua",
      [
        "local CombatTracker = {}",
        "local _, ns = ...",
        "",
        "function CombatTracker:BuildSpellPipeline()",
        "  return ns.Addon:GetModule(\"SpellAttributionPipeline\")",
        "end",
        "",
        "return CombatTracker"
      ].join("\n")
    );
    await writeWorkspaceFile(
      workspaceRoot,
      "AddOns/WorldEvents/SpellAttributionPipeline.lua",
      [
        "local SpellAttributionPipeline = {}",
        "",
        "function SpellAttributionPipeline:MergeDamageMeterSource()",
        "  return true",
        "end",
        "",
        "return SpellAttributionPipeline"
      ].join("\n")
    );

    const appPaths = resolveAppPaths(path.join(workspaceRoot, ".leb-data"));
    const registration = await registerWorkspace(appPaths, workspaceRoot, "wow-addon-graph");
    const database = new BrainDatabase(appPaths.databasePath);
    database.init();
    database.upsertWorkspace(registration.workspace);

    const indexer = new WorkspaceIndexer(database);
    await indexer.indexWorkspace(registration.workspace);

    const retrieval = new RetrievalEngine(database, new GraphEngine(database));
    const dependencies = retrieval.getModuleDependencies(registration.workspace.id, "ArenaRoundTracker.lua", 2);
    const pipelineModule = retrieval.findModule(registration.workspace.id, "SpellAttributionPipeline.lua").structured_data.module;

    assert.ok(dependencies.structured_data.modules.some((module) => module.canonicalPath.endsWith("/AddOns/WorldEvents/CombatTracker.lua")));
    assert.ok(dependencies.structured_data.modules.some((module) => module.canonicalPath.endsWith("/AddOns/WorldEvents/SpellAttributionPipeline.lua")));

    assert.ok(pipelineModule);
    const reverseDependencies = retrieval.getReverseDependencies(registration.workspace.id, pipelineModule.id, 2);
    assert.ok(reverseDependencies.structured_data.modules.some((module) => module.canonicalPath.endsWith("/AddOns/WorldEvents/CombatTracker.lua")));
    assert.ok(reverseDependencies.structured_data.modules.some((module) => module.canonicalPath.endsWith("/AddOns/WorldEvents/ArenaRoundTracker.lua")));

    const dependencyPath = retrieval.traceDependencyPath(
      registration.workspace.id,
      "ArenaRoundTracker.lua",
      "SpellAttributionPipeline.lua"
    );
    assert.deepEqual(
      dependencyPath.structured_data.path?.map((modulePath) => path.basename(modulePath)),
      ["ArenaRoundTracker.lua", "CombatTracker.lua", "SpellAttributionPipeline.lua"]
    );

    const blastRadius = retrieval.estimateBlastRadius(registration.workspace.id, "SpellAttributionPipeline.lua", 2);
    assert.ok(blastRadius.structured_data.impacted.some((module) => module.canonicalPath.endsWith("/AddOns/WorldEvents/CombatTracker.lua")));
    assert.ok(blastRadius.structured_data.impacted.some((module) => module.canonicalPath.endsWith("/AddOns/WorldEvents/ArenaRoundTracker.lua")));

    database.close();
  });
});
