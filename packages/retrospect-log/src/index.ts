import { nowIso } from "@local-engineering-brain/shared-utils";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RetrospectEntry {
  /** Monotonically increasing sequence number within this session. */
  seq: number;
  /** MCP tool name that was invoked. */
  toolName: string;
  /** Sanitized copy of the tool input (secrets/long values truncated). */
  input: Record<string, unknown>;
  /** First N characters of the JSON-serialized structured output. */
  outputSummary: string;
  /** Whether the tool call succeeded. */
  success: boolean;
  /** Error message if the tool call failed. */
  error?: string;
  /** ISO-8601 timestamp when the call started. */
  startedAt: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Workspace ID if present in the tool input. */
  workspaceId?: string;
  /** Tools suggested by the response for next invocation. */
  suggestedNextTools?: string[];
}

export interface RetrospectFilter {
  toolName?: string;
  success?: boolean;
  workspaceId?: string;
  sinceSeq?: number;
  limit?: number;
}

export interface RetrospectStats {
  totalCalls: number;
  successCount: number;
  failureCount: number;
  toolFrequency: Record<string, number>;
  averageDurationMs: number;
  sessionStartedAt: string;
  lastCallAt?: string;
}

export interface RetrospectSnapshot {
  entries: RetrospectEntry[];
  stats: RetrospectStats;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface RetrospectBufferOptions {
  /** Maximum number of entries to retain in the ring buffer. Default: 500. */
  maxEntries?: number;
  /** Maximum characters for the output summary field. Default: 800. */
  outputSummaryMaxChars?: number;
  /** Fields to redact from tool inputs. Default: common secret field names. */
  redactFields?: string[];
}

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_OUTPUT_SUMMARY_MAX_CHARS = 800;
const DEFAULT_REDACT_FIELDS = ["password", "token", "secret", "apiKey", "api_key", "authorization"];

// ─── Buffer Implementation ──────────────────────────────────────────────────

export class RetrospectBuffer {
  private readonly entries: RetrospectEntry[] = [];
  private readonly maxEntries: number;
  private readonly outputSummaryMaxChars: number;
  private readonly redactFields: Set<string>;
  private seq = 0;
  private readonly sessionStartedAt: string;

  public constructor(options: RetrospectBufferOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.outputSummaryMaxChars = options.outputSummaryMaxChars ?? DEFAULT_OUTPUT_SUMMARY_MAX_CHARS;
    this.redactFields = new Set(
      (options.redactFields ?? DEFAULT_REDACT_FIELDS).map((field) => field.toLowerCase())
    );
    this.sessionStartedAt = nowIso();
  }

  /**
   * Record a tool invocation. Call this AFTER the tool handler has completed.
   */
  public record(
    toolName: string,
    input: Record<string, unknown>,
    output: unknown,
    success: boolean,
    durationMs: number,
    error?: string,
    suggestedNextTools?: string[]
  ): RetrospectEntry {
    this.seq += 1;

    const entry: RetrospectEntry = {
      seq: this.seq,
      toolName,
      input: this.sanitizeInput(input),
      outputSummary: this.truncateOutput(output),
      success,
      error: error ? String(error).slice(0, 500) : undefined,
      startedAt: nowIso(),
      durationMs: Math.round(durationMs),
      workspaceId: typeof input?.["workspaceId"] === "string" ? input["workspaceId"] : undefined,
      suggestedNextTools
    };

    this.entries.push(entry);

    // Ring buffer eviction
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }

    return entry;
  }

  /**
   * Query the buffer with optional filters.
   */
  public query(filter: RetrospectFilter = {}): RetrospectEntry[] {
    let result = this.entries;

    if (filter.toolName) {
      const name = filter.toolName;
      result = result.filter((entry) => entry.toolName === name);
    }
    if (filter.success !== undefined) {
      const success = filter.success;
      result = result.filter((entry) => entry.success === success);
    }
    if (filter.workspaceId) {
      const wsId = filter.workspaceId;
      result = result.filter((entry) => entry.workspaceId === wsId);
    }
    if (filter.sinceSeq !== undefined) {
      const sinceSeq = filter.sinceSeq;
      result = result.filter((entry) => entry.seq > sinceSeq);
    }

    const limit = filter.limit ?? this.maxEntries;
    return result.slice(-limit);
  }

  /**
   * Compute aggregate statistics for the current session.
   */
  public getStats(): RetrospectStats {
    const totalCalls = this.entries.length;
    const successCount = this.entries.filter((entry) => entry.success).length;
    const failureCount = totalCalls - successCount;
    const toolFrequency: Record<string, number> = {};
    let totalDuration = 0;

    for (const entry of this.entries) {
      toolFrequency[entry.toolName] = (toolFrequency[entry.toolName] ?? 0) + 1;
      totalDuration += entry.durationMs;
    }

    return {
      totalCalls,
      successCount,
      failureCount,
      toolFrequency,
      averageDurationMs: totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0,
      sessionStartedAt: this.sessionStartedAt,
      lastCallAt: this.entries.length > 0 ? this.entries[this.entries.length - 1]!.startedAt : undefined
    };
  }

