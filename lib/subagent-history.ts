// On-disk subagent history + transcript reading for omp-web.
//
// omp writes each subagent's session transcript to the PARENT session's
// sibling artifacts directory: `<session-dir>/<subagent-id>.jsonl` (plus
// `<id>.md` outputs and `<id>.<tool>.log` artifact spills). The parent's task
// toolResult `details` persist `progress: AgentProgress[]` and
// `results: SingleResult[]` snapshots, so the roster can be recovered after a
// page reload without the live RPC registry (get_subagent_messages is
// registry-gated and rejects unknown session files).
//
// Every read goes through the session host's filesystem boundary: nothing is
// mirrored locally, reads are bounded, and remote lookups are batched so a
// roster costs one directory listing rather than one probe per agent.

import { open } from "fs/promises";
import { currentHost } from "./hosts/context";
import type { Host } from "./hosts/registry";
import { getSessionEntries, entryToUiMessage } from "./session-reader";
import { hostPath } from "./omp/paths";
import { parseJsonlLenient } from "./omp/session-files";
import { parseSubagentProgress } from "./subagent-types";
import type { SubagentHistoryEntry, SubagentHistoryResult, SubagentAgentSource } from "./subagent-types";
import type { AgentMessage, SessionEntry } from "./types";
import { asNumber, asString, isRecord } from "./type-guards";
import { taskResultStructuredOutput, taskResultUsageCost } from "./task-result-details";

/** Sibling artifacts directory for a parent session file (a path on the
 * session's host: POSIX joins for remote hosts). */
export function siblingDirForSession(sessionFilePath: string): string {
  const pathApi = hostPath();
  return pathApi.join(pathApi.dirname(sessionFilePath), pathApi.basename(sessionFilePath, ".jsonl"));
}

/** Subagent transcript path for a roster id within a parent session. */
export function subagentTranscriptPath(sessionFilePath: string, subagentId: string): string {
  return hostPath().join(siblingDirForSession(sessionFilePath), `${subagentId}.jsonl`);
}

/**
 * Resolve a subagent artifact (`.jsonl` transcript or `.md` completion) inside
 * the parent session's sibling artifacts dir, with symlink confinement:
 * the candidate's REAL path must land directly inside the REAL artifacts dir
 * and be a regular file. Returns the real path (readable target) or null.
 */
export async function resolveSubagentArtifact(
  sessionFilePath: string,
  subagentId: string,
  extension: ".jsonl" | ".md",
  host: Host = currentHost(),
): Promise<string | null> {
  const pathApi = host.pathApi;
  const dir = siblingDirForSession(sessionFilePath);
  const candidate = pathApi.join(dir, `${subagentId}${extension}`);
  // Both realpaths are independent; resolving them together halves the
  // round trips on a remote host.
  let realDir: string;
  let realCandidate: string;
  try {
    [realDir, realCandidate] = await Promise.all([host.fs.realpath(dir), host.fs.realpath(candidate)]);
  } catch {
    return null;
  }
  if (pathApi.dirname(realCandidate) !== realDir) return null;
  try {
    if (!(await host.fs.stat(realCandidate)).isFile()) return null;
  } catch {
    return null;
  }
  return realCandidate;
}

function asAgentSource(value: unknown): SubagentAgentSource | undefined {
  return value === "bundled" || value === "user" || value === "project" ? value : undefined;
}

const SUBAGENT_ID_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

function progressStatusToRoster(status: string | undefined): SubagentHistoryEntry["status"] {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "aborted") return "aborted";
  return "started";
}

function resultStatus(value: Record<string, unknown>): SubagentHistoryEntry["status"] {
  if (value.aborted === true) return "aborted";
  if (typeof value.error === "string" && value.error) return "failed";
  if (typeof value.exitCode === "number") return value.exitCode === 0 ? "completed" : "failed";
  return "started";
}

/**
 * True when an entry already carries a settled state that a stale/duplicate
 * progress snapshot must not regress (unknown/running → "started"). Mirrors
 * the precedence rule mergeSubagentRoster enforces on the live roster.
 */
function progressUpsertBlocked(existing: SubagentHistoryEntry): boolean {
  return existing.result !== undefined
    || existing.status === "completed"
    || existing.status === "failed"
    || existing.status === "aborted";
}

/**
 * Recover the subagent roster from a parent session file. Walks task
 * toolResults, merging `progress` (live-snapshot fields) with `results`
 * (settled per-subagent telemetry), then resolves sibling transcript files.
 */
