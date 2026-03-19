import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  },
  resolve: {
    alias: {
      "@local-engineering-brain/core-types": path.join(rootDir, "packages/core-types/src/index.ts"),
      "@local-engineering-brain/shared-utils": path.join(rootDir, "packages/shared-utils/src/index.ts"),
      "@local-engineering-brain/tool-contracts": path.join(rootDir, "packages/tool-contracts/src/index.ts"),
      "@local-engineering-brain/workspace-manager": path.join(rootDir, "packages/workspace-manager/src/index.ts"),
      "@local-engineering-brain/storage-sqlite": path.join(rootDir, "packages/storage-sqlite/src/index.ts"),
      "@local-engineering-brain/language-ts": path.join(rootDir, "packages/language-ts/src/index.ts"),
      "@local-engineering-brain/indexer": path.join(rootDir, "packages/indexer/src/index.ts"),
      "@local-engineering-brain/graph-engine": path.join(rootDir, "packages/graph-engine/src/index.ts"),
      "@local-engineering-brain/retrieval-engine": path.join(rootDir, "packages/retrieval-engine/src/index.ts")
    }
  }
});
