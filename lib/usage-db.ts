import { existsSync, mkdirSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "path";
import { currentHost } from "./hosts/context";
import type { Host } from "./hosts/registry";
import { readModelsConfig, type ModelsFileConfig } from "./omp/models-config";
import { getAgentDir, getSessionsDir } from "./omp/paths";
import { listSessionFileStats, type SessionFileStat } from "./omp/session-files";
import {
  formatChartDateLabel,
  formatFullDateLabel,
  parseSessionUsage,
  toLocalDateString,
  toLocalMonthString,
  computeTimeRangeBounds,
} from "./usage-service";
import { getProviderColor, getProviderDisplayName } from "./usage-rates";
import type {
  DayUsageSummary,
  ModelUsageSummary,
  ProjectUsageSummary,
  ProviderUsageSummary,
  TimeSeriesPoint,
  UsageQueryOptions,
  UsageRecord,
  UsageReport,
  UsageSummary,
} from "./usage-types";

/**
 * Usage analytics over omp session transcripts.
 *
 * Local host: ompweb keeps an incremental SQLite index (`<agentDir>/usage.db`,
 * node:sqlite) of every session file's usage records and answers reports with
 * SQL aggregations.
 *
 * Remote host: nothing is mirrored or indexed from here (indexing would pull
 * every transcript over ssh). If a usage.db already exists on that machine
 * and its `sqlite3` CLI is available, the same aggregations run there in ONE
 * `sqlite3 -readonly -json` round trip; otherwise the report is empty and
 * flagged `unsupported`. The local index is never written for a remote host.
 */

/** Report plus host-capability flag: `unsupported` is set when the host has
 * no readable usage index (remote without sqlite3 or without usage.db). */
export type UsageReportResponse = UsageReport & { unsupported?: boolean };

declare global {
  var __ompUsageDatabase: DatabaseSync | undefined;
  var __ompUsageDatabasePath: string | undefined;
  var __ompRemoteUsageUnsupported: Map<string, number> | undefined;
}

/** Get the path to the usage SQLite database file (~/.omp/agent/usage.db).
 * Local host only: the directory is created on demand. */
export function getUsageDbPath(): string {
  const dir = getAgentDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, "usage.db");
}

/**
 * Open or reuse the persistent SQLite database for usage tracking.
 */
