import { getSessionEntries, resolveSessionLocation } from "./session-reader";
import {
  isBashOutputPathReferencedByEntries,
  isFilePathReferencedByEntries,
  isValidSessionId,
} from "./session-file-references-core";

export { isFilePathReferencedByEntries } from "./session-file-references-core";

/** Entries are read on the host that owns the session, regardless of the
 * host context the caller runs in: a session id is unique across machines. */
async function isPathReferencedBySession(
  filePath: string,
  sessionId: string | null,
  check: (p: string, entries: import("./types").SessionEntry[]) => boolean,
): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  try {
    const location = await resolveSessionLocation(sessionId);
    if (!location) return false;
    return check(filePath, await getSessionEntries(location.path, location.host));
  } catch {
    return false;
  }
}

export function isFilePathReferencedBySession(filePath: string, sessionId: string | null): Promise<boolean> {
  return isPathReferencedBySession(filePath, sessionId, isFilePathReferencedByEntries);
}

export function isBashOutputPathReferencedBySession(filePath: string, sessionId: string | null): Promise<boolean> {
  return isPathReferencedBySession(filePath, sessionId, isBashOutputPathReferencedByEntries);
}
