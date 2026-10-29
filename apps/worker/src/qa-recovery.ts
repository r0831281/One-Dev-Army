export interface QaFailure {
  /** Stable check/error identity; exclude candidate hashes, timestamps and line numbers. */
  fingerprint: string;
  summary: string;
}

export interface QaRecoveryState {
  repairsUsed: number;
  repairsLimit: number;
  failure: QaFailure | null;
  sameFailureRepairs: number;
}

export function routeQaFailure(state: QaRecoveryState, failure: QaFailure) {
  if (!failure.fingerprint.trim()) throw new Error("QA failure fingerprint is required");
  const sameFailureRepairs =
    state.failure?.fingerprint === failure.fingerprint ? state.sameFailureRepairs + 1 : 0;
  const next = { ...state, failure, sameFailureRepairs };
  // Exhaustion takes precedence: replanning must never reset the cumulative budget.
  if (state.repairsUsed >= state.repairsLimit) return { route: "RECOVERY" as const, state: next };
  if (sameFailureRepairs >= 2) return { route: "PLAN" as const, state: next };
  return { route: "IMPLEMENT" as const, state: { ...next, repairsUsed: state.repairsUsed + 1 } };
}
