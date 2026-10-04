# Groundrule contracts

Groundrule's onchain workflow is implemented by both contracts in this directory. These are the complete sources used by the frontend methods in `src/lib/driftPermit.ts`.

## DriftPermit

- Source: `contracts/drift_permit.py`
- StudioNet address: `0x4Bdb443424bEe8dd22809dd0B76755109aC89615`
- Role: fetches the authenticated baseline and live dependency inside GenLayer's non-deterministic flow, reaches consensus over every declared invariant, and issues a short-lived one-use permit only for a high-confidence compatible result.

## Groundrule GuardedConsumer

- Source: `contracts/guarded_consumer.py`
- StudioNet address: `0x4cEdAc7a470d81EFC151564d5887Ba616bF56C31`
- Role: Groundrule's project-specific execution contract. It accepts an operator action only when the named DriftPermit lease is valid, claims that exact dependency/nonce pair, and finalizes the action only after permit consumption is visible onchain.

The deployed mapping, normalized source SHA-256 values, and frontend-called methods are recorded in `contracts/deployments.studionet.json`. `tests/repository.test.mjs` fails if a source is absent, its hash changes without updating the deployment record, an address diverges from the client, or a called method is missing from its source.

## Contract checks

Install the Python test toolchain and run:

```powershell
python -m pip install -r requirements.txt
npm run test:contracts
npm run lint:contracts
```

The direct tests cover source authentication, source failure, complete invariant classification, validator disagreement, permit lifetime and replay protection, owner authority, and GuardedConsumer access control. The integration test deploys both contracts in the simulator and exercises compatible assessment, contract-to-contract permit consumption, protected action finalization, breaking drift, and fail-closed execution.
