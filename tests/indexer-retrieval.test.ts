import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { GraphEngine } from "@local-engineering-brain/graph-engine";
import { WorkspaceIndexer } from "@local-engineering-brain/indexer";
import { RetrievalEngine } from "@local-engineering-brain/retrieval-engine";
import { BrainDatabase } from "@local-engineering-brain/storage-sqlite";
import { registerWorkspace, resolveAppPaths } from "@local-engineering-brain/workspace-manager";

const createdDirectories: string[] = [];

async function createFixtureWorkspace() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "leb-fixture-"));
  createdDirectories.push(tempRoot);
  await cp(path.resolve("tests/fixtures/sample-repo"), tempRoot, { recursive: true });
  return tempRoot.replace(/\\/g, "/");
}

afterEach(async () => {
  while (createdDirectories.length > 0) {
    const current = createdDirectories.pop();
    if (current) {
      await rm(current, { recursive: true, force: true });
    }
  }
});

describe("indexer + retrieval", () => {
  it("indexes a workspace and resolves module dependencies", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    const appPaths = resolveAppPaths(path.join(workspaceRoot, ".leb-data"));
    const registration = await registerWorkspace(appPaths, workspaceRoot, "fixture");
    const database = new BrainDatabase(appPaths.databasePath);
    database.init();
    database.upsertWorkspace(registration.workspace);

    const indexer = new WorkspaceIndexer(database);
    const indexResult = await indexer.indexWorkspace(registration.workspace);
    const graph = new GraphEngine(database);
    const retrieval = new RetrievalEngine(database, graph);

    assert.ok(indexResult.filesDiscovered >= 3);

    const moduleResult = retrieval.findModule(registration.workspace.id, "checkout-service.ts");
    assert.match(moduleResult.structured_data.module?.canonicalPath ?? "", /checkout-service\.ts/);

    const dependencyResult = retrieval.getModuleDependencies(registration.workspace.id, "checkout-service.ts", 2);
    assert.ok(dependencyResult.structured_data.modules.some((module) => module.canonicalPath.endsWith("/src/lib/math.ts")));

    database.close();
  });

  it("summarizes branch changes when the workspace is a git repository", async () => {
    const workspaceRoot = await createFixtureWorkspace();
    try {
      execFileSync("git", ["init"], { cwd: workspaceRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "local@example.com"], { cwd: workspaceRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Local Tester"], { cwd: workspaceRoot, stdio: "ignore" });
      execFileSync("git", ["add", "."], { cwd: workspaceRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: workspaceRoot, stdio: "ignore" });
    } catch {
      return;
    }

    const changedFile = path.join(workspaceRoot, "src/api/checkout-service.ts");
    const original = await readFile(changedFile, "utf8");
    await writeFile(changedFile, `${original}\nexport const checkoutLabel = "changed";\n`);

    const appPaths = resolveAppPaths(path.join(workspaceRoot, ".leb-data"));
    const registration = await registerWorkspace(appPaths, workspaceRoot, "fixture");
    const database = new BrainDatabase(appPaths.databasePath);
    database.init();
    database.upsertWorkspace(registration.workspace);

    const indexer = new WorkspaceIndexer(database);
    await indexer.indexWorkspace(registration.workspace);

    const retrieval = new RetrievalEngine(database, new GraphEngine(database));
    const summary = retrieval.summarizeBranchChanges(registration.workspace.id);

    const foundChangedFile = summary.structured_data.files.some((file) => file.path.endsWith("/src/api/checkout-service.ts"));
    assert.ok(foundChangedFile);

    const architecture = retrieval.checkArchitectureViolations(registration.workspace.id);
    assert.ok(architecture.structured_data.violations.length >= 1);

    const candidateTests = retrieval.analyzeTestFailures(registration.workspace.id, 5);
    assert.ok(candidateTests.structured_data.candidateTests.length >= 1);

    const logs = retrieval.queryLogs(registration.workspace.id, { service: "api" }, 10);
    assert.ok(logs.structured_data.events.length >= 1);

    const timeline = retrieval.buildIncidentTimeline(registration.workspace.id, 10, "api");
    assert.ok(timeline.structured_data.incidents.length >= 1);

    database.close();
  });
});
