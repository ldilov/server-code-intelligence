import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectBootstrapWorkspace, parseArgs } from "../apps/mcp-server/src/workspace-bootstrap.js";

test("parseArgs reads data-dir and workspace", () => {
  const result = parseArgs(["--data-dir", "D:\\data", "--workspace", "D:\\repo"]);

  assert.deepEqual(result, {
    dataDir: "D:\\data",
    workspace: "D:\\repo"
  });
});

test("detectBootstrapWorkspace prefers explicit argv workspace", () => {
  const result = detectBootstrapWorkspace("D:\\repo", { INIT_CWD: "D:\\other" }, "D:\\fallback");

  assert.equal(result, "D:\\repo");
});

test("detectBootstrapWorkspace falls back to environment workspace hints", () => {
  const result = detectBootstrapWorkspace(undefined, { CODEX_WORKSPACE_ROOT: "D:\\repo" }, "D:\\fallback");

  assert.equal(result, "D:\\repo");
});

test("detectBootstrapWorkspace falls back to cwd for real project paths", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "leb-workspace-"));
  writeFileSync(path.join(cwd, "package.json"), "{}");

  try {
    const result = detectBootstrapWorkspace(undefined, {}, cwd);

    assert.equal(result, cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("detectBootstrapWorkspace ignores home directory cwd", () => {
  const home = os.homedir();

  const result = detectBootstrapWorkspace(undefined, {}, home);

  assert.equal(result, undefined);
});

test("detectBootstrapWorkspace ignores temp directory cwd", () => {
  const tempCwd = path.join(os.tmpdir(), "leb-temp");

  const result = detectBootstrapWorkspace(undefined, {}, tempCwd);

  assert.equal(result, undefined);
});

test("detectBootstrapWorkspace ignores cwd under Windows system directories", () => {
  const result = detectBootstrapWorkspace(
    undefined,
    { SystemRoot: "C:\\Windows" },
    "C:\\Windows\\System32"
  );

  assert.equal(result, undefined);
});

test("detectBootstrapWorkspace ignores env workspace under Windows system directories", () => {
  const result = detectBootstrapWorkspace(
    undefined,
    {
      SystemRoot: "C:\\Windows",
      CODEX_WORKSPACE_ROOT: "C:\\Windows\\System32"
    },
    "D:\\fallback"
  );

  assert.equal(result, undefined);
});

test("detectBootstrapWorkspace accepts env workspace when it exists and is safe", () => {
  const workspace = path.join(process.cwd(), ".tmp-safe-env-workspace");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(path.join(workspace, ".git"), { recursive: true });

  try {
    const result = detectBootstrapWorkspace(
      undefined,
      { CODEX_WORKSPACE_ROOT: workspace },
      "C:\\Windows\\System32"
    );

    assert.equal(result, workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
