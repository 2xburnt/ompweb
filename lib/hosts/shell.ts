/** POSIX shell quoting for commands sent to a remote login shell over ssh. */

const SAFE_WORD = /^[A-Za-z0-9_\/.:=@%+,-]+$/;

export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (SAFE_WORD.test(value)) return value;
  // '\'' closes the quote, emits a literal quote, and reopens. This form is
  // also valid in fish, so it survives a fish login shell on the remote side.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function shellJoin(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}
