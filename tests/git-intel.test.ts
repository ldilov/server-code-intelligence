import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitIntelCollector, parseRecentCommits, parseStatusPorcelain } from "@local-engineering-brain/git-intel";

describe("git-intel", () => {
  it("parses porcelain status output into changed file records", () => {
    const changedFiles = parseStatusPorcelain([" M src/api/checkout-service.ts", "R  src/old.ts -> src/new.ts", "?? tests/new.test.ts"].join("\n"));

    assert.deepEqual(changedFiles, [
      { path: "src/api/checkout-service.ts", status: "modified" },
      { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" },
      { path: "tests/new.test.ts", status: "untracked" }
    ]);
  });

  it("parses recent commits from git log output", () => {
    const commits = parseRecentCommits(
      "abc123\u001fLocal Tester\u001f2026-03-19T10:00:00.000Z\u001fInitial commit\u001e",
      "workspace_test",
      "repo_test",
      "main"
    );

    assert.equal(commits.length, 1);
    assert.equal(commits[0]?.sha, "abc123");
    assert.equal(commits[0]?.branchName, "main");
  });

  it("collects a repository snapshot through the injected executor", () => {
    const collector = new GitIntelCollector((_, args) => {
      if (args[0] === "rev-parse") {
        return "feature/local-brain";
      }
      if (args[0] === "status") {
        return " M src/api/checkout-service.ts";
      }
      return "abc123\u001fLocal Tester\u001f2026-03-19T10:00:00.000Z\u001fInitial commit\u001e";
    });

    const snapshot = collector.collect("D:/repo", "workspace_test", "repo_test");

    assert.equal(snapshot.isRepository, true);
    assert.equal(snapshot.branchName, "feature/local-brain");
    assert.equal(snapshot.changedFiles[0]?.path, "src/api/checkout-service.ts");
    assert.equal(snapshot.recentCommits[0]?.summary, "Initial commit");
  });
});
