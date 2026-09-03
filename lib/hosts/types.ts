/**
 * Host model for ompweb's multi-machine mode.
 *
 * Every machine that runs omp is a "host". The local machine is a host of
 * kind "local"; remote machines are hosts of kind "ssh" reached over a
 * multiplexed OpenSSH connection. Nothing beyond `omp` and a POSIX shell is
 * required on a remote host.
 */

export type HostKind = "local" | "ssh";

/**
 * Where a machine gets provider credentials.
 *
 * - "local":   the machine keeps its own. It works when the hub is down, which
 *              matters for anything running unattended, but the credentials
 *              live on that machine's disk.
 * - "broker":  the machine fetches credentials from the hub's vault. One login
 *              covers every machine and revoking is central, but a configured
 *              broker is authoritative: if it cannot be reached, omp fails
 *              rather than falling back to anything local.
 * - "gateway": the machine never receives a credential. It calls the hub's
 *              gateway, which injects them, so its token can only make model
 *              calls and cannot be used to extract secrets. The right choice
 *              for a machine other people can log into, at the cost of routing
 *              every request through the hub.
 */
export type CredentialPolicy = "local" | "broker" | "gateway";

/** Hub-held endpoints the broker and gateway policies point machines at. */
export interface CredentialEndpoints {
  brokerUrl?: string;
  brokerToken?: string;
  gatewayUrl?: string;
  gatewayToken?: string;
}

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
  /** Where this machine gets provider credentials (default "local"). */
  credentials?: CredentialPolicy;
}

export interface HostsFile {
  version: 1;
  /** Host selected when a request does not name one. */
  defaultHost?: string;
  /** Endpoints the "broker" and "gateway" policies point machines at. */
  credentials?: CredentialEndpoints;
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
  credentials: CredentialPolicy;
  /** Why the policy could not be applied on the last connect, if it failed. */
  credentialError: string | null;
  home: string | null;
  platform: string | null;
  ompVersion: string | null;
  lastError: string | null;
  lastSyncAt: number | null;
  lastSyncError: string | null;
}
