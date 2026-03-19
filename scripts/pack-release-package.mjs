import { execFileSync } from "node:child_process";
import path from "node:path";

const rootDir = process.cwd();
const releaseDir = path.join(rootDir, ".release", "local-engineering-brain");

execFileSync("npm", ["pack"], {
  cwd: releaseDir,
  stdio: "inherit",
  shell: process.platform === "win32"
});
