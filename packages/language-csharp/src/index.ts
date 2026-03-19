import type { EdgeRecord, ExtractedFileFact, SummaryRecord } from "@local-engineering-brain/core-types";
import type { CandidateFile, FileClassification, LanguageAdapter, ParserContextV2 } from "@local-engineering-brain/language-core";
import { pathToModuleLanguage, stableId } from "@local-engineering-brain/shared-utils";

export class CSharpLanguageAdapter implements LanguageAdapter<ExtractedFileFact> {
  public readonly id = "language-csharp";
  public readonly displayName = "C#";
  public readonly extractorVersion = "language-csharp-v1";
  public readonly parserVersion = "csharp-evidence-v1";

  public supports(_candidate: CandidateFile, classification: FileClassification): boolean {
    return (classification.kind === "source" || classification.kind === "test") && classification.language === "csharp";
  }

  public extract(context: ParserContextV2, _sourceText: string) {
    const fileId = stableId("file", context.workspaceId, context.filePath);
    const moduleId = stableId("module", context.workspaceId, context.filePath);
    const language = context.classification.language ?? pathToModuleLanguage(context.filePath);
    const summaryText = `csharp ${context.classification.kind} file indexed as file-level evidence for ${context.relativePath}.`;
    const edges: EdgeRecord[] = [
      {
        id: stableId("edge", "contains", fileId, moduleId, context.filePath),
        workspaceId: context.workspaceId,
        sourceId: fileId,
        sourceType: "file",
        targetId: moduleId,
        targetType: "module",
        type: "contains",
        ownerFilePath: context.filePath,
        confidence: 1,
        createdAt: context.now,
        updatedAt: context.now
      }
    ];

    if (context.packageId) {
      edges.push({
        id: stableId("edge", "belongs_to_package", moduleId, context.packageId, context.filePath),
        workspaceId: context.workspaceId,
        sourceId: moduleId,
        sourceType: "module",
        targetId: context.packageId,
        targetType: "package",
        type: "belongs_to_package",
        ownerFilePath: context.filePath,
        confidence: 1,
        createdAt: context.now,
        updatedAt: context.now
      });
    }

    const summary: SummaryRecord = {
      id: stableId("summary", context.workspaceId, moduleId),
      workspaceId: context.workspaceId,
      entityId: moduleId,
      entityType: "module",
      summary: summaryText,
      source: this.id,
      updatedAt: context.now
    };

    return {
      facts: {
        file: {
          id: fileId,
          workspaceId: context.workspaceId,
          repoId: context.repoId,
          packageId: context.packageId,
          path: context.filePath,
          language,
          summary: summaryText,
          authored: true,
          hash: context.hash,
          updatedAt: context.now
        },
        module: {
          id: moduleId,
          workspaceId: context.workspaceId,
          fileId,
          packageId: context.packageId,
          canonicalPath: context.moduleIdentity.canonicalPath,
          language,
          summary: summaryText,
          publicExports: [],
          inboundDependencyCount: 0,
          outboundDependencyCount: 0,
          updatedAt: context.now
        },
        symbols: [],
        edges,
        summary,
        warnings: []
      },
      warnings: []
    };
  }
}
