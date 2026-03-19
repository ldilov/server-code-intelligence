import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

function parseVersion(versionText) {
  const [major = "0", minor = "0"] = versionText.replace(/^v/, "").split(".");
  return {
    major: Number.parseInt(major, 10) || 0,
    minor: Number.parseInt(minor, 10) || 0
  };
}

function supportsStableIsolationFlag(version) {
  return version.major > 23 || (version.major === 23 && version.minor >= 6);
}

function supportsExperimentalIsolationFlag(version) {
  return version.major > 22 || (version.major === 22 && version.minor >= 8);
}

const version = parseVersion(process.version);
const args = [
  "--test",
  "--test-concurrency=1"
];

if (supportsStableIsolationFlag(version)) {
  args.push("--test-isolation=none");
} else if (supportsExperimentalIsolationFlag(version)) {
  args.push("--experimental-test-isolation=none");
}

const testsDirectory = path.resolve(".test-dist/tests");
const testFiles = readdirSync(testsDirectory)
  .filter((fileName) => fileName.endsWith(".test.js"))
  .sort((left, right) => left.localeCompare(right))
  .map((fileName) => path.join(testsDirectory, fileName));

args.push(...testFiles);

const result = spawnSync(process.execPath, args, {
  stdio: "inherit"
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
