export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  /** Machine the deep link targets (`?host=<id>`); null when unspecified. */
  host: string | null;
}

export function getInitialNavigation(searchParams: Pick<URLSearchParams, "get">): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;
  const host = searchParams.get("host")?.trim() || null;

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : searchParams.get("session"),
    host,
  };
}
