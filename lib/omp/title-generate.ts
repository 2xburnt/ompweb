/**
 * On-demand session-title generation.
 *
 * omp titles sessions itself, but only automatically and only once per
 * session; the UI's "Generate title" action needs a title *now*, for an
 * arbitrary (often already-titled) session. omp-web cannot import the
 * Bun-only agent SDK, so it drives the installed CLI in non-interactive
 * print mode instead: one throwaway, tool-less, session-less run whose only
 * output is the title.
 */

import { currentHost } from "../hosts/context";
import type { Host } from "../hosts/registry";
import { resolveOmpBin } from "./omp-cli";

/** Wall-clock ceiling for the naming run; the UI shows a spinner until then. */
const TITLE_TIMEOUT_MS = 90_000;
/** Prompt budget. Enough conversation to characterize the goal, cheap to send. */
const MAX_PROMPT_CHARS = 6_000;
const MAX_MESSAGE_CHARS = 800;
const MAX_MESSAGES = 12;
/** omp's own title slot truncates; keep our output comfortably inside it. */
const MAX_TITLE_LENGTH = 80;

const TITLE_INSTRUCTIONS = `Write a title for the coding session transcribed below.

Requirements:
- Match the primary language used by the user.
- Describe the user's concrete goal or the outcome, not the act of chatting.
- Use 4-8 words for space-separated languages, or 8-24 characters for CJK text.
- Return only the title as plain text: no quotes, label, markdown, or explanation.

Transcript:`;

export interface TitleSourceMessage {
  role: string;
  text: string;
}

/** Render the transcript excerpt sent to the model: the first user message
 * (which states the goal) plus the most recent exchanges (which state where it
 * ended up), each individually truncated so one huge paste cannot crowd the
 * rest out. */
export function buildTitlePrompt(messages: readonly TitleSourceMessage[]): string | null {
  const usable = messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.text.trim())
    .map((message) => ({ role: message.role, text: clamp(message.text.trim(), MAX_MESSAGE_CHARS) }));
  if (usable.length === 0) return null;

  const selected = usable.length <= MAX_MESSAGES
    ? usable
    : [usable[0], ...usable.slice(-(MAX_MESSAGES - 1))];

  let transcript = "";
  for (const message of selected) {
    const line = `${message.role === "user" ? "User" : "Assistant"}: ${message.text}\n\n`;
    if (transcript.length + line.length > MAX_PROMPT_CHARS) break;
    transcript += line;
  }
  if (!transcript.trim()) transcript = `User: ${clamp(selected[0].text, MAX_PROMPT_CHARS)}\n`;

  return `${TITLE_INSTRUCTIONS}\n\n${transcript.trimEnd()}`;
}

function clamp(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function stripWrappingQuotes(value: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'], ["'", "'"], ["`", "`"],
    ["\u201c", "\u201d"], ["\u300c", "\u300d"], ["\u300e", "\u300f"],
  ];
  for (const [open, close] of pairs) {
    if (value.length > open.length + close.length && value.startsWith(open) && value.endsWith(close)) {
      return value.slice(open.length, -close.length).trim();
    }
  }
  return value;
}

/**
 * Reduce raw print-mode stdout to a title. Print mode may emit progress lines
 * ("Working...") before the answer and the model may wrap it in a fence, a
 * label, or quotes, so take the last non-empty line and peel those off.
 */
export function parseGeneratedTitle(raw: string): string | null {
  let value = raw.replace(/\r/g, "").trim();
  if (!value) return null;

  const fenced = value.match(/```(?:[a-z]*)\s*([\s\S]*?)\s*```/i);
  if (fenced) value = fenced[1].trim();

  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  // Progress chatter precedes the answer, so the answer is the final line.
  value = lines.at(-1) ?? "";
  value = stripWrappingQuotes(value.replace(/^(?:title|標題|标题|タイトル)\s*[:：]\s*/i, "").trim());
  value = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!value || !/[\p{L}\p{N}]/u.test(value)) return null;

  const characters = Array.from(value);
  if (characters.length > MAX_TITLE_LENGTH) {
    return `${characters.slice(0, MAX_TITLE_LENGTH).join("").trimEnd()}…`;
  }
  return value;
}

export class TitleGenerationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TitleGenerationUnavailableError";
  }
}

/**
 * Run one headless omp turn to title the conversation. `--no-session` keeps it
 * out of the session list, `--no-tools` makes it incapable of touching the
 * project, and `--no-title/--no-skills/--no-rules` strip work the naming run
 * would otherwise pay for. Returns null when the model produced nothing usable
 * (the caller falls back to a derived title); throws when omp is unavailable.
 */
export async function generateSessionTitle(
  prompt: string,
  options: { cwd?: string; host?: Host; signal?: AbortSignal } = {},
): Promise<string | null> {
  const host = options.host ?? currentHost();
  const bin = resolveOmpBin(host);
  if (!bin) {
    throw new TitleGenerationUnavailableError("The omp binary is not available on this machine");
  }

  const argv = [
    bin,
    "--print",
    "--no-tools",
    "--no-session",
    "--no-title",
    "--no-skills",
    "--no-rules",
    "--thinking", "off",
    prompt,
  ];

  const result = await host.executor.exec(argv, {
    cwd: options.cwd,
    timeoutMs: TITLE_TIMEOUT_MS,
    maxBuffer: 1 << 20,
    signal: options.signal,
    allowFailure: true,
  });

  if (result.code !== 0) {
    const detail = result.stderr.trim().split("\n").filter(Boolean).at(-1);
    throw new Error(detail ? `omp title run failed: ${detail}` : "omp title run failed");
  }

  return parseGeneratedTitle(result.stdout.toString("utf8"));
}
