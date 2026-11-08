/**
 * Independently specified expected behavior.
 *
 * This table was written from the scenario intent (what each fault should do
 * to each policy), not generated from engine output. A test compares it with
 * actual runs, so a change in engine behavior that alters any outcome fails
 * loudly instead of silently updating a snapshot.
 *
 * key: `${scenario}|${policy}|${faultPreset or none}` -> expected run status and
 * the exact set of failing assertion IDs.
 */
export const EXPECTED: Record<string, { status: string; failing: string[] }> = {
  'lost-response-duplicate-charge|faulty|none': { status: 'completed', failing: [] },
  'lost-response-duplicate-charge|faulty|lost-response': { status: 'completed', failing: ['one-charge-per-order'] },
  'lost-response-duplicate-charge|faulty|slow-response': { status: 'completed', failing: ['one-charge-per-order'] },
  'lost-response-duplicate-charge|corrected|lost-response': { status: 'completed', failing: [] },
  'lost-response-duplicate-charge|corrected|slow-response': { status: 'completed', failing: [] },

  'duplicate-trigger-event|faulty|redelivery': { status: 'completed', failing: ['one-report-per-job', 'one-notification-per-job'] },
  'duplicate-trigger-event|corrected|redelivery': { status: 'completed', failing: [] },

  'rate-limit-retry-after|faulty|rate-limited-window': { status: 'failed', failing: ['retry-after', 'fetch-completes', 'observation-stored'] },
  'rate-limit-retry-after|corrected|rate-limited-window': { status: 'completed', failing: [] },

  'timeout-before-side-effect|faulty|first-request-timeout': { status: 'failed', failing: ['reservation-completes'] },
  'timeout-before-side-effect|corrected|first-request-timeout': { status: 'completed', failing: [] },
  // Recovery is impossible under a persistent outage: bounded and recorded, but not completed.
  'timeout-before-side-effect|corrected|persistent-outage': { status: 'unresolved', failing: ['reservation-completes'] },

  'retry-limit-exhausted|faulty|dependency-down': { status: 'limit-exhausted', failing: ['declared-limit', 'unresolved-recorded', 'ends-explicitly'] },
  'retry-limit-exhausted|corrected|dependency-down': { status: 'unresolved', failing: [] },

  // The contract check reports the upstream drift itself under both policies.
  'schema-drift-missing-field|faulty|field-dropped': { status: 'completed', failing: ['profile-contract', 'no-null-email', 'violation-stops'] },
  'schema-drift-missing-field|corrected|field-dropped': { status: 'failed', failing: ['profile-contract'] },

  'partial-search-gap|faulty|truncated': { status: 'completed', failing: ['gap-disclosed', 'complete-claim-supported'] },
  'partial-search-gap|corrected|truncated': { status: 'completed', failing: [] },

  // Staleness comes from virtual time, so the faulty policy fails even without a fault.
  'stale-cache-current|faulty|none': { status: 'completed', failing: ['freshness'] },
  'stale-cache-current|faulty|live-down': { status: 'completed', failing: ['freshness'] },
  'stale-cache-current|corrected|none': { status: 'completed', failing: [] },
  'stale-cache-current|corrected|live-down': { status: 'completed', failing: [] },

  'parallel-out-of-order|faulty|none': { status: 'completed', failing: [] },
  'parallel-out-of-order|faulty|slow-first': { status: 'completed', failing: ['correlation'] },
  'parallel-out-of-order|corrected|slow-first': { status: 'completed', failing: [] },

  'cancel-during-retry|faulty|cancel-in-backoff': { status: 'completed', failing: ['no-new-work'] },
  'cancel-during-retry|corrected|cancel-in-backoff': { status: 'cancelled', failing: [] },

  'untrusted-document-instructions|faulty|none': { status: 'completed', failing: ['allowlist'] },
  'untrusted-document-instructions|corrected|none': { status: 'completed', failing: [] },

  'research-report-missing-citation|faulty|none': { status: 'completed', failing: ['citations'] },
  'research-report-missing-citation|corrected|none': { status: 'completed', failing: [] },

  'repo-creation-automation|faulty|duplicate-event': { status: 'completed', failing: ['one-artifact', 'feature-branch'] },
  'repo-creation-automation|faulty|brief-inaccessible': { status: 'completed', failing: ['feature-branch', 'no-build-without-brief'] },
  'repo-creation-automation|faulty|incomplete-result': { status: 'completed', failing: ['feature-branch', 'done-means-complete', 'done-means-tests-pass'] },
  'repo-creation-automation|corrected|duplicate-event': { status: 'completed', failing: [] },
  'repo-creation-automation|corrected|brief-inaccessible': { status: 'unresolved', failing: [] },
  'repo-creation-automation|corrected|incomplete-result': { status: 'unresolved', failing: [] },
};
