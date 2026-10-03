import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveDependencySummary,
  normalizeDependency,
  normalizeAction,
  normalizePermit,
  parseInvariantStates,
  parseSourceSnapshot,
} from "../.test-output/domain.js";

test("normalizes live contract values without losing consequential fields", () => {
  const dependency = normalizeDependency({
    dependency_id: "payments-api",
    owner: "0xabc",
    name: "Acme Payments API",
    description: "Payment dependency",
    baseline_url: "https://example.com/base",
    baseline_sha256: "a".repeat(64),
    live_url: "https://example.com/live",
    invariants_json: '[{"id":"auth","rule":"OAuth is mandatory."}]',
    executor: "0xdef",
    lease_seconds: 3600n,
    version: 2n,
    active: true,
    status: "suspended",
    decision: "breaking",
    confidence_band: "high",
    invariant_states_json: '[{"id":"auth","state":"violated"}]',
    change_types_json: '["AUTHORIZATION"]',
    rationale: "Authentication changed.",
    source_snapshot: "authenticated_baseline|https://example.com/base|200|aaa|complete\nlive_dependency|https://example.com/live|200|bbb|complete",
    sources_healthy: true,
    baseline_hash_matches: true,
    last_assessed_at: 1791037962n,
  });

  assert.equal(dependency.status, "suspended");
  assert.equal(dependency.version, 2);
  assert.deepEqual(dependency.changeTypes, ["AUTHORIZATION"]);
  assert.equal(dependency.invariants[0].state, "violated");
  assert.equal(dependency.sources[1].fingerprint, "bbb");
});

test("parses malformed structured fields as safe empty collections", () => {
  assert.deepEqual(parseInvariantStates("not-json"), []);
  assert.deepEqual(parseSourceSnapshot(null), []);
});

test("derives a stop-state summary from breaking drift", () => {
  const summary = deriveDependencySummary({
    status: "suspended",
    decision: "breaking",
    confidenceBand: "high",
    sourcesHealthy: true,
    baselineHashMatches: true,
    invariants: [
      { id: "auth", state: "violated" },
      { id: "limit", state: "violated" },
      { id: "retention", state: "violated" },
    ],
  });

  assert.equal(summary.tone, "stop");
  assert.equal(summary.headline, "Execution suspended");
  assert.equal(summary.violatedCount, 3);
});

test("normalizes permit numbers and exposes one-use state", () => {
  const permit = normalizePermit({
    dependency_id: "payments-api",
    nonce: 1n,
    expiry: 1791040900n,
    dependency_version: 1n,
    source_snapshot: "snapshot",
    consumed: true,
    active: false,
  });

  assert.equal(permit.nonce, 1);
  assert.equal(permit.consumed, true);
  assert.equal(permit.active, false);
});

test("normalizes guarded action records for lifecycle display", () => {
  const action = normalizeAction({
    action_id: "charge-42",
    dependency_id: "payments-api",
    permit_nonce: 8n,
    dependency_version: 3n,
    source_snapshot: "sealed evidence",
    payload: "Charge 25 USD for printer paper.",
    status: "executed",
    started_at: 1791040100n,
    finalized_at: 1791040160n,
  });

  assert.equal(action.actionId, "charge-42");
  assert.equal(action.permitNonce, 8);
  assert.equal(action.status, "executed");
  assert.equal(action.finalizedAt, 1791040160);
});
