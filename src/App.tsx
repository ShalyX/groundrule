import {
  ArrowUpRight,
  Check,
  CircleAlert,
  Clock3,
  ExternalLink,
  Plus,
  Radio,
  RefreshCw,
  Wallet,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  deriveDependencySummary,
  type ActionView,
  type DependencyView,
  type PermitView,
} from "./lib/domain";
import {
  GUARDED_CONSUMER_ADDRESS,
  DRIFTPERMIT_ADDRESS,
  assessDependency,
  connectWallet,
  contractUrl,
  finalizeProtectedAction,
  getAction,
  getDependency,
  getPermit,
  isPermitValid,
  reconnectWallet,
  registerDependency,
  startProtectedAction,
  transactionUrl,
  waitForFinalization,
} from "./lib/driftPermit";

const DEFAULT_DEPENDENCY = "payments-api";
const STORAGE_KEY = "groundrule:dependencies";

type TransactionState = {
  stage: "idle" | "signing" | "submitted" | "finalizing" | "finalized" | "error";
  hash?: string;
  message?: string;
};

type DeclaredInvariant = { id: string; rule: string };

type DependencyDraft = {
  dependencyId: string;
  name: string;
  description: string;
  baselineUrl: string;
  baselineSha256: string;
  liveUrl: string;
  executor: string;
  leaseHours: string;
};

const EMPTY_DRAFT: DependencyDraft = {
  dependencyId: "",
  name: "",
  description: "",
  baselineUrl: "",
  baselineSha256: "",
  liveUrl: "",
  executor: GUARDED_CONSUMER_ADDRESS,
  leaseHours: "1",
};

function formatAddress(value: string): string {
  return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : "—";
}

function formatTimestamp(value: number): string {
  if (!value) return "Not assessed";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1000));
}

function formatDuration(seconds: number): string {
  if (!seconds) return "—";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function parseDeclaredInvariants(value: string): DeclaredInvariant[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      if (typeof record.id !== "string" || typeof record.rule !== "string") return [];
      return [{ id: record.id, rule: record.rule }];
    });
  } catch {
    return [];
  }
}

function readKnownDependencies(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [DEFAULT_DEPENDENCY];
    const values = parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return Array.from(new Set([DEFAULT_DEPENDENCY, ...values]));
  } catch {
    return [DEFAULT_DEPENDENCY];
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  if (message.toLowerCase().includes("user rejected")) return "The wallet request was declined.";
  return message.replace(/^Error:\s*/i, "");
}