export async function extractSubagentHistory(sessionFilePath: string, host: Host = currentHost()): Promise<SubagentHistoryEntry[]> {
  let entries: SessionEntry[];
  try {
    entries = await getSessionEntries(sessionFilePath, host);
  } catch {
    return [];
  }

  const byId = new Map<string, SubagentHistoryEntry>();
  // Authoritative launch order: the assistant message that spawns a batch lists
  // its `task` toolCall blocks in the order the model issued them. Ordering by
  // toolResult arrival instead would misplace parallel calls, whose results are
  // appended as each one finishes rather than as each one started.
  const callOrder = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "assistant") continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || block.type !== "toolCall" || block.name !== "task") continue;
      const callId = asString(block.id);
      if (callId !== undefined && !callOrder.has(callId)) callOrder.set(callId, callOrder.size);
    }
  }

  // `index` is the position inside ONE `task` call's batch and restarts at 0 for
  // every call, so sorting by it alone interleaves the agents of separate calls.
  // Pair it with the ordinal of the call that spawned each agent.
  const batchSeqById = new Map<string, number>();
  let batchSeq = -1;
  let unannouncedCalls = 0;
  const upsert = (entry: SubagentHistoryEntry, options?: { ignoreTerminal?: boolean }) => {
    if (!SUBAGENT_ID_RE.test(entry.id)) return;
    const existing = byId.get(entry.id);
    if (!existing) {
      batchSeqById.set(entry.id, batchSeq);
      byId.set(entry.id, entry);
      return;
    }
    // A stale/duplicate progress snapshot must not regress a settled agent:
    // once a result is recorded (or status went terminal via results), skip
    // the whole overwrite. `ignoreTerminal` opts the results loop out — its
    // own field-by-field guards already make it authoritative.
    if (!options?.ignoreTerminal && progressUpsertBlocked(existing)) return;
    const preservedBatchSeq = batchSeqById.get(entry.id) ?? batchSeq;
    batchSeqById.set(entry.id, preservedBatchSeq);
    byId.set(entry.id, {
      ...existing,
      ...entry,
      parentToolCallId: entry.parentToolCallId ?? existing.parentToolCallId,
      batchSeq: preservedBatchSeq,
      result: entry.result ?? existing.result,
    });
  };

  // Detached async spawns — jobIds collected in the same pass below.
  const detachedIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "toolResult") continue;
    const message = entry.message;
    if (message.toolName !== "task") continue;
    const toolCallId = asString(message.toolCallId);
    // A result whose call block never made it into the file (truncated or
    // imported session) keeps arrival order, placed after every announced call.
    const announced = toolCallId !== undefined ? callOrder.get(toolCallId) : undefined;
    batchSeq = announced ?? callOrder.size + unannouncedCalls++;
    const details = isRecord(message.details) ? message.details : {};
    const progressArr = Array.isArray(details.progress) ? details.progress : [];
    const resultsArr = Array.isArray(details.results) ? details.results : [];
    const asyncInfo = isRecord(details.async) ? details.async : undefined;
    const asyncJobId = asyncInfo ? asString(asyncInfo.jobId) : undefined;
    if (asyncJobId) detachedIds.add(asyncJobId);

    for (const raw of progressArr) {
      const progress = parseSubagentProgress(raw);
      if (!progress?.id) continue;
      upsert({
        id: progress.id,
        agent: progress.agent ?? "subagent",
        agentSource: progress.agentSource,
        status: progressStatusToRoster(progress.status),
        task: progress.task,
        assignment: progress.assignment,
        description: progress.description,
        index: progress.index ?? 0,
        ...(toolCallId !== undefined ? { parentToolCallId: toolCallId } : {}),
        lastIntent: progress.lastIntent,
        toolCount: progress.toolCount,
        requests: progress.requests,
        tokens: progress.tokens,
        contextTokens: progress.contextTokens,
        contextWindow: progress.contextWindow,
        cost: progress.cost,
        durationMs: progress.durationMs,
        modelOverride: progress.modelOverride,
        modelRole: progress.modelRole,
        resolvedModel: progress.resolvedModel,
        resolvedModelIsFallback: progress.resolvedModelIsFallback,
        retryFailure: progress.retryFailure,
        transcriptAvailable: false,
      });
    }

    for (const raw of resultsArr) {
      if (!isRecord(raw)) continue;
      const id = asString(raw.id);
      if (!id) continue;
      const prior = byId.get(id);
      const result: SubagentHistoryResult = {};
      const exitCode = asNumber(raw.exitCode);
      if (exitCode !== undefined) result.exitCode = exitCode;
      // NOTE: `output`/`stderr` are deliberately NOT copied — the roster route
      // must stay telemetry-only (task outputs can be ~500KB per agent).
      if (raw.truncated === true) result.truncated = true;
      const cost = asNumber(raw.cost) ?? taskResultUsageCost(raw.usage);
      if (cost !== undefined) result.cost = cost;
      const structured = taskResultStructuredOutput(raw.structuredOutput);
      if (structured !== undefined) result.structuredOutput = structured;
      const error = asString(raw.error);
      if (error !== undefined) result.error = error;
      if (raw.aborted === true) result.aborted = true;
      const abortReason = asString(raw.abortReason);
      if (abortReason !== undefined) result.abortReason = abortReason;
      const outputPath = asString(raw.outputPath);
      if (outputPath !== undefined) result.outputPath = outputPath;
      const patchPath = asString(raw.patchPath);
      if (patchPath !== undefined) result.patchPath = patchPath;
      const branchName = asString(raw.branchName);
      if (branchName !== undefined) result.branchName = branchName;
      const retryFailure = isRecord(raw.retryFailure)
        ? {
            attempt: asNumber(raw.retryFailure.attempt) ?? 0,
            errorMessage: asString(raw.retryFailure.errorMessage) ?? "",
          }
        : prior?.retryFailure;
      upsert({
        id,
        agent: asString(raw.agent) ?? prior?.agent ?? "subagent",
        agentSource: asAgentSource(raw.agentSource) ?? prior?.agentSource,
        status: resultStatus(raw),
        task: asString(raw.task) ?? prior?.task,
        assignment: asString(raw.assignment) ?? prior?.assignment,
        description: asString(raw.description) ?? prior?.description,
        index: asNumber(raw.index) ?? prior?.index ?? 0,
        ...(toolCallId !== undefined ? { parentToolCallId: toolCallId } : {}),
        lastIntent: asString(raw.lastIntent) ?? prior?.lastIntent,
        toolCount: asNumber(raw.toolCount) ?? prior?.toolCount,
        requests: asNumber(raw.requests) ?? prior?.requests,
        tokens: asNumber(raw.tokens) ?? prior?.tokens,
        contextTokens: asNumber(raw.contextTokens) ?? prior?.contextTokens,
        contextWindow: asNumber(raw.contextWindow) ?? prior?.contextWindow,
        cost: asNumber(raw.cost) ?? taskResultUsageCost(raw.usage) ?? prior?.cost,
        durationMs: asNumber(raw.durationMs) ?? prior?.durationMs,
        modelOverride: typeof raw.modelOverride === "string" || Array.isArray(raw.modelOverride) ? raw.modelOverride : prior?.modelOverride,
        modelRole: asString(raw.modelRole) ?? prior?.modelRole,
        resolvedModel: asString(raw.resolvedModel) ?? prior?.resolvedModel,
        resolvedModelIsFallback: typeof raw.resolvedModelIsFallback === "boolean" ? raw.resolvedModelIsFallback : prior?.resolvedModelIsFallback,
        retryFailure,
        transcriptAvailable: false,
        result: Object.keys(result).length > 0 ? result : undefined,
      }, { ignoreTerminal: true });
    }

    // Detached async spawns can persist with an empty results[] while still
    // running — async.jobId still names the agent.
    if (asyncInfo) {
      const jobId = asString(asyncInfo.jobId);
      if (jobId && !byId.has(jobId)) {
        upsert({
          id: jobId,
          agent: "task",
          status: asyncInfo.state === "completed" ? "completed" : asyncInfo.state === "failed" ? "failed" : "started",
          index: byId.size,
          ...(toolCallId !== undefined ? { parentToolCallId: toolCallId } : {}),
          transcriptAvailable: false,
        }, { ignoreTerminal: true });
      }
    }
  }
  // Resolve sibling transcript files and detached markers. One directory
  // listing answers every "does <id>.jsonl exist" question (a per-agent
  // exists() probe would be one ssh round trip each on a remote host).
  const dir = siblingDirForSession(sessionFilePath);
  const transcripts = await listTranscriptNames(dir, host);
  const roster = [...byId.values()];
  for (const entry of roster) {
    // The client cannot derive this: neither a live snapshot nor a partial
    // history fetch reveals which call came first.
    entry.batchSeq = batchSeqById.get(entry.id) ?? 0;
    if (detachedIds.has(entry.id)) entry.detached = true;
    // Guard against crafted ids probing outside sibling dir (e.g. "../../");
    // route already validates via SUBAGENT_ID_RE + realpath, but roster path is
    // derived from untrusted session content.
    if (!SUBAGENT_ID_RE.test(entry.id)) continue;
    const fileName = `${entry.id}.jsonl`;
    if (transcripts.has(fileName)) {
      entry.sessionFile = host.pathApi.join(dir, fileName);
      entry.transcriptAvailable = true;
    }
  }
  return roster.sort((a, b) =>
    (batchSeqById.get(a.id) ?? 0) - (batchSeqById.get(b.id) ?? 0)
    || a.index - b.index
    || a.id.localeCompare(b.id)
  );
}

