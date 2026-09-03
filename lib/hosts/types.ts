/**
 * Host model for ompweb's multi-machine mode.
 *
 * Every machine that runs omp is a "host". The local machine is a host of
 * kind "local"; remote machines are hosts of kind "ssh" reached over a
 * multiplexed OpenSSH connection. Nothing beyond `omp` and a POSIX shell is
 * required on a remote host.
 */

export type HostKind = "local" | "ssh";

export interface SshHostConfig {
  /** Hostname, IP, or an alias from ~/.ssh/config (e.g. a Tailscale MagicDNS name). */
  host: string;
  user?: string;
  port?: number;
  /** Private key path; when set, IdentitiesOnly is enforced. */
  identityFile?: string;
}

export interface HostConfig {
  /** Stable identifier: lowercase letters, digits, "-" and "_" (max 64 chars). */
  id: string;
  /** Display name shown in the UI. */
  name: string;
  kind: HostKind;
  enabled: boolean;
  ssh?: SshHostConfig;
  /** omp binary on the host. Defaults to "omp" resolved on the host's PATH. */
  ompBin?: string;
  /** omp agent directory on the host. Defaults to <home>/.omp/agent. */
  agentDir?: string;
  /** Preferred working directory for new sessions on this host. */
  defaultCwd?: string;
}

export interface HostsFile {
  version: 1;
  /** Host selected when a request does not name one. */
  defaultHost?: string;
  hosts: HostConfig[];
}

export type HostConnectionState = "unknown" | "connecting" | "connected" | "error" | "disabled";

/** Client-facing view of a host (never includes secrets or local paths). */
export interface HostSummary {
  id: string;
  name: string;
  kind: HostKind;
  enabled: boolean;
  isDefault: boolean;
  status: HostConnectionState;
  ssh?: { host: string; user?: string; port?: number; identityFile?: string };
  ompBin?: string;
  agentDir?: string;
  defaultCwd?: string;
  home: string | null;
  platform: string | null;
  ompVersion: string | null;
  lastError: string | null;
  lastSyncAt: number | null;
  lastSyncError: string | null;
}
