import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const releaseDir = path.join(rootDir, ".release", "local-engineering-brain");
const releaseDistDir = path.join(releaseDir, "dist");
const releaseVendorDir = path.join(releaseDistDir, "vendor");

const internalPackages = [
  "core-types",
  "shared-utils",
  "tool-contracts",
  "workspace-manager",
  "storage-sqlite",
  "language-core",
  "language-csharp",
  "language-lua",
  "language-ts",
  "discovery-engine",
  "manifest-intel",
  "git-intel",
  "test-intel",
  "log-intel",
  "architecture-rules",
  "indexer",
  "graph-engine",
  "retrieval-engine",
  "retrospect-log",
  "context-bundler"
];

const externalDependencies = {
  "@modelcontextprotocol/sdk": "^1.17.0",
  "fast-glob": "^3.3.3",
  "ignore": "^7.0.4",
  "pino": "^9.5.0",
  "typescript": "^5.8.3",
  "zod": "^3.24.2"
};

function rewriteInternalImports(content, filePath) {
  return content.replace(/(@local-engineering-brain\/[a-z-]+)/g, (specifier) => {
    const packageName = specifier.replace("@local-engineering-brain/", "");
    if (!internalPackages.includes(packageName)) {
      return specifier;
    }
    const extension = filePath.endsWith(".d.ts") ? ".d.ts" : ".js";
    const targetPath = path.join(releaseVendorDir, packageName, `index${extension}`);
    let relativeTarget = path.relative(path.dirname(filePath), targetPath).replace(/\\/g, "/");
    if (!relativeTarget.startsWith(".")) {
      relativeTarget = `./${relativeTarget}`;
    }
    return relativeTarget;
  });
}

async function copyAndRewriteFile(sourcePath, targetPath) {
  const content = await readFile(sourcePath, "utf8");
  await writeFile(targetPath, rewriteInternalImports(content, targetPath));
}

async function copyDirectoryWithRewrite(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryWithRewrite(sourcePath, targetPath);
      continue;
    }

    if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) {
      await copyAndRewriteFile(sourcePath, targetPath);
      continue;
    }

    await cp(sourcePath, targetPath);
  }
}

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseVendorDir, { recursive: true });

await mkdir(releaseDistDir, { recursive: true });
const appDistDir = path.join(rootDir, "apps", "mcp-server", "dist");
await copyDirectoryWithRewrite(appDistDir, releaseDistDir);

for (const packageName of internalPackages) {
  const packageDistDir = path.join(rootDir, "packages", packageName, "dist");
  const targetDir = path.join(releaseVendorDir, packageName);
  await copyDirectoryWithRewrite(packageDistDir, targetDir);
}

const rootPackage = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
await writeFile(
  path.join(releaseDir, "package.json"),
  JSON.stringify(
    {
      name: "local-engineering-brain",
      version: rootPackage.version,
      description: "Local-first MCP server that auto-indexes the active coding workspace when available, with dependency analysis, architecture checks, test impact, and workspace log intelligence.",
      type: "module",
      private: false,
      publishConfig: {
        access: "public"
      },
      engines: {
        node: ">=22"
      },
      main: "dist/index.js",
      types: "dist/index.d.ts",
      bin: {
        "local-engineering-brain": "./dist/cli.js"
      },
      files: ["dist", "README.md"],
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          default: "./dist/index.js"
        }
      },
      dependencies: externalDependencies
    },
    null,
    2
  )
);

await cp(path.join(rootDir, "README.me"), path.join(releaseDir, "README.md"));
