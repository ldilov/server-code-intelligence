import fs from "node:fs";
import path from "node:path";
import { defaultLanguageByExtension, extensionOf } from "./conventions.js";

const defaultCandidateExtensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

export function normalizePath(input: string): string {
  return path.resolve(input).replace(/\\/g, "/");
}

export function toRelativePath(rootPath: string, targetPath: string): string {
  return path.relative(rootPath, targetPath).replace(/\\/g, "/");
}

export function ensureWithinRoot(rootPath: string, targetPath: string): boolean {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedTarget = normalizePath(targetPath);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

export function pathToModuleLanguage(filePath: string): string {
  const extension = extensionOf(filePath);
  return defaultLanguageByExtension[extension] ?? (extension.replace(/^\./, "") || "unknown");
}

export function resolveLocalModulePath(fromFilePath: string, importText: string, candidateExtensions = defaultCandidateExtensions): string | undefined {
  if (!importText.startsWith(".")) {
    return undefined;
  }

  const sourceDir = path.dirname(fromFilePath);
  const absoluteBase = path.resolve(sourceDir, importText);
  const extensionlessBase = absoluteBase.replace(/\.(jsx?|tsx?)$/i, "");
  const candidates = [
    absoluteBase,
    extensionlessBase,
    ...candidateExtensions.map((extension) => `${absoluteBase}${extension}`),
    ...candidateExtensions.map((extension) => `${extensionlessBase}${extension}`),
    ...candidateExtensions.map((extension) => path.join(absoluteBase, `index${extension}`)),
    ...candidateExtensions.map((extension) => path.join(extensionlessBase, `index${extension}`))
  ];

  return candidates.find((candidate) => {
    try {
      const normalizedCandidate = normalizePath(candidate);
      return fs.existsSync(normalizedCandidate) && fs.statSync(normalizedCandidate).isFile();
    } catch {
      return false;
    }
  })?.replace(/\\/g, "/");
}

export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "___DOUBLE_STAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___DOUBLE_STAR___/g, ".*");
  return new RegExp(`^${escaped}$`);
}
