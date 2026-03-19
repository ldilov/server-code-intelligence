import { execFileSync } from "node:child_process";
import type { ChangedFileRecord, CommitRecord } from "@local-engineering-brain/core-types";
import { nowIso, stableId } from "@local-engineering-brain/shared-utils";

export interface GitSnapshot {
  isRepository: boolean;
  branchName?: string;
  changedFiles: ChangedFileRecord[];
  recentCommits: CommitRecord[];
  notes: string[];
}

export type GitExecutor = (rootPath: string, args: string[]) => string;

const defaultGitExecutor: GitExecutor = (rootPath, args) =>
  execFileSync("git", ["-C", rootPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();

function normalizeGitPath(input: string): string {
  return input.replace(/\\/g, "/").trim();
}

function toGitStatus(code: string): ChangedFileRecord["status"] {
  if (code.includes("R")) {
    return "renamed";
  }
  if (code.includes("A")) {
    return "added";
  }
  if (code.includes("D")) {
    return "deleted";
  }
  if (code === "??") {
    return "untracked";
  }
  if (code.includes("M")) {
    return "modified";
  }
  return "unknown";
}

export function parseStatusPorcelain(output: string): ChangedFileRecord[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const statusCode = line.slice(0, 2);
      const payload = line.slice(3).trim();
      if (payload.includes(" -> ")) {
        const [previousPath, nextPath] = payload.split(" -> ");
        return {
          path: normalizeGitPath(nextPath ?? payload),
          previousPath: normalizeGitPath(previousPath ?? payload),
          status: "renamed" as const
        };
      }

      return {
        path: normalizeGitPath(payload),
        status: toGitStatus(statusCode)
      };
    });
}

export function parseRecentCommits(
  output: string,
  workspaceId: string,
  repoId: string,
  branchName?: string
): CommitRecord[] {
  const now = nowIso();
  return output
    .split("\u001e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, authorName, authoredAt, summary] = entry.split("\u001f");
      return {
        id: stableId("commit", workspaceId, sha ?? ""),
        workspaceId,
        repoId,
        sha: sha ?? "",
        authorName: authorName ?? "unknown",
        authoredAt: authoredAt ?? now,
        summary: summary ?? "",
        branchName,
        createdAt: now,
        updatedAt: now
      };
    })
    .filter((commit) => commit.sha.length > 0);
}

export class GitIntelCollector {
  public constructor(private readonly execute: GitExecutor = defaultGitExecutor) {}

  public collect(rootPath: string, workspaceId: string, repoId: string, commitLimit = 5): GitSnapshot {
    try {
      const branchName = this.execute(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const changedFiles = parseStatusPorcelain(this.execute(rootPath, ["status", "--porcelain"]));
      const recentCommits = parseRecentCommits(
        this.execute(rootPath, ["log", `--max-count=${commitLimit}`, "--date=iso-strict", "--pretty=format:%H%x1f%an%x1f%aI%x1f%s%x1e"]),
        workspaceId,
        repoId,
        branchName || undefined
      );

      const notes = changedFiles.length === 0 ? ["Git repository is clean."] : [];
      return {
        isRepository: true,
        branchName: branchName || undefined,
        changedFiles,
        recentCommits,
        notes
      };
    } catch {
      return {
        isRepository: false,
        changedFiles: [],
        recentCommits: [],
        notes: ["Workspace is not a git repository or git is unavailable."]
      };
    }
  }
}