export function getUsageDatabase(customPath?: string): DatabaseSync {
  const targetPath = customPath || getUsageDbPath();

  if (globalThis.__ompUsageDatabase && globalThis.__ompUsageDatabasePath === targetPath) {
    return globalThis.__ompUsageDatabase;
  }

  if (globalThis.__ompUsageDatabase) {
    try {
      globalThis.__ompUsageDatabase.close();
    } catch {
      // Ignore close error on re-init
    }
  }

  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(targetPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");

  // Initialize schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS synced_files (
      file_path TEXT PRIMARY KEY,
      mtime_ms REAL NOT NULL,
      file_size INTEGER NOT NULL,
      records_count INTEGER NOT NULL,
      synced_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_cwd TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      cost REAL NOT NULL,
      cache_savings REAL NOT NULL,
      cost_quality TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_usage_records_timestamp ON usage_records(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_records_file_path ON usage_records(file_path);
    CREATE INDEX IF NOT EXISTS idx_usage_records_provider ON usage_records(provider);
    CREATE INDEX IF NOT EXISTS idx_usage_records_session_cwd ON usage_records(session_cwd);
  `);

  globalThis.__ompUsageDatabase = db;
  globalThis.__ompUsageDatabasePath = targetPath;
  return db;
}

/** Close the usage database instance. */
export function closeUsageDatabase(): void {
  if (globalThis.__ompUsageDatabase) {
    try {
      globalThis.__ompUsageDatabase.close();
    } catch {
      // Ignore
    }
    globalThis.__ompUsageDatabase = undefined;
    globalThis.__ompUsageDatabasePath = undefined;
  }
}

export interface SyncStats {
  filesScanned: number;
  filesUpdated: number;
  filesDeleted: number;
  recordsInserted: number;
}

/**
 * Incrementally sync session .jsonl files into the SQLite usage database.
 * Only parses files that are new or whose mtime/size has changed. Accepts
 * plain paths (each is stat'ed) or the stats a directory walk already
 * produced. Local host only — the index is never populated for a remote host.
 */
export async function syncSessionFilesToDb(
  sessionFiles: Array<string | SessionFileStat>,
  customModelsConfig?: ModelsFileConfig,
  customDb?: DatabaseSync,
  host: Host = currentHost(),
): Promise<SyncStats> {
  const db = customDb || getUsageDatabase();
  const modelsConfig = customModelsConfig ?? await readModelsConfig(host);
  const now = Date.now();

  // 1. Fetch currently synced files from SQLite
  const syncedRows = db.prepare("SELECT file_path, mtime_ms, file_size FROM synced_files").all() as Array<{
    file_path: string;
    mtime_ms: number;
    file_size: number;
  }>;

  const syncedMap = new Map<string, { mtime_ms: number; file_size: number }>();
  for (const row of syncedRows) {
    syncedMap.set(row.file_path, { mtime_ms: row.mtime_ms, file_size: row.file_size });
  }

  let filesUpdated = 0;
  let recordsInserted = 0;

  const insertRecordStmt = db.prepare(`
    INSERT INTO usage_records (
      file_path, session_id, session_cwd, timestamp, provider, model,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
      cache_write_tokens, total_tokens, cost, cache_savings, cost_quality
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
  `);

  const deleteRecordsStmt = db.prepare("DELETE FROM usage_records WHERE file_path = ?");
  const upsertSyncedFileStmt = db.prepare(`
    INSERT OR REPLACE INTO synced_files (file_path, mtime_ms, file_size, records_count, synced_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const currentFilesSet = new Set<string>();

  // 2. Incremental sync for new / modified files
  for (const file of sessionFiles) {
    let stats: SessionFileStat;
    if (typeof file === "string") {
      try {
        const info = await host.fs.stat(file);
        if (!info.isFile()) continue;
        stats = { path: file, size: info.size, mtimeMs: info.mtimeMs };
      } catch {
        continue;
      }
    } else {
      stats = file;
    }
    const filePath = stats.path;
    if (stats.size === 0) continue;
    currentFilesSet.add(filePath);
    const existing = syncedMap.get(filePath);
    if (existing && existing.mtime_ms === stats.mtimeMs && existing.file_size === stats.size) {
      // File has not changed since last sync
      continue;
    }

    // Parse records from disk
    const records: UsageRecord[] = await parseSessionUsage(filePath, modelsConfig, host);

    // Save in transaction
    db.exec("BEGIN TRANSACTION;");
    try {
      deleteRecordsStmt.run(filePath);

      for (const r of records) {
        insertRecordStmt.run(
          filePath,
          r.sessionId,
          r.sessionCwd,
          r.timestamp,
          r.provider,
          r.model,
          r.input,
          r.output,
          r.reasoning,
          r.cacheRead,
          r.cacheWrite,
          r.totalTokens,
          r.cost,
          r.cacheSavings,
          r.costQuality,
        );
        recordsInserted++;
      }

      upsertSyncedFileStmt.run(filePath, stats.mtimeMs, stats.size, records.length, now);
      db.exec("COMMIT;");
      filesUpdated++;
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  }

  // 3. Purge session files that vanished (or emptied) since the last sync.
  let filesDeleted = 0;
  const deleteSyncedFileStmt = db.prepare("DELETE FROM synced_files WHERE file_path = ?");

  for (const filePath of syncedMap.keys()) {
    if (!currentFilesSet.has(filePath)) {
      db.exec("BEGIN TRANSACTION;");
      try {
        deleteRecordsStmt.run(filePath);
        deleteSyncedFileStmt.run(filePath);
        db.exec("COMMIT;");
        filesDeleted++;
      } catch (err) {
        db.exec("ROLLBACK;");
        throw err;
      }
    }
  }

  return {
    filesScanned: sessionFiles.length,
    filesUpdated,
    filesDeleted,
    recordsInserted,
  };
}

// ============================================================================
// Report queries (shared by the local node:sqlite path and the remote CLI path)
// ============================================================================

type SqlParam = number | string;
type Row = Record<string, unknown>;

interface UsageQuery {
  name: string;
  sql: string;
  params: SqlParam[];
}

interface ReportWindow {
  startMs: number;
  endMs: number;
  projectFilter?: string;
  isMonthly: boolean;
}

function buildUsageQueries(window: ReportWindow): UsageQuery[] {
  const params: SqlParam[] = [window.startMs, window.endMs];
  let whereProject = "";
  if (window.projectFilter) {
    whereProject = " AND LOWER(session_cwd) LIKE ? ";
    params.push(`%${window.projectFilter}%`);
  }
  const where = `WHERE timestamp >= ? AND timestamp <= ? ${whereProject}`;
  const strftimeFormat = window.isMonthly ? "%Y-%m" : "%Y-%m-%d";
  return [
    {
      name: "summary",
      sql: `
      SELECT
        COUNT(*) AS usageRecordsCount,
        COALESCE(SUM(cost), 0) AS totalCost,
        COALESCE(SUM(total_tokens), 0) AS totalTokens,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
        COALESCE(SUM(cache_savings), 0) AS cacheSavings,
        COUNT(DISTINCT strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime')) AS activeDays,
        SUM(CASE WHEN cost_quality = 'provider_reported' THEN 1 ELSE 0 END) AS providerReportedCount,
        SUM(CASE WHEN cost_quality = 'model_priced' THEN 1 ELSE 0 END) AS modelPricedCount,
        SUM(CASE WHEN cost_quality = 'unpriced' THEN 1 ELSE 0 END) AS unpricedCount
      FROM usage_records
      ${where}`,
      params,
    },
    {
      name: "providers",
      sql: `
      SELECT
        provider,
        COALESCE(SUM(cost), 0) AS cost,
        COALESCE(SUM(total_tokens), 0) AS tokens
      FROM usage_records
      ${where}
      GROUP BY provider
      ORDER BY cost DESC, tokens DESC`,
      params,
    },
    {
      name: "timeSeries",
      sql: `
      SELECT
        strftime('${strftimeFormat}', timestamp / 1000, 'unixepoch', 'localtime') AS bucketDate,
        provider,
        MIN(timestamp) AS minTimestamp,
        COALESCE(SUM(cost), 0) AS cost,
        COALESCE(SUM(total_tokens), 0) AS tokens
      FROM usage_records
      ${where}
      GROUP BY bucketDate, provider
      ORDER BY bucketDate ASC`,
      params,
    },
    {
      name: "models",
      sql: `
      SELECT
        model,
        provider,
        COALESCE(SUM(cost), 0) AS cost,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
        COALESCE(SUM(cache_write_tokens), 0) AS cacheWriteTokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
        COUNT(*) AS recordsCount
      FROM usage_records
      ${where}
      GROUP BY model, provider
      ORDER BY cost DESC, tokens DESC`,
      params,
    },
    {
      name: "days",
      sql: `
      SELECT
        strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch', 'localtime') AS date,
        COALESCE(SUM(cost), 0) AS cost,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(SUM(input_tokens), 0) AS inputTokens,
        COALESCE(SUM(output_tokens), 0) AS outputTokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens
      FROM usage_records
      ${where}
      GROUP BY date
      ORDER BY date DESC`,
      params,
    },
    {
      name: "projects",
      sql: `
      SELECT
        session_cwd AS project,
        COALESCE(SUM(cost), 0) AS cost,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COUNT(DISTINCT session_id) AS sessionsCount
      FROM usage_records
      ${where}
      GROUP BY session_cwd
      ORDER BY cost DESC, tokens DESC`,
      params,
    },
    {
      name: "syncedTotal",
      sql: "SELECT COUNT(*) AS c FROM synced_files",
      params: [],
    },
    {
      name: "syncedInWindow",
      sql: `
      SELECT COUNT(DISTINCT file_path) AS c
      FROM usage_records
      ${where}`,
      params,
    },
  ];
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

interface ReportContext extends ReportWindow {
  startTime: number;
  timeRange: UsageReport["timeRange"];
  granularity: UsageReport["granularity"];
  /** Fallback for transcriptsScanned when the index has no synced_files row count. */
  scannedFallback: number;
}

/** Assemble the report from the raw rows of every query in buildUsageQueries. */
function buildUsageReport(rows: Map<string, Row[]>, ctx: ReportContext): UsageReport {
  const summaryRow = rows.get("summary")?.[0] ?? {};
  const totalCost = num(summaryRow.totalCost);
  const totalTokens = num(summaryRow.totalTokens);
  const inputTokens = num(summaryRow.inputTokens);
  const outputTokens = num(summaryRow.outputTokens);
  const reasoningTokens = num(summaryRow.reasoningTokens);
  const cacheReadTokens = num(summaryRow.cacheReadTokens);
  const cacheWriteTokens = num(summaryRow.cacheWriteTokens);
  const cacheSavings = num(summaryRow.cacheSavings);
  const activeDays = num(summaryRow.activeDays);
  const totalRecords = num(summaryRow.usageRecordsCount);

  const costQuality = {
    providerReported: totalRecords > 0 ? (num(summaryRow.providerReportedCount) / totalRecords) * 100 : 0,
    modelPriced: totalRecords > 0 ? (num(summaryRow.modelPricedCount) / totalRecords) * 100 : 0,
    unpriced: totalRecords > 0 ? (num(summaryRow.unpricedCount) / totalRecords) * 100 : 0,
  };

  const tokensPerActiveDay = activeDays > 0 ? Math.round(totalTokens / activeDays) : 0;
  const cachePercentage =
    cacheReadTokens + inputTokens > 0 ? (cacheReadTokens / (cacheReadTokens + inputTokens)) * 100 : 0;

  const summary: UsageSummary = {
    totalCost,
    totalTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheSavings,
    activeDays,
    tokensPerActiveDay,
    cachePercentage,
    costQuality,
  };

  const share = (cost: number, tokens: number): number =>
    totalCost > 0 ? (cost / totalCost) * 100 : totalTokens > 0 ? (tokens / totalTokens) * 100 : 0;

  const providers: ProviderUsageSummary[] = (rows.get("providers") ?? []).map((row) => {
    const provider = str(row.provider);
    const cost = num(row.cost);
    const tokens = num(row.tokens);
    return {
      provider,
      name: getProviderDisplayName(provider),
      cost,
      tokens,
      share: share(cost, tokens),
      color: getProviderColor(provider),
    };
  });

  const { isMonthly, startMs, endMs } = ctx;
  const timeSeriesMap = new Map<
    string,
    {
      timestamp: number;
      totalCost: number;
      totalTokens: number;
      byProvider: Record<string, { cost: number; tokens: number }>;
    }
  >();

  // Continuous bucket interpolation (bounded to prevent multi-decade stalls)
  if (startMs > 0 && endMs >= startMs) {
    const cur = new Date(startMs);
    const end = new Date(endMs);
    const maxDailySpanMs = 730 * 86400 * 1000;
    const maxMonthlySpanMonths = 120;

    if (isMonthly) {
      cur.setDate(1);
      let monthsCount = 0;
      while (
        (cur <= end || toLocalMonthString(cur) === toLocalMonthString(end)) &&
        monthsCount < maxMonthlySpanMonths
      ) {
        const key = toLocalMonthString(cur);
        if (!timeSeriesMap.has(key)) {
          timeSeriesMap.set(key, {
            timestamp: cur.getTime(),
            totalCost: 0,
            totalTokens: 0,
            byProvider: {},
          });
        }
        cur.setMonth(cur.getMonth() + 1);
        monthsCount++;
      }
    } else {
      if (end.getTime() - cur.getTime() > maxDailySpanMs) {
        cur.setTime(end.getTime() - maxDailySpanMs);
      }
      let daysCount = 0;
      while ((cur <= end || toLocalDateString(cur) === toLocalDateString(end)) && daysCount < 730) {
        const key = toLocalDateString(cur);
        if (!timeSeriesMap.has(key)) {
          timeSeriesMap.set(key, {
            timestamp: cur.getTime(),
            totalCost: 0,
            totalTokens: 0,
            byProvider: {},
          });
        }
        cur.setDate(cur.getDate() + 1);
        daysCount++;
      }
    }
  }

  // Populate actual data points from SQL rows
  for (const row of rows.get("timeSeries") ?? []) {
    const key = str(row.bucketDate);
    const provider = str(row.provider);
    let bucket = timeSeriesMap.get(key);
    if (!bucket) {
      bucket = {
        timestamp: num(row.minTimestamp),
        totalCost: 0,
        totalTokens: 0,
        byProvider: {},
      };
      timeSeriesMap.set(key, bucket);
    }

    bucket.totalCost += num(row.cost);
    bucket.totalTokens += num(row.tokens);

    if (!bucket.byProvider[provider]) {
      bucket.byProvider[provider] = { cost: 0, tokens: 0 };
    }
    bucket.byProvider[provider].cost += num(row.cost);
    bucket.byProvider[provider].tokens += num(row.tokens);
  }

  const timeSeries: TimeSeriesPoint[] = Array.from(timeSeriesMap.entries())
    .map(([date, data]) => ({
      date,
      label: formatChartDateLabel(date, isMonthly),
      timestamp: data.timestamp,
      totalCost: data.totalCost,
      totalTokens: data.totalTokens,
      byProvider: data.byProvider,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const modelBreakdown: ModelUsageSummary[] = (rows.get("models") ?? []).map((row) => ({
    model: str(row.model),
    provider: str(row.provider),
    cost: num(row.cost),
    tokens: num(row.tokens),
    inputTokens: num(row.inputTokens),
    outputTokens: num(row.outputTokens),
    cacheReadTokens: num(row.cacheReadTokens),
    cacheWriteTokens: num(row.cacheWriteTokens),
    reasoningTokens: num(row.reasoningTokens),
    share: share(num(row.cost), num(row.tokens)),
    recordsCount: num(row.recordsCount),
  }));

  const dayBreakdown: DayUsageSummary[] = (rows.get("days") ?? []).map((row) => ({
    date: str(row.date),
    cost: num(row.cost),
    tokens: num(row.tokens),
    inputTokens: num(row.inputTokens),
    outputTokens: num(row.outputTokens),
    cacheReadTokens: num(row.cacheReadTokens),
    label: formatFullDateLabel(str(row.date)),
    share: share(num(row.cost), num(row.tokens)),
  }));

  const projectBreakdown: ProjectUsageSummary[] = (rows.get("projects") ?? []).map((row) => {
    const project = str(row.project) || "Default Project";
    return {
      project,
      projectName: basename(project) || project,
      cost: num(row.cost),
      tokens: num(row.tokens),
      share: share(num(row.cost), num(row.tokens)),
      sessionsCount: num(row.sessionsCount),
    };
  });

  const totalSyncedRow = rows.get("syncedTotal")?.[0];
  const transcriptsScanned = totalSyncedRow ? num(totalSyncedRow.c) : ctx.scannedFallback;
  const transcriptsInWindow = num(rows.get("syncedInWindow")?.[0]?.c);
  const transcriptsOutsideWindow = Math.max(0, transcriptsScanned - transcriptsInWindow);
  const durationSeconds = Math.max(0.001, (Date.now() - ctx.startTime) / 1000);

  return {
    timeRange: ctx.timeRange,
    granularity: ctx.granularity,
    summary,
    providers,
    timeSeries,
    modelBreakdown,
    dayBreakdown,
    projectBreakdown,
    scanInfo: {
      transcriptsScanned,
      transcriptsOutsideWindow,
      usageRecordsCount: totalRecords,
      durationSeconds: parseFloat(durationSeconds.toFixed(3)),
      scannedAt: Date.now(),
    },
  };
}

function reportContext(options: UsageQueryOptions, startTime: number): ReportContext {
  const timeRange = options.range || "30d";
  const granularity = options.granularity || "daily";
  const projectFilter = options.project ? options.project.trim().toLowerCase() : undefined;
  const hasExplicitBounds =
    typeof options.from === "number" &&
    typeof options.to === "number" &&
    !isNaN(options.from) &&
    !isNaN(options.to);
  const { startMs, endMs } = hasExplicitBounds
    ? { startMs: options.from!, endMs: options.to! }
    : computeTimeRangeBounds(timeRange, startTime);
  return {
    startMs,
    endMs,
    projectFilter,
    isMonthly: granularity === "monthly",
    startTime,
    timeRange,
    granularity,
    scannedFallback: 0,
  };
}

// ============================================================================
// Remote host: read-only `sqlite3 -json` in one round trip
// ============================================================================

// A host without sqlite3 / usage.db is re-checked this often; every usage
// request in between answers "unsupported" without a round trip.
const REMOTE_UNSUPPORTED_TTL_MS = 60_000;

function remoteUnsupportedCache(): Map<string, number> {
  if (!globalThis.__ompRemoteUsageUnsupported) globalThis.__ompRemoteUsageUnsupported = new Map();
  return globalThis.__ompRemoteUsageUnsupported;
}

function sqlLiteral(value: SqlParam): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite SQL parameter");
    return String(Math.trunc(value));
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** Inline the positional parameters of a query as SQL literals (the CLI has
 * no bind API). Only numbers and quoted strings are ever inlined. */
export function inlineSqlParams(sql: string, params: SqlParam[]): string {
  let index = 0;
  const inlined = sql.replace(/\?/g, () => {
    const value = params[index++];
    if (value === undefined) throw new Error("Missing SQL parameter");
    return sqlLiteral(value);
  });
  if (index !== params.length) throw new Error("Unused SQL parameter");
  return inlined;
}

/** One SQL script that tags every result row with its query name, so the
 * concatenated `sqlite3 -json` output can be split back per query even when
 * some queries return no rows (the CLI prints nothing for those). */
export function buildRemoteUsageScript(queries: UsageQuery[]): string {
  return queries
    .map((query) => `SELECT ${sqlLiteral(query.name)} AS __q, * FROM (${inlineSqlParams(query.sql, query.params)});`)
    .join("\n");
}

/** Parse `sqlite3 -json` output: one JSON array per non-empty statement,
 * separated by newlines. Rows are grouped by their `__q` tag. */
export function parseRemoteUsageRows(output: string): Map<string, Row[]> {
  const rows = new Map<string, Row[]>();
  const text = output.trim();
  if (!text) return rows;
  // String values never contain a raw newline (the CLI escapes them), so a
  // "]" + newline + "[" sequence only ever separates two result arrays.
  const combined = JSON.parse(`[${text.replace(/\]\s*\n\s*\[/g, ",").slice(1, -1)}]`) as unknown;
  if (!Array.isArray(combined)) return rows;
  for (const row of combined) {
    if (!row || typeof row !== "object") continue;
    const { __q, ...rest } = row as Row & { __q?: unknown };
    if (typeof __q !== "string") continue;
    let list = rows.get(__q);
    if (!list) {
      list = [];
      rows.set(__q, list);
    }
    list.push(rest);
  }
  return rows;
}

// Exit codes the script reserves for "not an error, just unsupported".
const REMOTE_NO_DB = 44;
const REMOTE_NO_SQLITE3 = 45;
const REMOTE_USAGE_SCRIPT = [
  'db="$1"; sql="$2"',
  `[ -f "$db" ] || exit ${REMOTE_NO_DB}`,
  `command -v sqlite3 >/dev/null 2>&1 || exit ${REMOTE_NO_SQLITE3}`,
  'exec sqlite3 -readonly -json "$db" "$sql"',
].join("\n");

async function getRemoteUsageReport(options: UsageQueryOptions, host: Host): Promise<UsageReportResponse> {
  const startTime = Date.now();
  const ctx = reportContext(options, startTime);
  const unsupported = (): UsageReportResponse => {
    remoteUnsupportedCache().set(host.id, Date.now() + REMOTE_UNSUPPORTED_TTL_MS);
    return { ...buildUsageReport(new Map(), ctx), unsupported: true };
  };
  const cachedUntil = remoteUnsupportedCache().get(host.id) ?? 0;
  if (!options.forceRefresh && cachedUntil > Date.now()) return { ...buildUsageReport(new Map(), ctx), unsupported: true };
  if (!host.agentDir) return unsupported();

  const dbPath = host.pathApi.join(host.agentDir, "usage.db");
  const script = buildRemoteUsageScript(buildUsageQueries(ctx));
  const result = await host.executor.exec(["sh", "-c", REMOTE_USAGE_SCRIPT, "sh", dbPath, script], {
    allowFailure: true,
    timeoutMs: 120_000,
  });
  if (result.code === REMOTE_NO_DB || result.code === REMOTE_NO_SQLITE3) return unsupported();
  if (result.code !== 0) {
    // An index without ompweb's tables (or a CLI too old for -json) is a
    // capability gap, not a failure worth a 500.
    if (/no such table|unknown option|Error: near/i.test(result.stderr)) return unsupported();
    throw new Error(`sqlite3 failed on host "${host.id}": ${result.stderr.trim().split("\n").slice(-1)[0] || `exit ${result.code}`}`);
  }
  remoteUnsupportedCache().delete(host.id);
  return buildUsageReport(parseRemoteUsageRows(result.stdout.toString("utf8")), ctx);
}

// ============================================================================
// Entry point
// ============================================================================

/**
 * Generate a full UsageReport for the current host. The local host syncs its
 * SQLite index from the session files first; a remote host is queried
 * read-only through its own sqlite3 (see module comment). Passing `customDb`
 * forces the local path (tests).
 */
export async function getUsageReportFromDb(
  options: UsageQueryOptions = {},
  customDb?: DatabaseSync,
): Promise<UsageReportResponse> {
  const host = currentHost();
  if (!customDb && !host.isLocal) return getRemoteUsageReport(options, host);

  const startTime = Date.now();
  const ctx = reportContext(options, startTime);
  const db = customDb || getUsageDatabase();
  if (options.forceRefresh) {
    try {
      db.exec("DELETE FROM synced_files; DELETE FROM usage_records;");
    } catch {
      // Ignore
    }
  }

  // Sync latest sessions from disk before querying: one directory walk gives
  // every file's size and mtime, so unchanged files cost no further I/O.
  const sessionFiles = await listSessionFileStats(getSessionsDir(), host);
  await syncSessionFilesToDb(sessionFiles, undefined, db, host);
  ctx.scannedFallback = sessionFiles.length;

  const rows = new Map<string, Row[]>();
  for (const query of buildUsageQueries(ctx)) {
    rows.set(query.name, db.prepare(query.sql).all(...query.params) as Row[]);
  }
  return buildUsageReport(rows, ctx);
}
