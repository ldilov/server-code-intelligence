export type EntityType =
  | "workspace"
  | "repository"
  | "package"
  | "file"
  | "module"
  | "symbol"
  | "commit"
  | "change_group"
  | "test_suite"
  | "test_case"
  | "architecture_violation"
  | "log_event"
  | "incident";

export type EdgeType =
  | "contains"
  | "belongs_to_package"
  | "declares"
  | "exports"
  | "imports"
  | "references"
  | "calls"
  | "changed_in"
  | "tests"
  | "failed_after_change";

export type IndexJobStatus = "idle" | "running" | "completed" | "failed";
export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "unknown";
export type ViolationSeverity = "warning" | "error";
export type ArchitectureRuleKind = "allow" | "forbid";
export type TestFramework = "jest" | "vitest" | "playwright" | "unknown";
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "unknown";

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "method"
  | "field"
  | "constant"
  | "variable";

export interface RangePosition {
  line: number;
  column: number;
}

export interface Range {
  start: RangePosition;
  end: RangePosition;
}

export interface WorkspaceRecord {
  id: string;
  rootPath: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  lastIndexedAt?: string;
}

export interface RepositoryRecord {
  id: string;
  workspaceId: string;
  rootPath: string;
  vcsType: "git" | "none";
  branchName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PackageRecord {
  id: string;
  workspaceId: string;
  repoId: string;
  name: string;
  rootPath: string;
  manifestPath: string;
  packageManager: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileRecord {
  id: string;
  workspaceId: string;
  repoId: string;
  packageId?: string;
  path: string;
  language: string;
  summary: string;
  authored: boolean;
  hash: string;
  updatedAt: string;
}

export interface ModuleRecord {
  id: string;
  workspaceId: string;
  fileId: string;
  packageId?: string;
  canonicalPath: string;
  language: string;
  summary: string;
  publicExports: string[];
  inboundDependencyCount: number;
  outboundDependencyCount: number;
  updatedAt: string;
}

export interface SymbolRecord {
  id: string;
  workspaceId: string;
  moduleId: string;
  fileId: string;
  qualifiedName: string;
  localName: string;
  kind: SymbolKind;
  signature?: string;
  exported: boolean;
  range: Range;
  summary: string;
  updatedAt: string;
}

export interface CommitRecord {
  id: string;
  workspaceId: string;
  repoId: string;
  sha: string;
  authorName: string;
  authoredAt: string;
  summary: string;
  branchName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChangedFileRecord {
  path: string;
  status: GitFileStatus;
  previousPath?: string;
}

export interface ChangeGroupRecord {
  id: string;
  workspaceId: string;
  repoId: string;
  branchName?: string;
  changedFiles: ChangedFileRecord[];
  source: "working_tree";
  updatedAt: string;
}

export interface ArchitectureRuleRecord {
  id: string;
  from: string;
  to: string;
  kind: ArchitectureRuleKind;
  severity: ViolationSeverity;
  except?: Array<{
    from?: string;
    to?: string;
  }>;
  allowGenerated?: boolean;
}

export interface ArchitectureRulesConfig {
  generatedPatterns?: string[];
  rules: ArchitectureRuleRecord[];
}

export interface ArchitectureViolationRecord {
  id: string;
  workspaceId: string;
  ruleId: string;
  sourceModuleId: string;
  sourcePath: string;
  targetModuleId: string;
  targetPath: string;
  severity: ViolationSeverity;
  explanation: string;
  evidenceEdgeId?: string;
  updatedAt: string;
}

export interface TestSuiteRecord {
  id: string;
  workspaceId: string;
  filePath: string;
  framework: TestFramework;
  name: string;
  updatedAt: string;
}

export interface TestCaseRecord {
  id: string;
  workspaceId: string;
  suiteId: string;
  filePath: string;
  name: string;
  range: Range;
  updatedAt: string;
}

export interface TestFailureAnalysis {
  changedModules: ModuleRecord[];
  candidateTests: Array<{
    suite: TestSuiteRecord;
    testCase: TestCaseRecord;
    relatedModules: ModuleRecord[];
    score: number;
  }>;
  notes: string[];
}

export interface LogSourceConfig {
  name: string;
  path: string;
  service?: string;
  format?: "line" | "jsonl";
}

export interface LogIntelConfig {
  logs: LogSourceConfig[];
}

export interface LogEventRecord {
  id: string;
  workspaceId: string;
  sourceName: string;
  filePath: string;
  service: string;
  level: LogLevel;
  timestamp: string;
  message: string;
  rawLine: string;
  updatedAt: string;
}

export interface IncidentRecord {
  id: string;
  workspaceId: string;
  service: string;
  title: string;
  level: LogLevel;
  firstSeenAt: string;
  lastSeenAt: string;
  eventCount: number;
  latestLogEventId?: string;
  updatedAt: string;
}

export interface IncidentTimeline {
  branchSummary: BranchChangeSummary | null;
  testFailureAnalysis: TestFailureAnalysis;
  incidents: IncidentRecord[];
  logEvents: LogEventRecord[];
  notes: string[];
}

export interface EdgeRecord {
  id: string;
  workspaceId: string;
  sourceId: string;
  sourceType: EntityType;
  targetId: string;
  targetType: EntityType;
  type: EdgeType;
  ownerFilePath: string;
  confidence: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SummaryRecord {
  id: string;
  workspaceId: string;
  entityId: string;
  entityType: EntityType;
  summary: string;
  source: string;
  updatedAt: string;
}

export interface EvidenceReference {
  entityId: string;
  entityType: EntityType;
  label: string;
  path?: string;
  range?: Range;
  summary?: string;
  score?: number;
}

export interface EvidenceBundle {
  primary: EvidenceReference;
  related: EvidenceReference[];
  edges: EdgeRecord[];
  notes: string[];
}

export interface ToolResponse<TStructured = Record<string, unknown>> {
  summary: string;
  confidence: number;
  evidence: EvidenceBundle[];
  structured_data: TStructured;
  suggested_next_tools: string[];
}

export interface IndexStatus {
  workspaceId: string;
  status: IndexJobStatus;
  phase: string;
  filesTotal: number;
  filesProcessed: number;
  message: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
  staleFiles: number;
}

export interface ServerStatus {
  safeDefaultMode: true;
  approvedWorkspaceCount: number;
  approvedWorkspaces: WorkspaceRecord[];
  message: string;
}

export interface SearchHit {
  entityId: string;
  entityType: EntityType;
  label: string;
  path: string;
  summary: string;
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
}

export interface DependencyPathResult {
  sourceModuleId: string;
  targetModuleId: string;
  moduleIds: string[];
  edges: EdgeRecord[];
}

export interface ExtractedSymbol {
  id: string;
  localName: string;
  qualifiedName: string;
  kind: SymbolKind;
  exported: boolean;
  signature?: string;
  range: Range;
  summary: string;
}

export interface ExtractedModule {
  id: string;
  canonicalPath: string;
  language: string;
  summary: string;
  publicExports: string[];
}

export interface ExtractedFileFact {
  file: FileRecord;
  module: ModuleRecord;
  symbols: ExtractedSymbol[];
  edges: EdgeRecord[];
  summary: SummaryRecord;
  warnings: string[];
}

export interface ExtractedTestFact {
  suite: TestSuiteRecord;
  testCases: TestCaseRecord[];
  edges: EdgeRecord[];
  warnings: string[];
}

export interface ParserContext {
  workspaceId: string;
  workspaceRoot: string;
  repoId: string;
  packageId?: string;
  filePath: string;
  relativePath: string;
  hash: string;
  now: string;
}

export interface PackageManifestInfo {
  id: string;
  name: string;
  rootPath: string;
  manifestPath: string;
}

export interface BranchChangeSummary {
  branchName?: string;
  files: ChangedFileRecord[];
  modules: ModuleRecord[];
  packages: PackageRecord[];
  recentCommits: CommitRecord[];
  notes: string[];
}
