import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createLocalEngineeringBrainServer } from "../apps/mcp-server/src/index.js";
import { parseArgs } from "../apps/mcp-server/src/workspace-bootstrap.js";
import { listApprovedWorkspaces, resolveAppPaths } from "@local-engineering-brain/workspace-manager";

const createdDirectories: string[] = [];

afterEach(async () => {
  while (createdDirectories.length > 0) {
    const current = createdDirectories.pop();
    if (current) {
      await rm(current, { recursive: true, force: true });
    }
  }
});

describe("safe defaults", () => {
  it("keeps optional CLI arguments omitted by default", () => {
    assert.deepEqual(parseArgs([]), {});
  });

  it("starts without approving or indexing any workspace when no bootstrap path is provided", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "leb-safe-"));
    createdDirectories.push(tempRoot);
    const appPaths = resolveAppPaths(path.join(tempRoot, ".leb-data"));
    const server = await createLocalEngineeringBrainServer({ appPaths });

    assert.deepEqual(await listApprovedWorkspaces(appPaths), []);
    assert.equal(server.database.listWorkspaces().length, 0);

    server.database.close();
  });
});
