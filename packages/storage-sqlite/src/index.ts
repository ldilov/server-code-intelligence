import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ArchitectureViolationRecord,
  ChangeGroupRecord,
  CommitRecord,
  EdgeRecord,
  EntityType,
  ExtractedFileFact,
  ExtractedTestFact,
  FileRecord,
  IndexJobStatus,
  IndexStatus,
  IncidentRecord,
  LogEventRecord,
  LogLevel,
  ModuleRecord,
  PackageRecord,
  RepositoryRecord,
  SearchHit,
  SummaryRecord,
  SymbolRecord,
  TestFailureAnalysis,
  ViolationSeverity,
  WorkspaceRecord
} from "@local-engineering-brain/core-types";
import { nowIso, stableId } from "@local-engineering-brain/shared-utils";
import { schemaStatements } from "./schema.js";

type RowRecord = Record<string, unknown>;

function toFlag(value: boolean): number {
  return value ? 1 : 0;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (!value) {
    return fallback;
  }
  return JSON.parse(String(value)) as T;
}

function parseEdge(row: RowRecord): EdgeRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    sourceId: String(row.source_id),
    sourceType: row.source_type as EntityType,
    targetId: String(row.target_id),
    targetType: row.target_type as EntityType,
    type: row.type as EdgeRecord["type"],
    ownerFilePath: String(row.owner_file_path),
    confidence: Number(row.confidence),
    metadata: row.metadata_json ? parseJson<Record<string, unknown>>(row.metadata_json, {}) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export class BrainDatabase {
  private readonly db: DatabaseSync;

  public constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
  }

  public init(): void {
    for (const statement of schemaStatements) {
      this.db.exec(statement);
    }
  }

  public close(): void {
    this.db.close();
  }

  public listWorkspaces(): WorkspaceRecord[] {
    const rows = this.db.prepare(`SELECT * FROM workspaces ORDER BY label ASC`).all() as RowRecord[];
    return rows.map((row) => this.mapWorkspace(row));
  }

  public getWorkspace(workspaceId: string): WorkspaceRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM workspaces WHERE id = ?`).get(workspaceId) as RowRecord | undefined;
    return row ? this.mapWorkspace(row) : undefined;
  }

  public upsertWorkspace(workspace: WorkspaceRecord): void {
    this.db.prepare(
      `INSERT INTO workspaces (id, root_path, label, created_at, updated_at, last_indexed_at)
       VALUES (@id, @rootPath, @label, @createdAt, @updatedAt, @lastIndexedAt)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         updated_at = excluded.updated_at,
         last_indexed_at = excluded.last_indexed_at`
    ).run({
      id: workspace.id,
      rootPath: workspace.rootPath,
      label: workspace.label,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      lastIndexedAt: workspace.lastIndexedAt ?? null
    } as any);
  }

  public upsertRepository(repository: RepositoryRecord): void {
    this.db.prepare(
      `INSERT INTO repositories (id, workspace_id, root_path, vcs_type, branch_name, created_at, updated_at)
       VALUES (@id, @workspaceId, @rootPath, @vcsType, @branchName, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         root_path = excluded.root_path,
         vcs_type = excluded.vcs_type,
         branch_name = excluded.branch_name,
         updated_at = excluded.updated_at`
    ).run({
      id: repository.id,
      workspaceId: repository.workspaceId,
      rootPath: repository.rootPath,
      vcsType: repository.vcsType,
      branchName: repository.branchName ?? null,
      createdAt: repository.createdAt,
      updatedAt: repository.updatedAt
    } as any);
  }

  public getRepositoryByWorkspaceId(workspaceId: string): RepositoryRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM repositories WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1`
    ).get(workspaceId) as RowRecord | undefined;
    if (!row) {
      return undefined;
    }
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      rootPath: String(row.root_path),
      vcsType: row.vcs_type as RepositoryRecord["vcsType"],
      branchName: row.branch_name ? String(row.branch_name) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  public replacePackages(workspaceId: string, packages: PackageRecord[]): void {
    this.withTransaction(() => {
      this.db.prepare(`DELETE FROM packages WHERE workspace_id = ?`).run(workspaceId);
      const statement = this.db.prepare(
        `INSERT INTO packages (id, workspace_id, repo_id, name, root_path, manifest_path, package_manager, created_at, updated_at)
         VALUES (@id, @workspaceId, @repoId, @name, @rootPath, @manifestPath, @packageManager, @createdAt, @updatedAt)`
      );
      for (const record of packages) {
        statement.run({
          id: record.id,
          workspaceId: record.workspaceId,
          repoId: record.repoId,
          name: record.name,
          rootPath: record.rootPath,
          manifestPath: record.manifestPath,
          packageManager: record.packageManager,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt
        } as any);
      }
    });
  }

  public replaceFileFact(fact: ExtractedFileFact): void {
    this.withTransaction(() => {
      this.deleteFileOwnedFacts(fact.file.workspaceId, fact.file.path);

      this.db.prepare(
        `INSERT INTO files (id, workspace_id, repo_id, package_id, path, language, summary, authored, hash, updated_at)
         VALUES (@id, @workspaceId, @repoId, @packageId, @path, @language, @summary, @authored, @hash, @updatedAt)`
      ).run({
        id: fact.file.id,
        workspaceId: fact.file.workspaceId,
        repoId: fact.file.repoId,
        packageId: fact.file.packageId ?? null,
        path: fact.file.path,
        language: fact.file.language,
        summary: fact.file.summary,
        authored: toFlag(fact.file.authored),
        hash: fact.file.hash,
        updatedAt: fact.file.updatedAt
      } as any);

      this.db.prepare(
        `INSERT INTO modules (id, workspace_id, file_id, package_id, canonical_path, language, summary, public_exports_json, inbound_dependency_count, outbound_dependency_count, updated_at)
         VALUES (@id, @workspaceId, @fileId, @packageId, @canonicalPath, @language, @summary, @publicExportsJson, 0, @outboundDependencyCount, @updatedAt)`
      ).run({
        id: fact.module.id,
        workspaceId: fact.module.workspaceId,
        fileId: fact.module.fileId,
        packageId: fact.module.packageId ?? null,
        canonicalPath: fact.module.canonicalPath,
        language: fact.module.language,
        summary: fact.module.summary,
        publicExportsJson: JSON.stringify(fact.module.publicExports),
        outboundDependencyCount: fact.edges.filter((edge) => edge.type === "imports" && edge.sourceId === fact.module.id).length,
        updatedAt: fact.module.updatedAt
      } as any);

      const symbolStatement = this.db.prepare(
        `INSERT INTO symbols (
           id, workspace_id, module_id, file_id, qualified_name, local_name, kind, signature, exported,
           range_start_line, range_start_column, range_end_line, range_end_column, summary, updated_at
         ) VALUES (
           @id, @workspaceId, @moduleId, @fileId, @qualifiedName, @localName, @kind, @signature, @exported,
           @startLine, @startColumn, @endLine, @endColumn, @summary, @updatedAt
         )`
      );

      for (const symbol of fact.symbols) {
        symbolStatement.run({
          id: symbol.id,
          workspaceId: fact.file.workspaceId,
          moduleId: fact.module.id,
          fileId: fact.file.id,
          qualifiedName: symbol.qualifiedName,
          localName: symbol.localName,
          kind: symbol.kind,
          signature: symbol.signature ?? null,
          exported: toFlag(symbol.exported),
          startLine: symbol.range.start.line,
          startColumn: symbol.range.start.column,
          endLine: symbol.range.end.line,
          endColumn: symbol.range.end.column,
          summary: symbol.summary,
          updatedAt: fact.file.updatedAt
        } as any);
      }

      this.insertEdges(fact.edges);
      this.upsertSummary(fact.summary);
      this.refreshFts(fact.file, fact.module, fact.symbols);
      this.recomputeModuleDegrees(fact.file.workspaceId);
    });
  }

  public replaceTestFact(workspaceId: string, filePath: string, fact: ExtractedTestFact): void {
    this.withTransaction(() => {
      this.deleteTestFactsByPathInternal(workspaceId, filePath);

      this.db.prepare(
        `INSERT INTO test_suites (id, workspace_id, file_path, framework, name, updated_at)
         VALUES (@id, @workspaceId, @filePath, @framework, @name, @updatedAt)`
      ).run({
        id: fact.suite.id,
        workspaceId: fact.suite.workspaceId,
        filePath: fact.suite.filePath,
        framework: fact.suite.framework,
        name: fact.suite.name,
        updatedAt: fact.suite.updatedAt
      } as any);

      const caseStatement = this.db.prepare(
        `INSERT INTO test_cases (
           id, workspace_id, suite_id, file_path, name,
           range_start_line, range_start_column, range_end_line, range_end_column, updated_at
         ) VALUES (
           @id, @workspaceId, @suiteId, @filePath, @name,
           @startLine, @startColumn, @endLine, @endColumn, @updatedAt
         )`
      );

      for (const testCase of fact.testCases) {
        caseStatement.run({
          id: testCase.id,
          workspaceId: testCase.workspaceId,
          suiteId: testCase.suiteId,
          filePath: testCase.filePath,
          name: testCase.name,
          startLine: testCase.range.start.line,
          startColumn: testCase.range.start.column,
          endLine: testCase.range.end.line,
          endColumn: testCase.range.end.column,
          updatedAt: testCase.updatedAt
        } as any);
      }

      this.insertEdges(fact.edges);
    });
  }

  public deleteTestFactsByPath(workspaceId: string, filePath: string): void {
    this.withTransaction(() => {
      this.deleteTestFactsByPathInternal(workspaceId, filePath);
    });
  }

  private deleteTestFactsByPathInternal(workspaceId: string, filePath: string): void {
    const existingSuiteRows = this.db.prepare(
      `SELECT id FROM test_suites WHERE workspace_id = ? AND file_path = ?`
    ).all(workspaceId, filePath) as RowRecord[];
    const existingSuiteIds = existingSuiteRows.map((row) => String(row.id));

    if (existingSuiteIds.length === 0) {
      return;
    }

    const suitePlaceholders = existingSuiteIds.map(() => "?").join(", ");
    const existingCaseRows = this.db.prepare(
      `SELECT id FROM test_cases WHERE suite_id IN (${suitePlaceholders})`
    ).all(...existingSuiteIds) as RowRecord[];
    const existingCaseIds = existingCaseRows.map((row) => String(row.id));

    if (existingCaseIds.length > 0) {
      const casePlaceholders = existingCaseIds.map(() => "?").join(", ");
      this.db.prepare(`DELETE FROM test_results WHERE test_case_id IN (${casePlaceholders})`).run(...existingCaseIds);
      this.db.prepare(`DELETE FROM edges WHERE workspace_id = ? AND source_type = 'test_case' AND source_id IN (${casePlaceholders})`).run(workspaceId, ...existingCaseIds);
    }

    this.db.prepare(`DELETE FROM test_cases WHERE suite_id IN (${suitePlaceholders})`).run(...existingSuiteIds);
    this.db.prepare(`DELETE FROM edges WHERE workspace_id = ? AND source_type = 'test_suite' AND source_id IN (${suitePlaceholders})`).run(workspaceId, ...existingSuiteIds);
    this.db.prepare(`DELETE FROM test_suites WHERE id IN (${suitePlaceholders})`).run(...existingSuiteIds);
  }

  public replaceCommits(workspaceId: string, repoId: string, commits: CommitRecord[]): void {
    this.withTransaction(() => {
      this.db.prepare(`DELETE FROM commits WHERE workspace_id = ?`).run(workspaceId);
      const statement = this.db.prepare(
        `INSERT INTO commits (id, workspace_id, repo_id, sha, author_name, authored_at, summary, branch_name, created_at, updated_at)
         VALUES (@id, @workspaceId, @repoId, @sha, @authorName, @authoredAt, @summary, @branchName, @createdAt, @updatedAt)`
      );
      for (const commit of commits) {
        statement.run({
          id: commit.id,
          workspaceId,
          repoId,
          sha: commit.sha,
          authorName: commit.authorName,
          authoredAt: commit.authoredAt,
          summary: commit.summary,
          branchName: commit.branchName ?? null,
          createdAt: commit.createdAt,
          updatedAt: commit.updatedAt
        } as any);
      }
    });
  }

  public replaceChangeGroup(changeGroup: ChangeGroupRecord, moduleIds: string[], symbolIds: string[]): void {
    this.withTransaction(() => {
      this.db.prepare(`DELETE FROM change_groups WHERE workspace_id = ?`).run(changeGroup.workspaceId);
      this.db.prepare(`DELETE FROM edges WHERE workspace_id = ? AND type = 'changed_in' AND target_type = 'change_group'`).run(changeGroup.workspaceId);
      this.db.prepare(
        `INSERT INTO change_groups (id, workspace_id, repo_id, branch_name, changed_files_json, source, updated_at)
         VALUES (@id, @workspaceId, @repoId, @branchName, @changedFilesJson, @source, @updatedAt)`
      ).run({
        id: changeGroup.id,
        workspaceId: changeGroup.workspaceId,
        repoId: changeGroup.repoId,
        branchName: changeGroup.branchName ?? null,
        changedFilesJson: JSON.stringify(changeGroup.changedFiles),
        source: changeGroup.source,
        updatedAt: changeGroup.updatedAt
      } as any);

      const edges: EdgeRecord[] = [
        ...moduleIds.map((moduleId) => ({
          id: stableId("edge", "changed_in", moduleId, changeGroup.id),
          workspaceId: changeGroup.workspaceId,
          sourceId: moduleId,
          sourceType: "module" as const,
          targetId: changeGroup.id,
          targetType: "change_group" as const,
          type: "changed_in" as const,
          ownerFilePath: "git",
          confidence: 1,
          createdAt: changeGroup.updatedAt,
          updatedAt: changeGroup.updatedAt
        })),
        ...symbolIds.map((symbolId) => ({
          id: stableId("edge", "changed_in", symbolId, changeGroup.id),
          workspaceId: changeGroup.workspaceId,
          sourceId: symbolId,
          sourceType: "symbol" as const,
          targetId: changeGroup.id,
          targetType: "change_group" as const,
          type: "changed_in" as const,
          ownerFilePath: "git",
          confidence: 0.9,
          createdAt: changeGroup.updatedAt,
          updatedAt: changeGroup.updatedAt
        }))
      ];

      this.insertEdges(edges);
    });
  }

  public getLatestChangeGroup(workspaceId: string): ChangeGroupRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM change_groups WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1`
    ).get(workspaceId) as RowRecord | undefined;
    if (!row) {
      return undefined;
    }

    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      repoId: String(row.repo_id),
      branchName: row.branch_name ? String(row.branch_name) : undefined,
      changedFiles: parseJson(row.changed_files_json, []),
      source: "working_tree",
      updatedAt: String(row.updated_at)
    };
  }

  public listRecentCommits(workspaceId: string, limit = 5): CommitRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM commits WHERE workspace_id = ? ORDER BY authored_at DESC LIMIT ?`
    ).all(workspaceId, limit) as RowRecord[];
    return rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      repoId: String(row.repo_id),
      sha: String(row.sha),
      authorName: String(row.author_name),
      authoredAt: String(row.authored_at),
      summary: String(row.summary),
      branchName: row.branch_name ? String(row.branch_name) : undefined,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
  }

  public replaceArchitectureViolations(workspaceId: string, violations: ArchitectureViolationRecord[]): void {
    this.withTransaction(() => {
      this.db.prepare(`DELETE FROM architecture_violations WHERE workspace_id = ?`).run(workspaceId);
      const statement = this.db.prepare(
        `INSERT INTO architecture_violations (
           id, workspace_id, rule_id, source_module_id, source_path, target_module_id, target_path,
           severity, explanation, evidence_edge_id, updated_at
         ) VALUES (
           @id, @workspaceId, @ruleId, @sourceModuleId, @sourcePath, @targetModuleId, @targetPath,
           @severity, @explanation, @evidenceEdgeId, @updatedAt
         )`
      );
      for (const violation of violations) {
        statement.run({
          id: violation.id,
          workspaceId: violation.workspaceId,
          ruleId: violation.ruleId,
          sourceModuleId: violation.sourceModuleId,
          sourcePath: violation.sourcePath,
          targetModuleId: violation.targetModuleId,
          targetPath: violation.targetPath,
          severity: violation.severity,
          explanation: violation.explanation,
          evidenceEdgeId: violation.evidenceEdgeId ?? null,
          updatedAt: violation.updatedAt
        } as any);
      }
    });
  }

  public listArchitectureViolations(workspaceId: string, severity?: ViolationSeverity): ArchitectureViolationRecord[] {
    const rows = severity
      ? (this.db.prepare(`SELECT * FROM architecture_violations WHERE workspace_id = ? AND severity = ? ORDER BY source_path ASC`).all(workspaceId, severity) as RowRecord[])
      : (this.db.prepare(`SELECT * FROM architecture_violations WHERE workspace_id = ? ORDER BY severity DESC, source_path ASC`).all(workspaceId) as RowRecord[]);
    return rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      ruleId: String(row.rule_id),
      sourceModuleId: String(row.source_module_id),
      sourcePath: String(row.source_path),
      targetModuleId: String(row.target_module_id),
      targetPath: String(row.target_path),
      severity: row.severity as ViolationSeverity,
      explanation: String(row.explanation),
      evidenceEdgeId: row.evidence_edge_id ? String(row.evidence_edge_id) : undefined,
      updatedAt: String(row.updated_at)
    }));
  }

  public listWorkspaceModules(workspaceId: string): ModuleRecord[] {
    const rows = this.db.prepare(`SELECT * FROM modules WHERE workspace_id = ? ORDER BY canonical_path ASC`).all(workspaceId) as RowRecord[];
    return rows.map((row) => this.mapModule(row));
  }

  public listImportEdges(workspaceId: string): EdgeRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM edges WHERE workspace_id = ? AND type = 'imports' AND source_type = 'module' AND target_type = 'module'`
    ).all(workspaceId) as RowRecord[];
    return rows.map((row) => parseEdge(row));
  }

  public listModulesForChangeGroup(workspaceId: string, changeGroupId: string): ModuleRecord[] {
    const rows = this.db.prepare(
      `SELECT m.*
       FROM edges e
       JOIN modules m ON m.id = e.source_id
       WHERE e.workspace_id = ? AND e.type = 'changed_in' AND e.target_id = ? AND e.source_type = 'module'
       ORDER BY m.canonical_path ASC`
    ).all(workspaceId, changeGroupId) as RowRecord[];
    return rows.map((row) => this.mapModule(row));
  }

  public listTestCandidatesForModuleIds(workspaceId: string, moduleIds: string[]): TestFailureAnalysis["candidateTests"] {
    if (moduleIds.length === 0) {
      return [];
    }

    const placeholders = moduleIds.map(() => "?").join(", ");
    const rows = this.db.prepare(
      `SELECT
         tc.id AS case_id,
         tc.name AS case_name,
         tc.file_path AS case_file_path,
         tc.range_start_line AS case_start_line,
         tc.range_start_column AS case_start_column,
         tc.range_end_line AS case_end_line,
         tc.range_end_column AS case_end_column,
         tc.updated_at AS case_updated_at,
         ts.id AS suite_id,
         ts.name AS suite_name,
         ts.file_path AS suite_file_path,
         ts.framework AS suite_framework,
         ts.updated_at AS suite_updated_at,
         m.id AS module_id,
         m.file_id AS module_file_id,
         m.package_id AS module_package_id,
         m.canonical_path AS module_path,
         m.language AS module_language,
         m.summary AS module_summary,
         m.public_exports_json AS module_public_exports_json,
         m.inbound_dependency_count AS module_inbound,
         m.outbound_dependency_count AS module_outbound,
         m.updated_at AS module_updated_at
       FROM edges e
       JOIN test_cases tc ON tc.id = e.source_id
       JOIN test_suites ts ON ts.id = tc.suite_id
       JOIN modules m ON m.id = e.target_id
       WHERE e.workspace_id = ? AND e.type = 'tests' AND e.source_type = 'test_case' AND e.target_type = 'module'
         AND e.target_id IN (${placeholders})
       ORDER BY ts.file_path ASC, tc.name ASC`
    ).all(workspaceId, ...moduleIds) as RowRecord[];

    const grouped = new Map<string, TestFailureAnalysis["candidateTests"][number]>();
    for (const row of rows) {
      const caseId = String(row.case_id);
      const relatedModule: ModuleRecord = {
        id: String(row.module_id),
        workspaceId,
        fileId: String(row.module_file_id),
        packageId: row.module_package_id ? String(row.module_package_id) : undefined,
        canonicalPath: String(row.module_path),
        language: String(row.module_language),
        summary: String(row.module_summary),
        publicExports: parseJson<string[]>(row.module_public_exports_json, []),
        inboundDependencyCount: Number(row.module_inbound),
        outboundDependencyCount: Number(row.module_outbound),
        updatedAt: String(row.module_updated_at)
      };

      if (!grouped.has(caseId)) {
        grouped.set(caseId, {
          suite: {
            id: String(row.suite_id),
            workspaceId,
            filePath: String(row.suite_file_path),
            framework: row.suite_framework as TestFailureAnalysis["candidateTests"][number]["suite"]["framework"],
            name: String(row.suite_name),
            updatedAt: String(row.suite_updated_at)
          },
          testCase: {
            id: caseId,
            workspaceId,
            suiteId: String(row.suite_id),
            filePath: String(row.case_file_path),
            name: String(row.case_name),
            range: {
              start: {
                line: Number(row.case_start_line),
                column: Number(row.case_start_column)
              },
              end: {
                line: Number(row.case_end_line),
                column: Number(row.case_end_column)
              }
            },
            updatedAt: String(row.case_updated_at)
          },
          relatedModules: [],
          score: 0
        });
      }

      const current = grouped.get(caseId)!;
      if (!current.relatedModules.some((module) => module.id === relatedModule.id)) {
        current.relatedModules.push(relatedModule);
      }
      current.score += 1;
    }

    return [...grouped.values()].sort((left, right) => right.score - left.score || left.suite.filePath.localeCompare(right.suite.filePath));
  }

  public replaceWorkspaceLogs(workspaceId: string, events: LogEventRecord[], incidents: IncidentRecord[]): void {
    this.withTransaction(() => {
      this.db.prepare(`DELETE FROM fts_logs WHERE entity_id IN (SELECT id FROM log_events WHERE workspace_id = ?)`).run(workspaceId);
      this.db.prepare(`DELETE FROM log_events WHERE workspace_id = ?`).run(workspaceId);
      this.db.prepare(`DELETE FROM incidents WHERE workspace_id = ?`).run(workspaceId);

      const uniqueEvents = [...new Map(events.map((event) => [event.id, event])).values()];
      const uniqueIncidents = [...new Map(incidents.map((incident) => [incident.id, incident])).values()];

      const eventStatement = this.db.prepare(
        `INSERT INTO log_events (
           id, workspace_id, source_name, file_path, service, level, timestamp, message, raw_line, updated_at
         ) VALUES (
           @id, @workspaceId, @sourceName, @filePath, @service, @level, @timestamp, @message, @rawLine, @updatedAt
         )`
      );
      const incidentStatement = this.db.prepare(
        `INSERT INTO incidents (
           id, workspace_id, service, title, level, first_seen_at, last_seen_at, event_count, latest_log_event_id, updated_at
         ) VALUES (
           @id, @workspaceId, @service, @title, @level, @firstSeenAt, @lastSeenAt, @eventCount, @latestLogEventId, @updatedAt
         )`
      );
      const ftsStatement = this.db.prepare(
        `INSERT INTO fts_logs (entity_id, service, level, message, raw_line) VALUES (?, ?, ?, ?, ?)`
      );

      for (const event of uniqueEvents) {
        eventStatement.run({
          id: event.id,
          workspaceId: event.workspaceId,
          sourceName: event.sourceName,
          filePath: event.filePath,
          service: event.service,
          level: event.level,
          timestamp: event.timestamp,
          message: event.message,
          rawLine: event.rawLine,
          updatedAt: event.updatedAt
        } as any);
        ftsStatement.run(event.id, event.service, event.level, event.message, event.rawLine);
      }

      for (const incident of uniqueIncidents) {
        incidentStatement.run({
          id: incident.id,
          workspaceId: incident.workspaceId,
          service: incident.service,
          title: incident.title,
          level: incident.level,
          firstSeenAt: incident.firstSeenAt,
          lastSeenAt: incident.lastSeenAt,
          eventCount: incident.eventCount,
          latestLogEventId: incident.latestLogEventId ?? null,
          updatedAt: incident.updatedAt
        } as any);
      }
    });
  }

  public queryLogs(
    workspaceId: string,
    filters: { pattern?: string; service?: string; level?: LogLevel },
    limit: number
  ): LogEventRecord[] {
    if (filters.pattern) {
      const clauses = [`le.workspace_id = ?`, `fts_logs MATCH ?`];
      const params: Array<string | number> = [workspaceId, filters.pattern];
      if (filters.service) {
        clauses.push(`le.service = ?`);
        params.push(filters.service);
      }
      if (filters.level) {
        clauses.push(`le.level = ?`);
        params.push(filters.level);
      }
      params.push(limit);
      const rows = this.db.prepare(
        `SELECT le.*
         FROM fts_logs
         JOIN log_events le ON le.id = fts_logs.entity_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY le.timestamp DESC
         LIMIT ?`
      ).all(...params) as RowRecord[];
      return rows.map((row) => this.mapLogEvent(row));
    }

    const clauses = [`workspace_id = ?`];
    const params: Array<string | number> = [workspaceId];
    if (filters.service) {
      clauses.push(`service = ?`);
      params.push(filters.service);
    }
    if (filters.level) {
      clauses.push(`level = ?`);
      params.push(filters.level);
    }
    params.push(limit);
    const rows = this.db.prepare(
      `SELECT * FROM log_events WHERE ${clauses.join(" AND ")} ORDER BY timestamp DESC LIMIT ?`
    ).all(...params) as RowRecord[];
    return rows.map((row) => this.mapLogEvent(row));
  }

  public listIncidents(workspaceId: string, service?: string, limit = 20): IncidentRecord[] {
    const rows = service
      ? (this.db.prepare(
          `SELECT * FROM incidents WHERE workspace_id = ? AND service = ? ORDER BY last_seen_at DESC LIMIT ?`
        ).all(workspaceId, service, limit) as RowRecord[])
      : (this.db.prepare(
          `SELECT * FROM incidents WHERE workspace_id = ? ORDER BY last_seen_at DESC LIMIT ?`
        ).all(workspaceId, limit) as RowRecord[]);
    return rows.map((row) => this.mapIncident(row));
  }

  public recordFileHash(workspaceId: string, filePath: string, contentHash: string, extractorVersion: string, parserVersion: string): void {
    this.db.prepare(
      `INSERT INTO file_hashes (workspace_id, path, content_hash, extractor_version, parser_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, path) DO UPDATE SET
         content_hash = excluded.content_hash,
         extractor_version = excluded.extractor_version,
         parser_version = excluded.parser_version,
         updated_at = excluded.updated_at`
    ).run(workspaceId, filePath, contentHash, extractorVersion, parserVersion, nowIso());
  }

  public getFileHash(workspaceId: string, filePath: string): { contentHash: string; extractorVersion: string; parserVersion: string } | undefined {
    const row = this.db.prepare(
      `SELECT content_hash, extractor_version, parser_version FROM file_hashes WHERE workspace_id = ? AND path = ?`
    ).get(workspaceId, filePath) as RowRecord | undefined;
    if (!row) {
      return undefined;
    }
    return {
      contentHash: String(row.content_hash),
      extractorVersion: String(row.extractor_version),
      parserVersion: String(row.parser_version)
    };
  }

  public startIndexJob(workspaceId: string, filesTotal: number, phase: string, message: string): string {
    const now = nowIso();
    const jobId = stableId("job", workspaceId, now, phase);
    this.db.prepare(
      `INSERT INTO index_jobs (id, workspace_id, status, phase, message, files_total, files_processed, started_at, finished_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)`
    ).run(jobId, workspaceId, "running", phase, message, filesTotal, now, now);
    return jobId;
  }

  public updateIndexJob(jobId: string, status: IndexJobStatus, phase: string, message: string, filesProcessed: number, filesTotal: number): void {
    const now = nowIso();
    this.db.prepare(
      `UPDATE index_jobs
       SET status = ?, phase = ?, message = ?, files_processed = ?, files_total = ?, finished_at = ?, updated_at = ?
       WHERE id = ?`
    ).run(status, phase, message, filesProcessed, filesTotal, status === "running" ? null : now, now, jobId);
  }

  public touchWorkspaceIndexedAt(workspaceId: string): void {
    const now = nowIso();
    this.db.prepare(`UPDATE workspaces SET last_indexed_at = ?, updated_at = ? WHERE id = ?`).run(now, now, workspaceId);
  }

  public getIndexStatus(workspaceId: string): IndexStatus {
    const job = this.db.prepare(
      `SELECT status, phase, message, files_total, files_processed, started_at, finished_at, updated_at
       FROM index_jobs
       WHERE workspace_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`
    ).get(workspaceId) as RowRecord | undefined;
    const staleRow = this.db.prepare(
      `SELECT COUNT(*) AS stale_count FROM file_hashes WHERE workspace_id = ?`
    ).get(workspaceId) as RowRecord;

    return {
      workspaceId,
      status: job ? (String(job.status) as IndexJobStatus) : "idle",
      phase: job ? String(job.phase) : "not_started",
      filesTotal: job ? Number(job.files_total) : 0,
      filesProcessed: job ? Number(job.files_processed) : 0,
      message: job ? String(job.message) : "Workspace has not been indexed yet.",
      startedAt: job?.started_at ? String(job.started_at) : undefined,
      finishedAt: job?.finished_at ? String(job.finished_at) : undefined,
      updatedAt: job?.updated_at ? String(job.updated_at) : nowIso(),
      staleFiles: Number(staleRow.stale_count)
    };
  }

  public search(workspaceId: string, query: string, limit: number): SearchHit[] {
    const sql = `
      SELECT * FROM (
        SELECT s.id AS entity_id, 'symbol' AS entity_type, s.qualified_name AS label, f.path AS path, s.summary AS summary, bm25(fts_symbols) AS rank
        FROM fts_symbols
        JOIN symbols s ON s.id = fts_symbols.entity_id
        JOIN files f ON f.id = s.file_id
        WHERE s.workspace_id = ? AND fts_symbols MATCH ?
        UNION ALL
        SELECT m.id AS entity_id, 'module' AS entity_type, m.canonical_path AS label, m.canonical_path AS path, m.summary AS summary, bm25(fts_module_summaries) AS rank
        FROM fts_module_summaries
        JOIN modules m ON m.id = fts_module_summaries.entity_id
        WHERE m.workspace_id = ? AND fts_module_summaries MATCH ?
        UNION ALL
        SELECT f.id AS entity_id, 'file' AS entity_type, f.path AS label, f.path AS path, f.summary AS summary, bm25(fts_files) AS rank
        FROM fts_files
        JOIN files f ON f.id = fts_files.entity_id
        WHERE f.workspace_id = ? AND fts_files MATCH ?
      )
      ORDER BY rank
      LIMIT ?`;

    const rows = this.db.prepare(sql).all(workspaceId, query, workspaceId, query, workspaceId, query, limit) as RowRecord[];
    return rows.map((row) => ({
      entityId: String(row.entity_id),
      entityType: row.entity_type as EntityType,
      label: String(row.label),
      path: String(row.path),
      summary: String(row.summary),
      score: Math.max(0.01, 1 / (1 + Math.abs(Number(row.rank))))
    }));
  }

  public findSymbolByName(workspaceId: string, symbolName: string): SymbolRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM symbols
       WHERE workspace_id = ? AND (local_name = ? OR qualified_name LIKE ?)
       ORDER BY exported DESC, qualified_name ASC`
    ).all(workspaceId, symbolName, `%${symbolName}%`) as RowRecord[];
    return rows.map((row) => this.mapSymbol(row));
  }

  public findModuleByPath(workspaceId: string, modulePath: string): ModuleRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM modules
       WHERE workspace_id = ? AND (canonical_path = ? OR canonical_path LIKE ?)
       ORDER BY CASE WHEN canonical_path = ? THEN 0 ELSE 1 END
       LIMIT 1`
    ).get(workspaceId, modulePath, `%${modulePath}%`, modulePath) as RowRecord | undefined;
    return row ? this.mapModule(row) : undefined;
  }

  public getModule(moduleId: string): ModuleRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM modules WHERE id = ?`).get(moduleId) as RowRecord | undefined;
    return row ? this.mapModule(row) : undefined;
  }

  public listModuleSymbols(moduleId: string): SymbolRecord[] {
    const rows = this.db.prepare(`SELECT * FROM symbols WHERE module_id = ? ORDER BY exported DESC, local_name ASC`).all(moduleId) as RowRecord[];
    return rows.map((row) => this.mapSymbol(row));
  }

  public listEdgesFrom(workspaceId: string, sourceId: string, type?: string): EdgeRecord[] {
    const rows = type
      ? (this.db.prepare(`SELECT * FROM edges WHERE workspace_id = ? AND source_id = ? AND type = ?`).all(workspaceId, sourceId, type) as RowRecord[])
      : (this.db.prepare(`SELECT * FROM edges WHERE workspace_id = ? AND source_id = ?`).all(workspaceId, sourceId) as RowRecord[]);
    return rows.map((row) => parseEdge(row));
  }

  public listEdgesTo(workspaceId: string, targetId: string, type?: string): EdgeRecord[] {
    const rows = type
      ? (this.db.prepare(`SELECT * FROM edges WHERE workspace_id = ? AND target_id = ? AND type = ?`).all(workspaceId, targetId, type) as RowRecord[])
      : (this.db.prepare(`SELECT * FROM edges WHERE workspace_id = ? AND target_id = ?`).all(workspaceId, targetId) as RowRecord[]);
    return rows.map((row) => parseEdge(row));
  }

  public getEdgeById(edgeId: string): EdgeRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM edges WHERE id = ?`).get(edgeId) as RowRecord | undefined;
    return row ? parseEdge(row) : undefined;
  }

  public listModulesByIds(moduleIds: string[]): ModuleRecord[] {
    if (moduleIds.length === 0) {
      return [];
    }
    const placeholders = moduleIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT * FROM modules WHERE id IN (${placeholders})`).all(...moduleIds) as RowRecord[];
    const modulesById = new Map(rows.map((row) => {
      const module = this.mapModule(row);
      return [module.id, module] as const;
    }));
    return moduleIds.map((moduleId) => modulesById.get(moduleId)).filter((module): module is ModuleRecord => Boolean(module));
  }

  public listPackagesByIds(packageIds: string[]): PackageRecord[] {
    if (packageIds.length === 0) {
      return [];
    }
    const placeholders = packageIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT * FROM packages WHERE id IN (${placeholders})`).all(...packageIds) as RowRecord[];
    return rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      repoId: String(row.repo_id),
      name: String(row.name),
      rootPath: String(row.root_path),
      manifestPath: String(row.manifest_path),
      packageManager: String(row.package_manager),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
  }

  public listModulesByPaths(workspaceId: string, paths: string[]): ModuleRecord[] {
    if (paths.length === 0) {
      return [];
    }
    const placeholders = paths.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT * FROM modules WHERE workspace_id = ? AND canonical_path IN (${placeholders})`).all(workspaceId, ...paths) as RowRecord[];
    return rows.map((row) => this.mapModule(row));
  }

  public listWorkspaceFiles(workspaceId: string): FileRecord[] {
    const rows = this.db.prepare(`SELECT * FROM files WHERE workspace_id = ? ORDER BY path ASC`).all(workspaceId) as RowRecord[];
    return rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      repoId: String(row.repo_id),
      packageId: row.package_id ? String(row.package_id) : undefined,
      path: String(row.path),
      language: String(row.language),
      summary: String(row.summary),
      authored: Number(row.authored) === 1,
      hash: String(row.hash),
      updatedAt: String(row.updated_at)
    }));
  }

  public deleteModuleByPath(workspaceId: string, modulePath: string): void {
    this.withTransaction(() => {
      this.deleteFileOwnedFacts(workspaceId, modulePath);
      this.db.prepare(`DELETE FROM file_hashes WHERE workspace_id = ? AND path = ?`).run(workspaceId, modulePath);
    });
  }

  private deleteFileOwnedFacts(workspaceId: string, filePath: string): void {
    const file = this.db.prepare(`SELECT id FROM files WHERE workspace_id = ? AND path = ?`).get(workspaceId, filePath) as RowRecord | undefined;
    if (!file) {
      return;
    }

    const fileId = String(file.id);
    const moduleRows = this.db.prepare(`SELECT id FROM modules WHERE file_id = ?`).all(fileId) as RowRecord[];
    const moduleIds = moduleRows.map((row) => String(row.id));

    if (moduleIds.length > 0) {
      const modulePlaceholders = moduleIds.map(() => "?").join(", ");
      const symbolRows = this.db.prepare(`SELECT id FROM symbols WHERE module_id IN (${modulePlaceholders})`).all(...moduleIds) as RowRecord[];
      const symbolIds = symbolRows.map((row) => String(row.id));

      if (symbolIds.length > 0) {
        const symbolPlaceholders = symbolIds.map(() => "?").join(", ");
        this.db.prepare(`DELETE FROM fts_symbols WHERE entity_id IN (${symbolPlaceholders})`).run(...symbolIds);
        this.db.prepare(`DELETE FROM edges WHERE workspace_id = ? AND source_id IN (${symbolPlaceholders})`).run(workspaceId, ...symbolIds);
        this.db.prepare(`DELETE FROM edges WHERE workspace_id = ? AND target_id IN (${symbolPlaceholders})`).run(workspaceId, ...symbolIds);
        this.db.prepare(`DELETE FROM symbols WHERE id IN (${symbolPlaceholders})`).run(...symbolIds);
      }

      this.db.prepare(`DELETE FROM summaries WHERE entity_id IN (${modulePlaceholders})`).run(...moduleIds);
      this.db.prepare(`DELETE FROM fts_module_summaries WHERE entity_id IN (${modulePlaceholders})`).run(...moduleIds);
      this.db.prepare(`DELETE FROM edges WHERE workspace_id = ? AND source_id IN (${modulePlaceholders})`).run(workspaceId, ...moduleIds);
      this.db.prepare(`DELETE FROM edges WHERE workspace_id = ? AND target_id IN (${modulePlaceholders})`).run(workspaceId, ...moduleIds);
      this.db.prepare(`DELETE FROM modules WHERE id IN (${modulePlaceholders})`).run(...moduleIds);
    }

    this.db.prepare(`DELETE FROM edges WHERE workspace_id = ? AND owner_file_path = ?`).run(workspaceId, filePath);
    this.db.prepare(`DELETE FROM fts_files WHERE entity_id = ?`).run(fileId);
    this.db.prepare(`DELETE FROM summaries WHERE entity_id = ?`).run(fileId);
    this.db.prepare(`DELETE FROM files WHERE id = ?`).run(fileId);
  }

  private insertEdges(edges: EdgeRecord[]): void {
    const statement = this.db.prepare(
      `INSERT INTO edges (
         id, workspace_id, source_id, source_type, target_id, target_type, type, owner_file_path,
         confidence, metadata_json, created_at, updated_at
       ) VALUES (
         @id, @workspaceId, @sourceId, @sourceType, @targetId, @targetType, @type, @ownerFilePath,
         @confidence, @metadataJson, @createdAt, @updatedAt
       )`
    );

    for (const edge of edges) {
      statement.run({
        id: edge.id,
        workspaceId: edge.workspaceId,
        sourceId: edge.sourceId,
        sourceType: edge.sourceType,
        targetId: edge.targetId,
        targetType: edge.targetType,
        type: edge.type,
        ownerFilePath: edge.ownerFilePath,
        confidence: edge.confidence,
        metadataJson: edge.metadata ? JSON.stringify(edge.metadata) : null,
        createdAt: edge.createdAt,
        updatedAt: edge.updatedAt
      } as any);
    }
  }

  private upsertSummary(summary: SummaryRecord): void {
    this.db.prepare(
      `INSERT INTO summaries (id, workspace_id, entity_id, entity_type, summary, source, updated_at)
       VALUES (@id, @workspaceId, @entityId, @entityType, @summary, @source, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         summary = excluded.summary,
         source = excluded.source,
         updated_at = excluded.updated_at`
    ).run({
      id: summary.id,
      workspaceId: summary.workspaceId,
      entityId: summary.entityId,
      entityType: summary.entityType,
      summary: summary.summary,
      source: summary.source,
      updatedAt: summary.updatedAt
    } as any);
  }

  private withTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private refreshFts(
    file: FileRecord,
    module: ModuleRecord,
    symbols: Array<Pick<SymbolRecord, "id" | "qualifiedName" | "localName" | "signature" | "summary">>
  ): void {
    this.db.prepare(`DELETE FROM fts_files WHERE entity_id = ?`).run(file.id);
    this.db.prepare(`DELETE FROM fts_symbols WHERE entity_id IN (SELECT id FROM symbols WHERE file_id = ?)`).run(file.id);
    this.db.prepare(`DELETE FROM fts_module_summaries WHERE entity_id = ?`).run(module.id);

    this.db.prepare(`INSERT INTO fts_files (entity_id, path, content) VALUES (?, ?, ?)`).run(file.id, file.path, `${file.path}\n${file.summary}`);
    this.db.prepare(`INSERT INTO fts_module_summaries (entity_id, canonical_path, summary) VALUES (?, ?, ?)`).run(module.id, module.canonicalPath, module.summary);

    const statement = this.db.prepare(`INSERT INTO fts_symbols (entity_id, qualified_name, local_name, signature, summary) VALUES (?, ?, ?, ?, ?)`);
    for (const symbol of symbols) {
      statement.run(symbol.id, symbol.qualifiedName, symbol.localName, symbol.signature ?? "", symbol.summary);
    }
  }

  private recomputeModuleDegrees(workspaceId: string): void {
    this.db.prepare(`UPDATE modules SET inbound_dependency_count = 0, outbound_dependency_count = 0 WHERE workspace_id = ?`).run(workspaceId);
    const outbound = this.db.prepare(
      `SELECT source_id, COUNT(*) AS count
       FROM edges
       WHERE workspace_id = ? AND type = 'imports' AND source_type = 'module' AND target_type = 'module'
       GROUP BY source_id`
    ).all(workspaceId) as RowRecord[];
    const inbound = this.db.prepare(
      `SELECT target_id, COUNT(*) AS count
       FROM edges
       WHERE workspace_id = ? AND type = 'imports' AND source_type = 'module' AND target_type = 'module'
       GROUP BY target_id`
    ).all(workspaceId) as RowRecord[];

    const setOutbound = this.db.prepare(`UPDATE modules SET outbound_dependency_count = ? WHERE id = ?`);
    const setInbound = this.db.prepare(`UPDATE modules SET inbound_dependency_count = ? WHERE id = ?`);

    for (const row of outbound) {
      setOutbound.run(Number(row.count), String(row.source_id));
    }
    for (const row of inbound) {
      setInbound.run(Number(row.count), String(row.target_id));
    }
  }

  private mapWorkspace(row: RowRecord): WorkspaceRecord {
    return {
      id: String(row.id),
      rootPath: String(row.root_path),
      label: String(row.label),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastIndexedAt: row.last_indexed_at ? String(row.last_indexed_at) : undefined
    };
  }

  private mapModule(row: RowRecord): ModuleRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      fileId: String(row.file_id),
      packageId: row.package_id ? String(row.package_id) : undefined,
      canonicalPath: String(row.canonical_path),
      language: String(row.language),
      summary: String(row.summary),
      publicExports: parseJson<string[]>(row.public_exports_json, []),
      inboundDependencyCount: Number(row.inbound_dependency_count),
      outboundDependencyCount: Number(row.outbound_dependency_count),
      updatedAt: String(row.updated_at)
    };
  }

  private mapLogEvent(row: RowRecord): LogEventRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      sourceName: String(row.source_name),
      filePath: String(row.file_path),
      service: String(row.service),
      level: row.level as LogLevel,
      timestamp: String(row.timestamp),
      message: String(row.message),
      rawLine: String(row.raw_line),
      updatedAt: String(row.updated_at)
    };
  }

  private mapIncident(row: RowRecord): IncidentRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      service: String(row.service),
      title: String(row.title),
      level: row.level as LogLevel,
      firstSeenAt: String(row.first_seen_at),
      lastSeenAt: String(row.last_seen_at),
      eventCount: Number(row.event_count),
      latestLogEventId: row.latest_log_event_id ? String(row.latest_log_event_id) : undefined,
      updatedAt: String(row.updated_at)
    };
  }

  private mapSymbol(row: RowRecord): SymbolRecord {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      moduleId: String(row.module_id),
      fileId: String(row.file_id),
      qualifiedName: String(row.qualified_name),
      localName: String(row.local_name),
      kind: row.kind as SymbolRecord["kind"],
      signature: row.signature ? String(row.signature) : undefined,
      exported: Number(row.exported) === 1,
      range: {
        start: {
          line: Number(row.range_start_line),
          column: Number(row.range_start_column)
        },
        end: {
          line: Number(row.range_end_line),
          column: Number(row.range_end_column)
        }
      },
      summary: String(row.summary),
      updatedAt: String(row.updated_at)
    };
  }
}
