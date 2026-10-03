export type InvariantState = {
  id: string;
  state: string;
};

export type SourceSnapshot = {
  role: string;
  url: string;
  status: number | null;
  fingerprint: string;
  completeness: string;
};

export type DependencyView = {
  dependencyId: string;
  owner: string;
  name: string;
  description: string;
  baselineUrl: string;
  baselineSha256: string;
  liveUrl: string;
  invariantsJson: string;
  executor: string;
  leaseSeconds: number;
  version: number;
  active: boolean;
  status: string;
  decision: string;
  confidenceBand: string;
  invariants: InvariantState[];
  changeTypes: string[];
  rationale: string;
  sourceSnapshot: string;
  sources: SourceSnapshot[];
  sourcesHealthy: boolean;
  baselineHashMatches: boolean;
  lastAssessedAt: number;
};

export type PermitView = {
  dependencyId: string;
  nonce: number;
  expiry: number;
  dependencyVersion: number;
  sourceSnapshot: string;
  consumed: boolean;
  active: boolean;
};

export type ActionView = {
  actionId: string;
  dependencyId: string;
  permitNonce: number;
  dependencyVersion: number;
  sourceSnapshot: string;
  payload: string;
  status: string;
  startedAt: number;
  finalizedAt: number;
};

export type DependencySummary = {
  tone: "go" | "caution" | "stop" | "neutral";
  headline: string;
  violatedCount: number;
};

type ContractRecord = Record<string, unknown>;

const asString = (value: unknown): string =>
  typeof value === "string" ? value : value == null ? "" : String(value);

const asNumber = (value: unknown): number => {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const asBoolean = (value: unknown): boolean => value === true;

const parseJsonArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return [];

  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export function parseInvariantStates(value: unknown): InvariantState[] {
  return parseJsonArray(value).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as ContractRecord;
    const id = asString(record.id).trim();
    const state = asString(record.state).trim();
    return id && state ? [{ id, state }] : [];
  });
}

export function parseSourceSnapshot(value: unknown): SourceSnapshot[] {
  if (typeof value !== "string" || value.trim() === "") return [];

  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [role = "", url = "", status = "", fingerprint = "", completeness = ""] =
        line.split("|");
      if (!role.trim() || !url.trim()) return [];
      const statusCode = Number(status);
      return [
        {
          role: role.trim(),
          url: url.trim(),
          status: Number.isFinite(statusCode) ? statusCode : null,
          fingerprint: fingerprint.trim(),
          completeness: completeness.trim(),
        },
      ];
    });
}

export function normalizeDependency(input: ContractRecord): DependencyView {
  const invariantStatesJson = input.invariant_states_json;
  const changeTypes = parseJsonArray(input.change_types_json)
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  const sourceSnapshot = asString(input.source_snapshot);

  return {
    dependencyId: asString(input.dependency_id),
    owner: asString(input.owner),
    name: asString(input.name),
    description: asString(input.description),
    baselineUrl: asString(input.baseline_url),
    baselineSha256: asString(input.baseline_sha256),
    liveUrl: asString(input.live_url),
    invariantsJson: asString(input.invariants_json),
    executor: asString(input.executor),
    leaseSeconds: asNumber(input.lease_seconds),
    version: asNumber(input.version),
    active: asBoolean(input.active),
    status: asString(input.status),
    decision: asString(input.decision),
    confidenceBand: asString(input.confidence_band),
    invariants: parseInvariantStates(invariantStatesJson),
    changeTypes,
    rationale: asString(input.rationale),
    sourceSnapshot,
    sources: parseSourceSnapshot(sourceSnapshot),
    sourcesHealthy: asBoolean(input.sources_healthy),
    baselineHashMatches: asBoolean(input.baseline_hash_matches),
    lastAssessedAt: asNumber(input.last_assessed_at),
  };
}

export function normalizePermit(input: ContractRecord): PermitView {
  return {
    dependencyId: asString(input.dependency_id),
    nonce: asNumber(input.nonce),
    expiry: asNumber(input.expiry),
    dependencyVersion: asNumber(input.dependency_version),
    sourceSnapshot: asString(input.source_snapshot),
    consumed: asBoolean(input.consumed),
    active: asBoolean(input.active),
  };
}

export function normalizeAction(input: ContractRecord): ActionView {
  return {
    actionId: asString(input.action_id),
    dependencyId: asString(input.dependency_id),
    permitNonce: asNumber(input.permit_nonce),
    dependencyVersion: asNumber(input.dependency_version),
    sourceSnapshot: asString(input.source_snapshot),
    payload: asString(input.payload),
    status: asString(input.status),
    startedAt: asNumber(input.started_at),
    finalizedAt: asNumber(input.finalized_at),
  };
}

export function deriveDependencySummary(
  dependency: Pick<
    DependencyView,
    | "status"
    | "decision"
    | "confidenceBand"
    | "sourcesHealthy"
    | "baselineHashMatches"
    | "invariants"
  >,
): DependencySummary {
  const violatedCount = dependency.invariants.filter(
    (invariant) => invariant.state.toLowerCase() === "violated",
  ).length;
  const status = dependency.status.toLowerCase();
  const decision = dependency.decision.toLowerCase();

  if (status === "suspended" || decision === "breaking" || violatedCount > 0) {
    return { tone: "stop", headline: "Execution suspended", violatedCount };
  }

  if (decision === "compatible" && status !== "inactive") {
    return { tone: "go", headline: "Within groundrule", violatedCount };
  }

  if (
    decision === "inconclusive" ||
    !dependency.sourcesHealthy ||
    !dependency.baselineHashMatches
  ) {
    return { tone: "caution", headline: "Evidence inconclusive", violatedCount };
  }

  return { tone: "neutral", headline: "Awaiting assessment", violatedCount };
}
