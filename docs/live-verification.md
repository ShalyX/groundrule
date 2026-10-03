# Live StudioNet verification

Verified on October 3, 2026 using the production Groundrule interface, wallet `0x1dcb045123730e606a88380bce534332f50332d2`, and the deployed StudioNet contracts.

## Compatible dependency flow

Dependency: `groundrule-safe-demo-20261003`

1. Groundrule registered the dependency with a sealed baseline, three explicit conditions, a one-hour lease, and GuardedConsumer as the authorized executor.
   - Registration transaction: [`0xfe74527f8032ced6dede1bde0fc497e96e34b26a2db162d408d82d006e339300`](https://explorer-studio.genlayer.com/tx/0xfe74527f8032ced6dede1bde0fc497e96e34b26a2db162d408d82d006e339300)
2. The interface submitted a consensus assessment and waited for finalization.
   - Assessment transaction: [`0xcbc8015a237d517e3077387e2f9556d283bd58252b20c726d1aac466e5148412`](https://explorer-studio.genlayer.com/tx/0xcbc8015a237d517e3077387e2f9556d283bd58252b20c726d1aac466e5148412)
   - Final state: `compatible`
   - Confidence: `high`
   - Source health: `true`
   - Baseline hash match: `true`
   - Invariants: `auth`, `charge_limit`, and `data_retention` all `preserved`
3. Groundrule routed a 25 USD printer-paper operation through GuardedConsumer using permit nonce `1`.
   - Start transaction: [`0x3e4f4114a24e8a0b0a558d7009ccd084e87e42f81cdb4fb382d5cf85ae77f868`](https://explorer-studio.genlayer.com/tx/0x3e4f4114a24e8a0b0a558d7009ccd084e87e42f81cdb4fb382d5cf85ae77f868)
4. The operator finalized the action only after GuardedConsumer confirmed the permit had been consumed.
   - Action ID: `operation-musvkmey`
   - Final action status: `executed`
   - Started at: `1791061356`
   - Finalized at: `1791061623`

## Post-execution checks

Fresh contract reads after finalization returned:

```text
dependency.status     = compatible
dependency.version    = 1
permit.nonce          = 1
permit.consumed       = true
permit.active         = false
is_permit_valid(...1) = false
action.status         = executed
```

The action record retains the exact authenticated-baseline and live-dependency URLs, HTTP status codes, complete SHA-256 fingerprints, and dependency version used during assessment. This proves the execution result is tied to the reviewed evidence rather than a later mutable fetch.

## Breaking dependency flow

The existing `payments-api` example remains intentionally breaking. Its finalized state reports three violated conditions, suspends the dependency, exposes no valid permit, and disables protected execution in the interface.
