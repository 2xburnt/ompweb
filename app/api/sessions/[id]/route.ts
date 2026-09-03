import { NextResponse } from "next/server";
import {
  buildSessionTree,
  deleteSessionFileWithArtifacts,
  getLeafEntryId,
  loadSessionFile,
  MAX_SESSION_LOAD_BYTES,
  parseTitleSlotLine,
  scanSessionInfoFromSlices,
  SESSION_TITLE_SLOT_BYTES,
  setSessionTitle,
  writeSessionFileAtomic,
} from "@/lib/omp/session-files";
import {
  resolveParentSessionId,
  resolveSessionIdByPath,
  resolveSessionPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  readSessionHeader,
} from "@/lib/session-reader";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { currentHost } from "@/lib/hosts/context";
import { withSessionRoute } from "@/lib/hosts/route";
import { hostPath } from "@/lib/omp/paths";
import { sessionPathKey } from "@/lib/paths";
import { getRpcSession } from "@/lib/rpc-manager";

/** Stable, client-safe error body for catch-all handlers: details go to the
 *  server log only, never to the browser. */
function sessionsErrorResponse(error: unknown): NextResponse {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Request body is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  console.error("[api/sessions]", error);
  return NextResponse.json({ error: "Session request failed", code: "session_request_failed" }, { status: 500 });
}

// BranchNavigator still traverses recursively, so keep the response tree shallow.
const MAX_PROJECTED_TREE_DEPTH = 200;
const MAX_BRANCH_PREVIEW_LENGTH = 40;

function branchPreviewForEntry(entry: { id?: string; type?: string; message?: unknown }): { role?: "user" | "assistant"; text: string } | undefined {
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object" || Array.isArray(entry.message)) return undefined;
  const message = entry.message as { role?: unknown; content?: unknown };
  let text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter((block): block is { type?: unknown; text?: unknown } => typeof block === "object" && block !== null).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join(" ")
      : "";
  text = text.replace(/\s+/g, " " ).trim();
  if (text.length > MAX_BRANCH_PREVIEW_LENGTH) text = `${text.slice(0, MAX_BRANCH_PREVIEW_LENGTH)}…`;
  if (!text) text = message.role === "assistant" ? "[assistant]" : "message";
  const role = message.role === "user" || message.role === "assistant" ? message.role : undefined;
  return { ...(role ? { role } : {}), text };
}

/**
 * Project the session tree into the shallow navigation tree sent to the client.
 * Keeps roots, branch points, and leaves while contracting single-child chains
 * without recursive traversal. Contracted entry IDs are attached to the next
 * visible node so the UI can still recognize an active leaf inside the chain.
 */
function projectTreeForResponse<T extends { entry: { id: string }; children: T[]; compressedEntryIds?: string[] }>(
  nodes: T[]
): T[] {
  const keep = new Set<T>();
  const roots = new Set(nodes);
  const seen = new Set<T>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);

    if (
      roots.has(node) ||
      node.children.length !== 1
    ) {
      keep.add(node);
    }

    for (const child of node.children) {
      stack.push(child);
    }
  }

  const cloneNode = (node: T, compressedEntryIds?: string[], branchPreview?: { role?: "user" | "assistant"; text: string }): T => ({
    ...node,
    children: [],
    ...(compressedEntryIds?.length ? { compressedEntryIds } : {}),
    ...(branchPreview ? { branchPreview } : {}),
  });
  const projectedRoots = nodes.map((node) => cloneNode(node, undefined, branchPreviewForEntry(node.entry)));
  const tasks = nodes.map((source, index) => ({
    source,
    projected: projectedRoots[index],
    depth: 1,
  }));

  const appendFlattenedKeptDescendants = (source: T, projectedParent: T) => {
    const pending = [{ node: source, compressedEntryIds: [] as string[], branchPreview: undefined as { role?: "user" | "assistant"; text: string } | undefined }];
    const flattenedSeen = new Set<T>();

    while (pending.length > 0) {
      const { node, compressedEntryIds, branchPreview } = pending.pop()!;
      if (flattenedSeen.has(node)) continue;
      flattenedSeen.add(node);

      if (keep.has(node)) {
        projectedParent.children.push(cloneNode(node, compressedEntryIds, branchPreview ?? branchPreviewForEntry(node.entry)));
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        pending.push({
          node: node.children[i],
          compressedEntryIds: keep.has(node)
            ? []
            : [...compressedEntryIds, node.entry.id],
          branchPreview: keep.has(node) ? undefined : (branchPreview ?? branchPreviewForEntry(node.entry)),
        });
      }
    }
  };

  while (tasks.length > 0) {
    const { source, projected, depth } = tasks.pop()!;

    for (const sourceChild of source.children) {
      let child = sourceChild;

      if (depth >= MAX_PROJECTED_TREE_DEPTH) {
        appendFlattenedKeptDescendants(child, projected);
        continue;
      }

      const compressedEntryIds: string[] = [];
      let branchPreview = branchPreviewForEntry(child.entry);
      while (!keep.has(child) && child.children.length === 1) {
        compressedEntryIds.push(child.entry.id);
        child = child.children[0];
        branchPreview ??= branchPreviewForEntry(child.entry);
      }

      if (!keep.has(child)) {
        continue;
      }

      const projectedChild = cloneNode(child, compressedEntryIds, branchPreview);
      projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: depth + 1 });
    }
  }

  return projectedRoots;
}

