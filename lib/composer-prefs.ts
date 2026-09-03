/**
 * Client-side composer preferences (localStorage). These live outside the
 * native OMP config because they are ompweb UI behaviors.
 */

export type SubmitDuringRunBehavior = "steer" | "queue";

const SUBMIT_DURING_RUN_KEY = "omp-web:submit-during-run";

/** Default behavior when a message is submitted while the agent is running. */
export function getSubmitDuringRunBehavior(): SubmitDuringRunBehavior {
  if (typeof window === "undefined") return "steer";
  try {
    const value = window.localStorage.getItem(SUBMIT_DURING_RUN_KEY);
    if (value === "steer" || value === "queue") return value;
  } catch {
    // storage unavailable — fall through to the default
  }
  return "steer";
}

export function setSubmitDuringRunBehavior(behavior: SubmitDuringRunBehavior): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SUBMIT_DURING_RUN_KEY, behavior);
  } catch {
    // storage unavailable — the preference simply won't persist
  }
}

/**
 * localStorage key holding which models the composer lists, per machine.
 *
 * Model ids are machine-specific (each machine has its own omp auth and
 * models.yml), so one shared key let a set pinned on one machine filter
 * another machine's list down to nothing. An absent key means "no filter",
 * which is the right default for a machine that has never been customized.
 */
export function composerModelsStorageKey(hostId: string | null | undefined): string {
  return hostId ? `omp-composer-models:${hostId}` : "omp-composer-models";
}
