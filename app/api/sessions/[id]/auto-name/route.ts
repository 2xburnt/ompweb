import { NextResponse } from "next/server";
import { scanSessionInfo, setSessionTitle } from "@/lib/omp/session-files";
import { deriveSessionTitleFromFirstMessage, sanitizeSessionTitle } from "@/lib/session-title";
import {
  buildTitlePrompt,
  generateSessionTitle,
  TitleGenerationUnavailableError,
  type TitleSourceMessage,
} from "@/lib/omp/title-generate";
import { getRpcSession } from "@/lib/rpc-manager";
import { buildSessionContext, getSessionEntries, invalidateSessionListCache } from "@/lib/session-reader";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { withSessionRoute } from "@/lib/hosts/route";

/**
 * POST /api/sessions/[id]/auto-name
 *
 * Titles a session on demand. omp only auto-titles once and only for sessions
 * it is currently running, so this always produces a *fresh* title: it reads
 * the conversation, asks the installed omp CLI for a title (one headless,
 * tool-less run), and persists it. Falls back to a first-message-derived title
 * when the model yields nothing usable.
 */
export const POST = withSessionRoute(async (
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;

  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    const info = await scanSessionInfo(filePath, false);
    const entries = await getSessionEntries(filePath);
    const { messages } = buildSessionContext(entries, undefined, {
      deferThinking: true,
      deferToolResultImages: true,
    });

    const sources: TitleSourceMessage[] = [];
    for (const message of messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const text = typeof message.content === "string"
        ? message.content
        : (Array.isArray(message.content) ? message.content : [])
          .filter((part): part is { type: "text"; text: string } =>
            Boolean(part) && (part as { type?: string }).type === "text"
            && typeof (part as { text?: unknown }).text === "string")
          .map((part) => part.text)
          .join("\n");
      if (text.trim()) sources.push({ role: message.role, text });
    }

    const prompt = buildTitlePrompt(sources);
    const fallback = deriveSessionTitleFromFirstMessage(info?.firstMessage);
    if (!prompt && !fallback) {
      return NextResponse.json(
        { error: "The session has no user messages to name", code: "session_no_messages_to_name" },
        { status: 409 },
      );
    }

    let title: string | undefined;
    if (prompt) {
      title = sanitizeSessionTitle(
        (await generateSessionTitle(prompt, { cwd: info?.cwd })) ?? undefined,
      );
    }
    title ??= fallback ?? undefined;
    if (!title) {
      return NextResponse.json(
        { error: "Could not generate a title for this session", code: "session_title_generation_empty" },
        { status: 502 },
      );
    }

    // "user": the title was requested explicitly, so omp's own auto-titling
    // must not overwrite it on the next flush.
    await setSessionTitle(filePath, title, "user");

    // A live omp process caches the session name; push it back so its own
    // flushes (and get_state) do not resurrect the previous title.
    const rpc = getRpcSession(id);
    if (rpc?.isAlive?.() && typeof rpc.send === "function") {
      try {
        await rpc.send({ type: "set_session_name", name: title });
      } catch {
        // The on-disk slot is already authoritative for the sidebar.
      }
    }

    invalidateSessionListCache();
    return NextResponse.json({ title, usage: null });
  } catch (error) {
    const unavailable = error instanceof TitleGenerationUnavailableError;
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
        ...(unavailable ? { code: "omp_unavailable" } : {}),
      },
      { status: unavailable ? 503 : 500 },
    );
  }
});