  /**
   * Return the full snapshot (entries + stats) for serialization.
   */
  public snapshot(filter?: RetrospectFilter): RetrospectSnapshot {
    return {
      entries: this.query(filter),
      stats: this.getStats()
    };
  }

  /**
   * Render the buffer as a Markdown document suitable for agent retrospection.
   */
  public toMarkdown(filter?: RetrospectFilter): string {
    const snapshot = this.snapshot(filter);
    const lines: string[] = [];

    lines.push("# Retrospect Log");
    lines.push("");
    lines.push(`**Session started:** ${snapshot.stats.sessionStartedAt}`);
    lines.push(`**Total calls:** ${snapshot.stats.totalCalls} (${snapshot.stats.successCount} ok, ${snapshot.stats.failureCount} failed)`);
    lines.push(`**Avg duration:** ${snapshot.stats.averageDurationMs}ms`);
    lines.push("");

    // Tool frequency summary
    lines.push("## Tool Usage Summary");
    lines.push("");
    lines.push("| Tool | Calls |");
    lines.push("| ---- | ----- |");
    const sorted = Object.entries(snapshot.stats.toolFrequency).sort(([, a], [, b]) => b - a);
    for (const [tool, count] of sorted) {
      lines.push(`| ${tool} | ${count} |`);
    }
    lines.push("");

    // Chronological log
    lines.push("## Invocation Log");
    lines.push("");

    for (const entry of snapshot.entries) {
      const status = entry.success ? "OK" : "FAIL";
      lines.push(`### #${entry.seq} \`${entry.toolName}\` [${status}] — ${entry.durationMs}ms`);
      lines.push("");
      lines.push("**Input:**");
      lines.push("```json");
      lines.push(JSON.stringify(entry.input, null, 2));
      lines.push("```");
      lines.push("");

      if (entry.success) {
        lines.push("**Output summary:**");
        lines.push("```");
        lines.push(entry.outputSummary);
        lines.push("```");
      } else {
        lines.push(`**Error:** ${entry.error ?? "unknown"}`);
      }

      if (entry.suggestedNextTools && entry.suggestedNextTools.length > 0) {
        lines.push("");
        lines.push(`**Suggested next:** ${entry.suggestedNextTools.join(", ")}`);
      }

      lines.push("");
      lines.push("---");
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Clear all entries but keep the session metadata.
   */
  public clear(): void {
    this.entries.length = 0;
  }

  /**
   * Number of entries currently buffered.
   */
  public get size(): number {
    return this.entries.length;
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (this.redactFields.has(key.toLowerCase())) {
        sanitized[key] = "[REDACTED]";
      } else if (typeof value === "string" && value.length > 500) {
        sanitized[key] = `${value.slice(0, 497)}...`;
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  private truncateOutput(output: unknown): string {
    try {
      const serialized = JSON.stringify(output, null, 2);
      if (serialized.length <= this.outputSummaryMaxChars) {
        return serialized;
      }
      return `${serialized.slice(0, this.outputSummaryMaxChars - 3)}...`;
    } catch {
      return "[non-serializable output]";
    }
  }
}

// ─── Middleware ──────────────────────────────────────────────────────────────

/**
 * Higher-order function that wraps an MCP tool handler to automatically record
 * invocations in the retrospect buffer. Drop-in, zero-change to existing handlers.
 *
 * Usage:
 *   const handler = withRetrospect(buffer, "search_code", async (args) => { ... });
 */
export function withRetrospect<TArgs, TResult>(
  buffer: RetrospectBuffer,
  toolName: string,
  handler: (args: TArgs) => TResult | Promise<TResult>
): (args: TArgs) => Promise<TResult> {
  return async (args: TArgs) => {
    const start = performance.now();
    let success = true;
    let error: string | undefined;
    let result: TResult;
    let suggestedNextTools: string[] | undefined;

    try {
      result = await handler(args);
      // Extract suggested_next_tools if present in the result
      if (result && typeof result === "object" && "structuredContent" in result) {
        const structured = (result as Record<string, unknown>).structuredContent;
        if (structured && typeof structured === "object" && "suggested_next_tools" in structured) {
          suggestedNextTools = (structured as Record<string, unknown>).suggested_next_tools as string[];
        }
      }
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      const durationMs = performance.now() - start;
      buffer.record(
        toolName,
        (args && typeof args === "object" ? args : {}) as Record<string, unknown>,
        success ? result! : undefined,
        success,
        durationMs,
        error,
        suggestedNextTools
      );
    }

    return result!;
  };
}
