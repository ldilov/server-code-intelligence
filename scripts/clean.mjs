import { readdir, rm } from "node:fs/promises";
import path from "node:path";

async function cleanDirectory(currentPath) {
  const entries = await readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(currentPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "coverage" || entry.name === ".release" || entry.name.startsWith(".tmp")) {
        await rm(fullPath, { recursive: true, force: true });
      } else {
        await cleanDirectory(fullPath);
      }
    } else if (entry.name.endsWith(".tsbuildinfo") || entry.name.startsWith(".tmp")) {
      await rm(fullPath, { force: true });
    }
  }
}

await cleanDirectory(process.cwd());