/** Regular `.jsonl` files directly inside the artifacts dir (empty when the
 * directory does not exist yet). Symlinked transcripts are listed too — the
 * route confines them through resolveSubagentArtifact before reading. */
async function listTranscriptNames(dir: string, host: Host): Promise<Set<string>> {
  try {
    const entries = await host.fs.readdir(dir);
    return new Set(entries.filter((entry) => entry.name.endsWith(".jsonl") && (entry.isFile() || entry.targetType === "file")).map((entry) => entry.name));
  } catch {
    return new Set();
  }
}

/** Cap on transcript bytes materialized for the dialog (files are small). */
export const MAX_SUBAGENT_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

/** Bytes read per page call — the total cap above bounds the file, this
 * bounds the per-response window so large transcripts are delivered
 * incrementally instead of serialized whole. */
export const SUBAGENT_TRANSCRIPT_PAGE_BYTES = 256 * 1024;

export interface SubagentTranscriptPage {
  sessionFile: string;
  fromByte: number;
  nextByte: number;
  reset: boolean;
  messages: AgentMessage[];
  error?: string;
  /** Full file size — lets the dialog hide Load more once fully read. */
  totalBytes?: number;
}

interface ByteWindow {
  size: number;
  bytes: Buffer;
}

// Size line first, then the window itself. `tail -c +N` is 1-based and
// portable across GNU and BSD; `head -c` stops at EOF, so a window past the
// end is simply empty.
const REMOTE_WINDOW_SCRIPT = [
  'f="$1"; from="$2"; len="$3"',
  '[ -f "$f" ] || exit 2',
  'sz=$(wc -c < "$f" 2>/dev/null | tr -d " ") || exit 2',
  'printf "%s\n" "$sz"',
  '[ "$len" -gt 0 ] || exit 0',
  'tail -c +$((from + 1)) -- "$f" | head -c "$len"',
].join("\n");

