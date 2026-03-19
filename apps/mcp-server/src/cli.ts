#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAppPaths } from "@local-engineering-brain/workspace-manager";
import { createLocalEngineeringBrainServer } from "./index.js";
import { detectBootstrapWorkspace, parseArgs } from "./workspace-bootstrap.js";

const args = parseArgs(process.argv.slice(2));
const isEntrypoint = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

if (isEntrypoint) {
  const server = await createLocalEngineeringBrainServer({
    appPaths: resolveAppPaths(args.dataDir),
    bootstrapWorkspace: detectBootstrapWorkspace(args.workspace)
  });

  await server.start();
}
