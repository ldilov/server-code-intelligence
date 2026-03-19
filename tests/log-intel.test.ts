import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { collectConfiguredLogs, discoverWorkspaceLogSources, loadLogIntelConfig } from "@local-engineering-brain/log-intel";

const createdDirectories: string[] = [];

afterEach(async () => {
  while (createdDirectories.length > 0) {
    const current = createdDirectories.pop();
    if (current) {
      await rm(current, { recursive: true, force: true });
    }
  }
});

describe("log-intel", () => {
  it("loads configured log sources and derives incidents from error lines", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "leb-log-"));
    createdDirectories.push(workspaceRoot);
    await writeFile(
      path.join(workspaceRoot, "log-intel.yaml"),
      ["logs:", "  - name: api", "    path: logs/api.log", "    service: api", "    format: line"].join("\n")
    );
    await mkdir(path.join(workspaceRoot, "logs"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "logs", "api.log"),
      [
        "2026-03-19T10:00:00.000Z INFO api Started",
        "2026-03-19T10:00:01.000Z ERROR api Payment authorization failed",
        "2026-03-19T10:00:02.000Z ERROR api Payment authorization failed"
      ].join("\n")
    );

    const config = await loadLogIntelConfig(workspaceRoot);
    const result = await collectConfiguredLogs(workspaceRoot, "workspace_test", config);

    assert.equal(config.logs.length, 1);
    assert.equal(result.events.length, 3);
    assert.equal(result.incidents.length, 1);
    assert.equal(result.incidents[0]?.eventCount, 2);
  });

  it("assigns unique event ids to duplicate log lines in the same file", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "leb-log-dup-"));
    createdDirectories.push(workspaceRoot);
    await writeFile(
      path.join(workspaceRoot, "log-intel.yaml"),
      ["logs:", "  - name: api", "    path: logs/api.log", "    service: api", "    format: line"].join("\n")
    );
    await mkdir(path.join(workspaceRoot, "logs"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "logs", "api.log"),
      [
        "2026-03-19T10:00:01.000Z ERROR api Payment authorization failed",
        "2026-03-19T10:00:01.000Z ERROR api Payment authorization failed"
      ].join("\n")
    );

    const config = await loadLogIntelConfig(workspaceRoot);
    const result = await collectConfiguredLogs(workspaceRoot, "workspace_test", config);

    assert.equal(result.events.length, 2);
    assert.notEqual(result.events[0]?.id, result.events[1]?.id);
  });

  it("auto-discovers likely workspace log files without indexing MCP app logs", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "leb-log-discovery-"));
    createdDirectories.push(workspaceRoot);
    await mkdir(path.join(workspaceRoot, "services", "api", "logs"), { recursive: true });
    await mkdir(path.join(workspaceRoot, ".local-engineering-brain", "logs"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "services", "api", "logs", "server.log"), "2026-03-19T10:00:00.000Z INFO api Started");
    await writeFile(path.join(workspaceRoot, ".local-engineering-brain", "logs", "internal.log"), "should be ignored");

    const discovered = await discoverWorkspaceLogSources(workspaceRoot);

    assert.ok(discovered.some((source) => source.path === "services/api/logs/server.log"));
    assert.equal(discovered.find((source) => source.path === "services/api/logs/server.log")?.service, "api");
    assert.ok(discovered.every((source) => !source.path.includes(".local-engineering-brain")));
  });
});