/**
 * Positional read of `[from, from + length)` plus the file size, in ONE round
 * trip on a remote host. The HostFs interface has no positional read (prefix
 * and suffix windows only), so the local host uses a file handle directly:
 * re-reading from byte 0 on every page would make a pagination walk O(n²).
 * Returns null when the file is missing or unreadable.
 */
async function readByteWindow(filePath: string, from: number, length: number, host: Host): Promise<ByteWindow | null> {
  if (!host.isLocal) {
    let stdout: Buffer;
    try {
      ({ stdout } = await host.executor.exec(["sh", "-c", REMOTE_WINDOW_SCRIPT, "sh", filePath, String(from), String(length)], {
        maxBuffer: length + 64,
        timeoutMs: 5 * 60_000,
      }));
    } catch {
      return null;
    }
    const newline = stdout.indexOf(0x0a);
    if (newline === -1) return null;
    const size = Number.parseInt(stdout.subarray(0, newline).toString("utf8"), 10);
    if (!Number.isFinite(size)) return null;
    return { size, bytes: stdout.subarray(newline + 1) };
  }
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const size = (await handle.stat()).size;
    const windowBytes = Math.max(0, Math.min(length, size - from));
    const buffer = Buffer.alloc(windowBytes);
    const bytesRead = windowBytes > 0 ? (await handle.read(buffer, 0, windowBytes, from)).bytesRead : 0;
    return { size, bytes: buffer.subarray(0, bytesRead) };
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Byte-window transcript paging mirroring omp's readRpcSubagentTranscript:
 * parse complete lines from `fromByte`, return UI messages + nextByte.
 */
export async function readSubagentTranscriptPage(sessionFilePath: string, fromByte = 0, host: Host = currentHost()): Promise<SubagentTranscriptPage> {
  const empty: SubagentTranscriptPage = {
    sessionFile: sessionFilePath,
    fromByte: typeof fromByte === "number" && Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0,
    nextByte: typeof fromByte === "number" && Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0,
    reset: false,
    messages: [],
  };
  let startByte = empty.fromByte;
  let reset = false;
  // Positional read of just this page's window — materializing the whole
  // file to slice one window made a pagination walk O(n²) in I/O.
  let window = await readByteWindow(sessionFilePath, startByte, SUBAGENT_TRANSCRIPT_PAGE_BYTES, host);
  if (!window) return empty;
  const size = window.size;
  if (startByte > size) {
    // The client's offset outlived a rewrite/truncation: restart from the top.
    startByte = 0;
    reset = true;
    window = await readByteWindow(sessionFilePath, 0, SUBAGENT_TRANSCRIPT_PAGE_BYTES, host);
    if (!window) return { ...empty, fromByte: 0, nextByte: 0, reset };
  }
  if (size > MAX_SUBAGENT_TRANSCRIPT_BYTES) {
    return { ...empty, fromByte: startByte, nextByte: startByte, reset, error: "Subagent transcript exceeds the readable size limit" };
  }
  const endByte = Math.min(size, startByte + SUBAGENT_TRANSCRIPT_PAGE_BYTES);
  // Slice the BYTE buffer, not the decoded string: `startByte` is a UTF-8
  // offset, while string indices are UTF-16 code units — slicing the string
  // misaligns every later page once non-ASCII text precedes the offset.
  const body = window.bytes.subarray(0, Math.max(0, endByte - startByte)).toString("utf8");
  const lastNewline = body.lastIndexOf("\n");
  const completeText = lastNewline >= 0 ? body.slice(0, lastNewline + 1) : "";
  const entries = completeText.length > 0 ? parseJsonlLenient<SessionEntry>(completeText) : [];
  const messages = entries
    .map((entry) => entryToUiMessage(entry, {}))
    .filter((message): message is AgentMessage => message !== null);
  let nextByte = startByte + Buffer.byteLength(completeText, "utf8");
  // Guarantee forward progress: when the window ends mid-line and more
  // content remains, the partial line has no newline to complete it — skip
  // it instead of returning the same offset forever.
  if (nextByte === startByte && endByte < size) nextByte = endByte;
  return { sessionFile: sessionFilePath, fromByte: startByte, nextByte, reset, messages, totalBytes: size };
}

/** Cap on completion bytes materialized for the dialog (final outputs are small). */
export const MAX_SUBAGENT_COMPLETION_BYTES = 1024 * 1024;

/**
 * Read a subagent's final output artifact (`<id>.md`) from an ALREADY-RESOLVED
 * path (the route confines via resolveSubagentArtifact first — reading the raw
 * derived path here would reopen a symlink swapped after the check). Reads at
 * most MAX_SUBAGENT_COMPLETION_BYTES bytes in one round trip (size + prefix
 * window), trimming a trailing incomplete UTF-8 sequence before decoding.
 * Returns null when no output file exists yet (still running, aborted before
 * producing output, or the session predates it) or it is empty.
 */
export async function readCompletionArtifact(
  outputFile: string,
  host: Host = currentHost(),
): Promise<{ completion: string; truncated: boolean } | null> {
  let slices: Awaited<ReturnType<Host["fs"]["readSlices"]>>;
  try {
    slices = await host.fs.readSlices([outputFile], MAX_SUBAGENT_COMPLETION_BYTES, 0);
  } catch {
    return null;
  }
  const slice = slices.get(outputFile);
  if (!slice || slice.size <= 0) return null;
  const truncated = slice.size > MAX_SUBAGENT_COMPLETION_BYTES;
  const buffer = slice.prefix.subarray(0, MAX_SUBAGENT_COMPLETION_BYTES);
  // Trim a trailing INCOMPLETE UTF-8 sequence before decoding. A complete
  // multibyte char may also end in continuation bytes, so walk back over the
  // trailing continuations to the lead and keep the char only when its full
  // width fits inside the buffer.
  let end = buffer.length;
  let trailing = 0;
  while (end - trailing > 0 && (buffer[end - 1 - trailing] & 0xc0) === 0x80) trailing += 1;
  const leadPos = end - 1 - trailing;
  if (leadPos >= 0) {
    const lead = buffer[leadPos];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (leadPos + need > buffer.length) end = leadPos;
  } else {
    // Continuation bytes with no lead at the tail — garbage.
    end = 0;
  }
  return { completion: buffer.subarray(0, end).toString("utf8"), truncated };
}