// Slot-aware header window of a sibling session (readSessionHeader's bound):
// enough to learn a child's id and parentSession without loading its body.
const CHILD_HEADER_BYTES = 64 * 1024 + SESSION_TITLE_SLOT_BYTES;

export const GET = withSessionRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;
    const host = currentHost();

    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const includeState = searchParams.has("includeState");

    const { header, entries, error: loadError } = await loadSessionFile(filePath, {
      resolveBlobs: true,
      skipToolResultImages: deferToolResultImages,
    });
    if (loadError === "too_large") {
      return NextResponse.json(
        { error: "Session file is too large to open in omp-web", code: "session_file_too_large" },
        { status: 413 },
      );
    }
    if (!header) {
      return NextResponse.json({ error: "Session file is missing or malformed", code: "session_file_malformed" }, { status: 404 });
    }
    const leafId = getLeafEntryId(entries);
    const tree = projectTreeForResponse(buildSessionTree(entries));
    const context = buildSessionContext(entries, leafId, { deferThinking, deferToolResultImages });

    let modified = header.timestamp ?? new Date().toISOString();
    try { modified = new Date((await host.fs.stat(filePath)).mtimeMs).toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header.parentSession
      ? await resolveParentSessionId(header.parentSession)
      : undefined;
    const info = {
      host: host.id,
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: header.title,
      created: header.timestamp,
      modified,
      messageCount: context.messages.length,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = context.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
    };

    // ?includeState=1 inlines the wrapper's live agent state (same shape as
    // GET /api/agent/[id]) so the client's post-turn refresh is one request
    // instead of two. On a get_state failure the field is omitted entirely —
    // callers treat a missing `agent` as "fetch it separately".
    let agent: { running: boolean; state?: unknown } | undefined;
    if (includeState) {
      const rpc = getRpcSession(id);
      if (rpc?.isAlive()) {
        try {
          agent = { running: true, state: await rpc.send({ type: "get_state" }) };
        } catch {
          // Leave agent unset; the session payload is still valid without it.
        }
      } else {
        agent = { running: false };
      }
    }

    return NextResponse.json({
      sessionId: id,
      host: host.id,
      filePath,
      info,
      leafId,
      tree,
      context,
      ...(agent ? { agent } : {}),
    });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
});

// PATCH /api/sessions/[id]  body: { name: string }
export const PATCH = withSessionRoute(async (
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  try {
    const { name } = await parseJsonWithinLimit<{ name?: string }>(req, 64 * 1024);
    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required", code: "session_name_required" }, { status: 400 });
    }
    // A running omp process owns its session file; route the rename through it
    // so the in-memory title cannot clobber ours on the next flush. This runs
    // before the path check because omp does not create the session file until
    // the history holds an assistant message.
    let renamed = false;
    const rpc = getRpcSession(id);
    if (rpc?.isAlive?.() && typeof rpc.send === "function") {
      try {
        await rpc.send({ type: "set_session_name", name: name.trim() });
        renamed = true;
      } catch {
        // Fall back to the on-disk title slot below.
      }
    }
    if (!renamed) {
      const resolved = await resolveSessionPathOr404(id);
      if ("response" in resolved) return resolved.response;
      const filePath = resolved.filePath;
      await setSessionTitle(filePath, name.trim(), "user");
    }
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
});

