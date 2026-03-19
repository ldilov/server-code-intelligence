import path from "node:path";
export function normalizeSlashes(value) {
    return value.replaceAll("\\", "/");
}
export class AdapterRegistry {
    languageAdapters;
    identityProviders;
    constructor(languageAdapters, identityProviders) {
        this.languageAdapters = languageAdapters;
        this.identityProviders = identityProviders;
    }
    getLanguageAdapter(candidate, classification) {
        return this.languageAdapters.find((adapter) => adapter.supports(candidate, classification));
    }
    resolveModuleIdentity(context) {
        const providers = [...this.identityProviders].sort((left, right) => right.priority - left.priority);
        for (const provider of providers) {
            const resolved = provider.resolve(context);
            if (resolved) {
                return resolved;
            }
        }
        return {
            moduleIdSeed: context.candidate.absPath,
            canonicalPath: context.candidate.absPath,
            displayPath: context.candidate.relPath,
            moduleKind: "file",
            tags: [...context.classification.tags]
        };
    }
}
export class FileBackedModuleIdentityProvider {
    id = "file-backed";
    priority = 0;
    resolve(context) {
        return {
            moduleIdSeed: context.candidate.absPath,
            canonicalPath: context.candidate.absPath,
            displayPath: context.candidate.relPath,
            moduleKind: "file",
            tags: [...context.classification.tags]
        };
    }
}
export function summarizeSignals(signals) {
    return signals.map((signal) => `${signal.detectorId}: ${signal.reason}`);
}
export function normalizeCandidate(absPath, workspaceRoot, sizeBytes, mtimeMs) {
    const normalizedAbsPath = normalizeSlashes(absPath);
    const relPath = normalizeSlashes(path.relative(workspaceRoot, absPath));
    return {
        absPath: normalizedAbsPath,
        relPath,
        basename: path.basename(absPath),
        extension: path.extname(absPath).toLowerCase(),
        sizeBytes,
        mtimeMs
    };
}
//# sourceMappingURL=index.js.map