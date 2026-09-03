import { getTerminal, subscribeTerminal, type TerminalSubscription } from "@/lib/terminal/manager";

export const dynamic = "force-dynamic";

// GET /api/terminal/[id]/events — SSE stream of terminal output.
//
// The first event replays the session's scrollback so a browser that reloads,
// or reconnects after the stream drops, gets its screen back rather than an
// empty pane. Output frames carry base64 because a PTY emits arbitrary bytes
// (including the control characters SSE itself uses as delimiters).
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!getTerminal(id)) {
    return new Response(JSON.stringify({ error: "Terminal session not found", code: "terminal_not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  let streamCleanup: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let subscription: TerminalSubscription | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat !== null) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        subscription?.unsubscribe();
        subscription = null;
        req.signal?.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      streamCleanup = cleanup;

      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };

      req.signal?.addEventListener("abort", cleanup);
      if (req.signal?.aborted) {
        cleanup();
        return;
      }

      try {
        subscription = subscribeTerminal(
          id,
          (chunk) => send({ type: "output", data: Buffer.from(chunk, "utf8").toString("base64") }),
          (exit) => {
            send({ type: "exit", ...exit });
            cleanup();
          },
        );
      } catch {
        send({ type: "exit", code: -1 });
        cleanup();
        return;
      }

      const terminal = getTerminal(id);
      send({
        type: "ready",
        ...(terminal ? { cols: terminal.cols, rows: terminal.rows, host: terminal.hostId, cwd: terminal.cwd } : {}),
        backlog: Buffer.from(subscription.backlog, "utf8").toString("base64"),
      });

      // Keeps the connection alive through proxies that cut idle streams.
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          cleanup();
        }
      }, 30_000);
    },
    cancel() {
      streamCleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