function App() {
  const [knownDependencies, setKnownDependencies] = useState<string[]>(readKnownDependencies);
  const [selectedId, setSelectedId] = useState(DEFAULT_DEPENDENCY);
  const [newDependencyId, setNewDependencyId] = useState("");
  const [dependency, setDependency] = useState<DependencyView | null>(null);
  const [permit, setPermit] = useState<PermitView | null>(null);
  const [permitValid, setPermitValid] = useState(false);
  const [account, setAccount] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [transaction, setTransaction] = useState<TransactionState>({ stage: "idle" });
  const [registerOpen, setRegisterOpen] = useState(false);
  const [draft, setDraft] = useState<DependencyDraft>(EMPTY_DRAFT);
  const [conditions, setConditions] = useState<DeclaredInvariant[]>([{ id: "", rule: "" }]);
  const [actionId, setActionId] = useState(() => `operation-${Date.now().toString(36)}`);
  const [actionPayload, setActionPayload] = useState("");
  const [actionRecord, setActionRecord] = useState<ActionView | null>(null);

  const loadDependency = useCallback(async (dependencyId: string) => {
    setLoading(true);
    setError(null);
    try {
      const [dependencyResult, permitResult] = await Promise.allSettled([
        getDependency(dependencyId),
        getPermit(dependencyId),
      ]);
      if (dependencyResult.status === "rejected") throw dependencyResult.reason;
      setDependency(dependencyResult.value);
      const loadedPermit = permitResult.status === "fulfilled" ? permitResult.value : null;
      setPermit(loadedPermit);
      setPermitValid(loadedPermit ? await isPermitValid(dependencyId, loadedPermit.nonce) : false);
    } catch (loadError) {
      setDependency(null);
      setPermit(null);
      setPermitValid(false);
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reconnectWallet().then(setAccount).catch(() => setAccount(null));
  }, []);

  useEffect(() => {
    void loadDependency(selectedId);
  }, [loadDependency, selectedId]);

  useEffect(() => {
    setActionRecord(null);
    setActionId(`operation-${Date.now().toString(36)}`);
    setActionPayload("");
  }, [selectedId]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(knownDependencies));
  }, [knownDependencies]);

  const summary = useMemo(
    () => dependency ? deriveDependencySummary(dependency) : null,
    [dependency],
  );
  const declaredInvariants = useMemo(
    () => parseDeclaredInvariants(dependency?.invariantsJson || ""),
    [dependency?.invariantsJson],
  );

  const handleConnect = async () => {
    setError(null);
    try {
      setAccount(await connectWallet());
    } catch (connectError) {
      setError(errorMessage(connectError));
    }
  };

  const handleAssess = async () => {
    if (!dependency || !window.ethereum) {
      setError("Connect a browser wallet before running a consensus check.");
      return;
    }
    setError(null);
    try {
      let activeAccount = account;
      if (!activeAccount) {
        activeAccount = await connectWallet();
        setAccount(activeAccount);
      }
      setTransaction({ stage: "signing", message: "Review the assessment request in your wallet." });
      const hash = await assessDependency(activeAccount, window.ethereum, dependency.dependencyId);
      setTransaction({ stage: "submitted", hash, message: "Assessment submitted to StudioNet." });
      setTransaction({ stage: "finalizing", hash, message: "Validators are comparing the live dependency with its approved baseline." });
      await waitForFinalization(activeAccount, window.ethereum, hash);
      await loadDependency(dependency.dependencyId);
      setTransaction({ stage: "finalized", hash, message: "Consensus result finalized. The control state below is current." });
    } catch (assessmentError) {
      setTransaction({ stage: "error", message: errorMessage(assessmentError) });
    }
  };

  const handleAddDependency = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = newDependencyId.trim();
    if (!value) return;
    setKnownDependencies((current) => Array.from(new Set([...current, value])));
    setSelectedId(value);
    setNewDependencyId("");
  };

  const handleRegister = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const dependencyId = draft.dependencyId.trim().toLowerCase();
    const cleanConditions = conditions
      .map((condition) => ({ id: condition.id.trim().toLowerCase(), rule: condition.rule.trim() }))
      .filter((condition) => condition.id && condition.rule);
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(dependencyId)) {
      setError("Use a 3–64 character dependency ID with lowercase letters, numbers, and hyphens.");
      return;
    }
    if (!draft.name.trim() || !draft.description.trim()) {
      setError("Name and operational purpose are required.");
      return;
    }
    if (!/^https:\/\//i.test(draft.baselineUrl) || !/^https:\/\//i.test(draft.liveUrl)) {
      setError("Baseline and live evidence must use HTTPS URLs.");
      return;
    }
    if (!/^[a-f0-9]{64}$/i.test(draft.baselineSha256.trim())) {
      setError("The sealed baseline fingerprint must be a 64-character SHA-256 hash.");
      return;
    }
    if (cleanConditions.length === 0) {
      setError("Add at least one explicit condition before registering the dependency.");
      return;
    }
    if (!window.ethereum) {
      setError("Connect a browser wallet before registering a groundrule.");
      return;
    }

    setError(null);
    try {
      let activeAccount = account;
      if (!activeAccount) {
        activeAccount = await connectWallet();
        setAccount(activeAccount);
      }
      setTransaction({ stage: "signing", message: "Review the new dependency control in your wallet." });
      const hash = await registerDependency(activeAccount, window.ethereum, {
        dependencyId,
        name: draft.name.trim(),
        description: draft.description.trim(),
        baselineUrl: draft.baselineUrl.trim(),
        baselineSha256: draft.baselineSha256.trim().toLowerCase(),
        liveUrl: draft.liveUrl.trim(),
        invariantsJson: JSON.stringify(cleanConditions),
        executor: draft.executor.trim(),
        leaseSeconds: Math.max(60, Math.round(Number(draft.leaseHours) * 3600)),
      });
      setTransaction({ stage: "finalizing", hash, message: "Registering the human-approved baseline and conditions on StudioNet." });
      await waitForFinalization(activeAccount, window.ethereum, hash);
      setKnownDependencies((current) => Array.from(new Set([...current, dependencyId])));
      setSelectedId(dependencyId);
      setRegisterOpen(false);
      setDraft(EMPTY_DRAFT);
      setConditions([{ id: "", rule: "" }]);
      await loadDependency(dependencyId);
      setTransaction({ stage: "finalized", hash, message: "Groundrule registered. Run its first consensus check when ready." });
    } catch (registrationError) {
      setTransaction({ stage: "error", message: errorMessage(registrationError) });
    }
  };

  const handleStartAction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!dependency || !permit || !permitValid) {
      setError("This dependency has no valid one-use permit. Reassess it before attempting execution.");
      return;
    }
    if (!actionId.trim() || !actionPayload.trim()) {
      setError("Action ID and payload are required.");
      return;
    }
    if (!window.ethereum) {
      setError("Connect the configured operator wallet before starting a protected action.");
      return;
    }
    setError(null);
    try {
      let activeAccount = account;
      if (!activeAccount) {
        activeAccount = await connectWallet();
        setAccount(activeAccount);
      }
      setTransaction({ stage: "signing", message: "Review the protected action in your wallet." });
      const hash = await startProtectedAction(
        activeAccount,
        window.ethereum,
        actionId.trim(),
        dependency.dependencyId,
        permit.nonce,
        actionPayload.trim(),
      );
      setTransaction({ stage: "finalizing", hash, message: "The consumer is claiming the one-use permit before execution." });
      await waitForFinalization(activeAccount, window.ethereum, hash);
      const record = await getAction(actionId.trim());
      setActionRecord(record);
      await loadDependency(dependency.dependencyId);
      setTransaction({ stage: "finalized", hash, message: "Permit consumed. The action is ready for final execution." });
    } catch (actionError) {
      setTransaction({ stage: "error", message: errorMessage(actionError) });
    }
  };

  const handleFinalizeAction = async () => {
    if (!actionRecord || !window.ethereum) return;
    setError(null);
    try {
      let activeAccount = account;
      if (!activeAccount) {
        activeAccount = await connectWallet();
        setAccount(activeAccount);
      }
      setTransaction({ stage: "signing", message: "Review final execution in your wallet." });
      const hash = await finalizeProtectedAction(activeAccount, window.ethereum, actionRecord.actionId);
      setTransaction({ stage: "finalizing", hash, message: "Finalizing the permit-backed action on StudioNet." });
      await waitForFinalization(activeAccount, window.ethereum, hash);
      setActionRecord(await getAction(actionRecord.actionId));
      setTransaction({ stage: "finalized", hash, message: "Protected action executed with its evidence snapshot preserved." });
    } catch (finalizeError) {
      setTransaction({ stage: "error", message: errorMessage(finalizeError) });
    }
  };

  const busy = ["signing", "submitted", "finalizing"].includes(transaction.stage);
  const tone = summary?.tone ?? "neutral";

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Groundrule home">
          <img src="/groundrule-mark.svg" alt="" />
          <span>Groundrule</span>
        </a>
        <div className="network-status" aria-label="Connected network">
          <Radio size={14} aria-hidden="true" />
          StudioNet · Live
        </div>
        <button className="wallet-button" type="button" onClick={() => void handleConnect()}>
          <Wallet size={16} aria-hidden="true" />
          {account ? formatAddress(account) : "Connect wallet"}
        </button>
      </header>

      {registerOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="registration-sheet" role="dialog" aria-modal="true" aria-labelledby="register-title">
            <header>
              <div>
                <span className="section-index">NEW CONTROL</span>
                <h2 id="register-title">Declare a groundrule</h2>
                <p>Seal a trusted baseline, name the conditions that must remain true, and choose the contract allowed to execute.</p>
              </div>
              <button type="button" onClick={() => setRegisterOpen(false)} aria-label="Close registration"><X /></button>
            </header>
            <form onSubmit={(event) => void handleRegister(event)}>
              <div className="form-grid">
                <label><span>Dependency ID</span><input required placeholder="payments-provider" value={draft.dependencyId} onChange={(event) => setDraft({ ...draft, dependencyId: event.target.value })} /></label>
                <label><span>Display name</span><input required placeholder="Acme Payments API" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                <label className="wide"><span>Operational purpose</span><textarea required placeholder="What does the agent rely on this service to do?" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
                <label className="wide"><span>Sealed baseline URL</span><input required type="url" placeholder="https://…/policy-v1.md" value={draft.baselineUrl} onChange={(event) => setDraft({ ...draft, baselineUrl: event.target.value })} /></label>
                <label className="wide"><span>Baseline SHA-256</span><input required spellCheck="false" placeholder="64-character fingerprint" value={draft.baselineSha256} onChange={(event) => setDraft({ ...draft, baselineSha256: event.target.value })} /></label>
                <label className="wide"><span>Live dependency URL</span><input required type="url" placeholder="https://…/current-policy.md" value={draft.liveUrl} onChange={(event) => setDraft({ ...draft, liveUrl: event.target.value })} /></label>
                <label><span>Authorized executor</span><input required spellCheck="false" value={draft.executor} onChange={(event) => setDraft({ ...draft, executor: event.target.value })} /></label>
                <label><span>Permit lease · hours</span><input required type="number" min="0.02" max="24" step="0.01" value={draft.leaseHours} onChange={(event) => setDraft({ ...draft, leaseHours: event.target.value })} /></label>
              </div>
              <div className="condition-builder">
                <div className="condition-heading">
                  <div><span>Conditions</span><p>Write concrete statements validators can compare against the live service.</p></div>
                  <button type="button" onClick={() => setConditions((current) => [...current, { id: "", rule: "" }])}><Plus size={15} /> Add condition</button>
                </div>
                {conditions.map((condition, index) => (
                  <div className="condition-row" key={index}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <input aria-label={`Condition ${index + 1} ID`} placeholder="condition-id" value={condition.id} onChange={(event) => setConditions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, id: event.target.value } : item))} />
                    <input aria-label={`Condition ${index + 1} rule`} placeholder="The service must…" value={condition.rule} onChange={(event) => setConditions((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, rule: event.target.value } : item))} />
                    <button type="button" disabled={conditions.length === 1} onClick={() => setConditions((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove condition ${index + 1}`}><X size={15} /></button>
                  </div>
                ))}
              </div>
              <footer className="sheet-actions">
                <button type="button" onClick={() => setRegisterOpen(false)}>Cancel</button>
                <button className="primary-action" type="submit" disabled={busy}>{busy ? "Registering…" : "Register on StudioNet"}</button>
              </footer>
            </form>
          </section>
        </div>
      )}

      <div className="workspace" id="top">
        <aside className="rail" aria-label="Dependency navigation">
          <div className="rail-heading">
            <span className="section-index">01</span>
            <div>
              <p>Watchlist</p>
              <span>{knownDependencies.length} dependenc{knownDependencies.length === 1 ? "y" : "ies"}</span>
            </div>
          </div>
          <nav className="dependency-list">
            {knownDependencies.map((id) => (
              <button
                className={id === selectedId ? "dependency-item active" : "dependency-item"}
                key={id}
                onClick={() => setSelectedId(id)}
                type="button"
              >
                <span className="dependency-dot" />
                <span>
                  <strong>{id}</strong>
                  <small>{id === selectedId && dependency ? dependency.status : "Tracked"}</small>
                </span>
                <ArrowUpRight size={15} aria-hidden="true" />
              </button>
            ))}
          </nav>
          <button className="new-control-button" type="button" onClick={() => setRegisterOpen(true)}>
            <Plus size={16} /> Create groundrule
          </button>
          <form className="add-dependency" onSubmit={handleAddDependency}>
            <label htmlFor="dependency-id">Add an existing dependency</label>
            <div>
              <input
                id="dependency-id"
                value={newDependencyId}
                onChange={(event) => setNewDependencyId(event.target.value)}
                placeholder="dependency-id"
              />
              <button type="submit" aria-label="Add dependency"><Plus size={17} /></button>
            </div>
          </form>
          <div className="rail-footnote">
            <span>Contract</span>
            <a href={contractUrl(DRIFTPERMIT_ADDRESS)} target="_blank" rel="noreferrer">
              {formatAddress(DRIFTPERMIT_ADDRESS)} <ExternalLink size={12} />
            </a>
          </div>
        </aside>

        <main className="main-panel">
          {error && (
            <div className="error-banner" role="alert">
              <CircleAlert size={18} />
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} aria-label="Dismiss error"><X size={16} /></button>
            </div>
          )}

          {transaction.stage !== "idle" && (
            <div className={`transaction-banner ${transaction.stage}`} aria-live="polite">
              <div className="transaction-icon">
                {transaction.stage === "finalized" ? <Check size={18} /> : transaction.stage === "error" ? <X size={18} /> : <RefreshCw size={18} />}
              </div>
              <div>
                <strong>{transaction.stage === "finalized" ? "Finalized" : transaction.stage === "error" ? "Transaction failed" : "Consensus in progress"}</strong>
                <span>{transaction.message}</span>
              </div>
              {transaction.hash && (
                <a href={transactionUrl(transaction.hash)} target="_blank" rel="noreferrer">
                  View transaction <ExternalLink size={13} />
                </a>
              )}
              <button type="button" onClick={() => setTransaction({ stage: "idle" })} aria-label="Dismiss transaction status"><X size={16} /></button>
            </div>
          )}

          {loading ? (
            <div className="loading-state" aria-live="polite">
              <span className="loading-rule" />
              <p>Reading finalized contract state</p>
            </div>
          ) : dependency && summary ? (
            <>
              <section className={`verdict verdict-${tone}`}>
                <div className="verdict-copy">
                  <div className="eyebrow">
                    <span className="status-pip" />
                    {dependency.decision || "unassessed"} · {dependency.confidenceBand || "no confidence band"}
                  </div>
                  <h1>{summary.headline}</h1>
                  <p>{dependency.rationale.split(/\s+\(1\)\s+/)[0] || "This dependency has not yet been assessed against its declared groundrule."}</p>
                </div>
                <div className="verdict-stamp" aria-label={`${summary.violatedCount} violated invariants`}>
                  <strong>{String(summary.violatedCount).padStart(2, "0")}</strong>
                  <span>violated<br />invariants</span>
                </div>
              </section>

              <section className="identity-strip" aria-label="Dependency details">
                <div><span>Dependency</span><strong>{dependency.name || dependency.dependencyId}</strong></div>
                <div><span>Control state</span><strong>{dependency.status || "unknown"}</strong></div>
                <div><span>Version</span><strong>v{dependency.version}</strong></div>
                <div><span>Last assessed</span><strong>{formatTimestamp(dependency.lastAssessedAt)}</strong></div>
              </section>

              <section className="operator-bar">
                <div>
                  <span className="section-index">02</span>
                  <div>
                    <h2>Re-check live terms</h2>
                    <p>Ask GenLayer validators to compare the current service against the approved baseline.</p>
                  </div>
                </div>
                <button className="primary-action" type="button" disabled={busy} onClick={() => void handleAssess()}>
                  <RefreshCw size={17} className={busy ? "spin" : ""} />
                  {busy ? "Consensus running" : "Run consensus check"}
                </button>
              </section>

              <div className="content-grid">
                <section className="action-panel panel-block">
                  <div className="panel-heading">
                    <div>
                      <span className="section-index">03</span>
                      <h2>Protected execution</h2>
                    </div>
                    <span className={permitValid ? "action-gate open" : "action-gate closed"}>{permitValid ? "Gate open" : "Gate closed"}</span>
                  </div>
                  <div className="action-workspace">
                    <div className="action-intro">
                      <p>Run a real action through the guarded consumer. The consumer checks this dependency’s finalized permit, claims it once, and preserves the evidence snapshot.</p>
                      <div className="flowline" aria-label="Protected action lifecycle">
                        <span className={permitValid ? "complete" : "blocked"}>01 · assess</span>
                        <i />
                        <span className={actionRecord ? "complete" : ""}>02 · claim permit</span>
                        <i />
                        <span className={actionRecord?.status === "executed" ? "complete" : ""}>03 · execute</span>
                      </div>
                    </div>
                    <form className="action-form" onSubmit={(event) => void handleStartAction(event)}>
                      <label><span>Action ID</span><input value={actionId} onChange={(event) => setActionId(event.target.value)} disabled={Boolean(actionRecord)} /></label>
                      <label><span>Action payload</span><textarea placeholder="Describe the operation that depends on these terms…" value={actionPayload} onChange={(event) => setActionPayload(event.target.value)} disabled={Boolean(actionRecord)} /></label>
                      {!actionRecord ? (
                        <button className="primary-action" type="submit" disabled={!permitValid || busy}>
                          {permitValid ? "Claim permit & start" : "Blocked by groundrule"}
                        </button>
                      ) : actionRecord.status === "awaiting_permit" ? (
                        <button className="primary-action" type="button" disabled={busy} onClick={() => void handleFinalizeAction()}>
                          Finalize protected action
                        </button>
                      ) : (
                        <div className="executed-state"><Check size={16} /> Executed at {formatTimestamp(actionRecord.finalizedAt)}</div>
                      )}
                    </form>
                  </div>
                </section>

                <section className="ledger panel-block">
                  <div className="panel-heading">
                    <div>
                      <span className="section-index">04</span>
                      <h2>Declared groundrule</h2>
                    </div>
                    <span>{declaredInvariants.length} conditions</span>
                  </div>
                  <div className="invariant-list">
                    {declaredInvariants.length > 0 ? declaredInvariants.map((invariant, index) => {
                      const evaluated = dependency.invariants.find((item) => item.id === invariant.id);
                      const state = evaluated?.state || "unknown";
                      return (
                        <article className={`invariant-row invariant-${state.toLowerCase()}`} key={invariant.id}>
                          <span className="row-number">{String(index + 1).padStart(2, "0")}</span>
                          <div><strong>{invariant.id}</strong><p>{invariant.rule}</p></div>
                          <span className="state-label">{state}</span>
                        </article>
                      );
                    }) : (
                      <p className="empty-copy">No structured conditions were returned by the contract.</p>
                    )}
                  </div>
                  {dependency.rationale && (
                    <details className="rationale-disclosure">
                      <summary>Read full consensus rationale</summary>
                      <p>{dependency.rationale}</p>
                    </details>
                  )}
                </section>

                <section className="permit-panel panel-block">
                  <div className="panel-heading">
                    <div>
                      <span className="section-index">05</span>
                      <h2>Execution permit</h2>
                    </div>
                    <span className={permitValid ? "permit-badge valid" : "permit-badge invalid"}>
                      {permitValid ? "Valid" : "Blocked"}
                    </span>
                  </div>
                  <div className="permit-figure">
                    <div className="permit-signal">{permitValid ? <Check /> : <X />}</div>
                    <p>{permitValid ? "One protected action may proceed." : "No protected action can proceed on this dependency."}</p>
                  </div>
                  <dl className="compact-data">
                    <div><dt>Nonce</dt><dd>{permit?.nonce ?? "—"}</dd></div>
                    <div><dt>Consumed</dt><dd>{permit ? (permit.consumed ? "Yes" : "No") : "—"}</dd></div>
                    <div><dt>Lease</dt><dd>{formatDuration(dependency.leaseSeconds)}</dd></div>
                    <div><dt>Dependency version</dt><dd>{permit?.dependencyVersion ?? "—"}</dd></div>
                  </dl>
                </section>

                <section className="sources-panel panel-block">
                  <div className="panel-heading">
                    <div>
                      <span className="section-index">06</span>
                      <h2>Evidence sources</h2>
                    </div>
                    <span>{dependency.sourcesHealthy ? "Healthy fetch" : "Fetch issue"}</span>
                  </div>
                  <div className="source-table" role="table" aria-label="Evidence sources">
                    <div className="source-row source-head" role="row">
                      <span>Role</span><span>Endpoint</span><span>HTTP</span><span>Fingerprint</span>
                    </div>
                    {dependency.sources.map((source) => (
                      <div className="source-row" role="row" key={`${source.role}-${source.url}`}>
                        <strong>{source.role.replaceAll("_", " ")}</strong>
                        <a href={source.url} target="_blank" rel="noreferrer">{source.url}<ExternalLink size={12} /></a>
                        <span>{source.status ?? "—"}</span>
                        <code>{source.fingerprint ? `${source.fingerprint.slice(0, 9)}…` : "—"}</code>
                      </div>
                    ))}
                    {dependency.sources.length === 0 && <p className="empty-copy">No source snapshot has been recorded yet.</p>}
                  </div>
                </section>

                <section className="record-panel panel-block">
                  <div className="panel-heading">
                    <div>
                      <span className="section-index">07</span>
                      <h2>Control record</h2>
                    </div>
                  </div>
                  <dl className="record-data">
                    <div><dt>Owner</dt><dd title={dependency.owner}>{formatAddress(dependency.owner)}</dd></div>
                    <div><dt>Executor</dt><dd title={dependency.executor}>{formatAddress(dependency.executor)}</dd></div>
                    <div><dt>Baseline sealed</dt><dd>{dependency.baselineHashMatches ? "Hash matches" : "Mismatch"}</dd></div>
                    <div><dt>Change classes</dt><dd>{dependency.changeTypes.length ? dependency.changeTypes.join(", ") : "None"}</dd></div>
                  </dl>
                  <a className="text-link" href={contractUrl(DRIFTPERMIT_ADDRESS)} target="_blank" rel="noreferrer">
                    Inspect contract on Explorer <ExternalLink size={13} />
                  </a>
                </section>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <Clock3 size={28} />
              <h1>Dependency not found</h1>
              <p>Check the identifier, or add a dependency that already exists on the DriftPermit contract.</p>
              <button type="button" onClick={() => void loadDependency(selectedId)}>Try again</button>
            </div>
          )}
        </main>
      </div>

      <footer>
        <span>Groundrule / StudioNet</span>
        <p>Human-approved terms. Machine-enforced stops.</p>
        <a href="https://genlayer.com" target="_blank" rel="noreferrer">Powered by GenLayer <ExternalLink size={12} /></a>
      </footer>
    </div>
  );
}

export default App;
