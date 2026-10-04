import hashlib
import json
from pathlib import Path

import pytest

from glsim.engine import SimEngine
from glsim.state import StateStore


ROOT = Path(__file__).resolve().parents[2]
PERMIT = ROOT / "contracts" / "drift_permit.py"
CONSUMER = ROOT / "contracts" / "guarded_consumer.py"
OWNER = "0x1111111111111111111111111111111111111111"
CALLER = "0x2222222222222222222222222222222222222222"
BASELINE_URL = "https://raw.githubusercontent.com/acme/payments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/terms.md"
LIVE_URL = "https://raw.githubusercontent.com/acme/payments/main/terms.md"
BASELINE_BODY = "Payments API v1. OAuth is required. Maximum charge is 100 USD. Customer data is not retained."
INVARIANTS = [
    {"id": "auth", "rule": "OAuth remains mandatory for every payment request."},
    {"id": "charge_limit", "rule": "A single charge cannot exceed 100 USD."},
    {"id": "data_retention", "rule": "Customer data is not retained by the provider."},
]


def review(decision="compatible"):
    states = "preserved" if decision == "compatible" else "violated"
    return json.dumps(
        {
            "decision": decision,
            "invariants": [
                {"id": invariant["id"], "state": states} for invariant in INVARIANTS
            ],
            "change_types": [] if decision == "compatible" else ["POLICY"],
            "confidence_band": "high",
            "rationale": "The live source was independently compared with the authenticated baseline.",
        }
    )


def mock_review(engine, live_body, decision="compatible"):
    engine.vm.mock_web(BASELINE_URL, {"status": 200, "body": BASELINE_BODY})
    engine.vm.mock_web(LIVE_URL, {"status": 200, "body": live_body})
    engine.vm.mock_llm("DRIFT_PERMIT_ASSESSMENT", review(decision))


def test_dependency_permit_guards_a_real_contract_to_contract_action():
    engine = SimEngine(StateStore(seed="drift-permit-lifecycle"))
    engine.activate()
    try:
        permit_address, _ = engine.deploy(str(PERMIT), [], sender=OWNER)
        consumer_address, _ = engine.deploy(
            str(CONSUMER), [permit_address, OWNER], sender=OWNER
        )
        engine.call_method(
            permit_address,
            "register_dependency",
            [
                "payments-api",
                "Acme Payments API",
                "An external payment API used by an autonomous purchasing agent.",
                BASELINE_URL,
                hashlib.sha256(BASELINE_BODY.encode("utf-8")).hexdigest(),
                LIVE_URL,
                json.dumps(INVARIANTS),
                consumer_address,
                3600,
            ],
            sender=OWNER,
        )

        mock_review(engine, BASELINE_BODY + " Documentation wording was clarified.")
        engine.call_method(
            permit_address, "assess_dependency", ["payments-api"], sender=CALLER
        )
        permit = engine.call_method(
            permit_address, "get_permit", ["payments-api"], sender=CALLER
        )
        assert permit["nonce"] == 1
        assert permit["active"] is True

        engine.call_method(
            consumer_address,
            "start_action",
            ["charge-1", "payments-api", 1, "Charge 25 USD for printer paper."],
            sender=OWNER,
        )
        consumed = engine.call_method(
            permit_address, "get_permit", ["payments-api"], sender=CALLER
        )
        assert consumed["consumed"] is True
        assert consumed["active"] is False

        engine.call_method(
            consumer_address, "finalize_action", ["charge-1"], sender=CALLER
        )
        action = engine.call_method(
            consumer_address, "get_action", ["charge-1"], sender=CALLER
        )
        assert action["status"] == "executed"

        engine.vm.clear_mocks()
        mock_review(
            engine,
            "Payments API v2. OAuth is optional. Charges can reach 500 USD. Data is retained.",
            decision="breaking",
        )
        engine.call_method(
            permit_address, "assess_dependency", ["payments-api"], sender=CALLER
        )
        dependency = engine.call_method(
            permit_address, "get_dependency", ["payments-api"], sender=CALLER
        )
        assert dependency["status"] == "suspended"

        with pytest.raises(Exception, match="No valid dependency permit"):
            engine.call_method(
                consumer_address,
                "start_action",
                ["charge-2", "payments-api", 1, "Charge 50 USD."],
                sender=OWNER,
            )
    finally:
        engine.deactivate()