// DELETE /api/sessions/[id]
export const DELETE = withSessionRoute(async (
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;
    const host = currentHost();
    const pathApi = hostPath();

    // Read only the bounded header before deleting.
    const deletedHeader = await readSessionHeader(filePath);
    const deletedSessionId = deletedHeader?.id ?? id;
    const parentSession = deletedHeader?.parentSession;

    // Children reference their parent either by file path or by bare session id
    // (see resolveParentSessionId), so the grandparent has to be written back in
    // whichever form each child used. Resolve both forms up front.
    let grandparentPath: string | undefined;
    let grandparentId: string | undefined;
    if (parentSession) {
      const idForPath = await resolveSessionIdByPath(parentSession);
      if (idForPath) {
        grandparentPath = parentSession;
        grandparentId = idForPath;
      } else {
        const pathForId = await resolveSessionPath(parentSession);
        if (pathForId) {
          grandparentPath = pathForId;
          grandparentId = parentSession;
        }
      }
    }

    // Re-attach all direct children to this session's parent (cascade re-parent).
    // Siblings live in the same directory; their slot-aware header windows are
    // fetched in ONE round trip (readSlices) so a remote host is not probed
    // once per file, and no sibling is ever loaded whole unless it is a child
    // that needs rewriting.
    const targetPathKey = sessionPathKey(filePath);
    const dir = pathApi.dirname(filePath);
    const skippedChildren: Array<{ id: string; reason: string }> = [];
    try {
      const siblings = (await host.fs.readdir(dir))
        .filter((entry) => entry.name.endsWith(".jsonl") && (entry.isFile() || entry.targetType === "file"))
        .map((entry) => pathApi.join(dir, entry.name))
        .filter((siblingPath) => sessionPathKey(siblingPath) !== targetPathKey);
      const slices = await host.fs.readSlices(siblings, CHILD_HEADER_BYTES, 0);
      for (const childPath of siblings) {
        const slice = slices.get(childPath);
        if (!slice) continue; // vanished between readdir and read — not a child we can fix
        const childInfo = scanSessionInfoFromSlices(childPath, slice, false);
        if (!childInfo?.parentSessionPath) continue;
        const linkedByPath = sessionPathKey(childInfo.parentSessionPath) === targetPathKey;
        if (!linkedByPath && childInfo.parentSessionPath !== deletedSessionId) continue;
        const childId = childInfo.id || pathApi.basename(childPath);

        // Re-parenting rewrites the whole child file; a child at/above the
        // load ceiling would cause a huge allocation (RangeError) during the
        // read and a full-file rewrite. Skip it like a live session.
        if (slice.size > MAX_SESSION_LOAD_BYTES) {
          skippedChildren.push({ id: childId, reason: "session_child_too_large" });
          continue;
        }

        // A live omp process owns its session file and flushes its whole
        // in-memory state on write — our rewrite would be clobbered by (or
        // interleaved with) its next flush.
        if (childInfo.id && getRpcSession(childInfo.id)?.isAlive?.()) {
          skippedChildren.push({ id: childId, reason: "session_child_live" });
          continue;
        }

        let lines: string[];
        let headerIndex: number;
        let header: { type?: string; id?: string; parentSession?: string };
        try {
          lines = (await host.fs.readFile(childPath)).toString("utf8").split("\n");
          headerIndex = parseTitleSlotLine(lines[0] ?? "") ? 1 : 0;
          header = JSON.parse(lines[headerIndex]) as typeof header;
        } catch {
          skippedChildren.push({ id: childId, reason: "session_child_rewrite_failed" });
          continue;
        }

        // Write the replacement in the same form the child used.
        header.parentSession = linkedByPath
          ? (grandparentPath ?? parentSession)
          : (grandparentId ?? parentSession);
        lines[headerIndex] = JSON.stringify(header);
        try {
          // Atomic (temp file + rename on the host): a truncating write would
          // let a crash or ENOSPC permanently truncate a session the user did
          // NOT delete.
          await writeSessionFileAtomic(childPath, lines.join("\n"));
        } catch {
          skippedChildren.push({ id: childId, reason: "session_child_rewrite_failed" });
        }
      }
    } catch { /* skip if dir unreadable */ }

    // Await the child's exit before unlinking: omp flushes session state on
    // shutdown and would recreate the file if it were still running.
    await getRpcSession(id)?.destroyAndWait?.();
    await deleteSessionFileWithArtifacts(filePath);
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    return NextResponse.json({
      ok: true,
      ...(skippedChildren.length > 0 ? { skippedChildren } : {}),
    });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
});
