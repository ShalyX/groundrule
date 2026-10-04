import hashlib
import json


CONTRACT = "contracts/drift_permit.py"
BASELINE_URL = "https://raw.githubusercontent.com/acme/payments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/terms.md"
LIVE_URL = "https://raw.githubusercontent.com/acme/payments/main/terms.md"
BASELINE_BODY = "Payments API v1. OAuth is required. Maximum charge is 100 USD. Customer data is not retained."
BASELINE_HASH = hashlib.sha256(BASELINE_BODY.encode("utf-8")).hexdigest()
EXECUTOR = "0x2222222222222222222222222222222222222222"
INVARIANTS = [
    {"id": "auth", "rule": "OAuth remains mandatory for every payment request."},
    {"id": "charge_limit", "rule": "A single charge cannot exceed 100 USD."},
    {"id": "data_retention", "rule": "Customer data is not retained by the provider."},
]


def deploy(direct_deploy):
    return direct_deploy(CONTRACT, sdk_version="v0.2.16")


def register(contract, direct_vm, direct_alice):
    direct_vm.sender = direct_alice
    contract.register_dependency(
        "payments-api",
        "Acme Payments API",
        "An external payment API used by an autonomous purchasing agent.",
        BASELINE_URL,
        BASELINE_HASH,
        LIVE_URL,
        json.dumps(INVARIANTS),
        EXECUTOR,
        3600,
    )


def mock_sources(direct_vm, live_body, baseline_status=200, live_status=200):
    direct_vm.mock_web(BASELINE_URL, {"status": baseline_status, "body": BASELINE_BODY})
    direct_vm.mock_web(LIVE_URL, {"status": live_status, "body": live_body})


def assessment(states, decision="compatible", confidence="high", change_types=None):
    return json.dumps(
        {
            "decision": decision,
            "invariants": [
                {"id": invariant["id"], "state": states.get(invariant["id"], "preserved")}
                for invariant in INVARIANTS
            ],
            "change_types": change_types or [],
            "confidence_band": confidence,
            "rationale": "The live dependency was compared with the authenticated baseline.",
        }
    )


def test_compatible_live_dependency_issues_one_use_executor_permit(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = deploy(direct_deploy)
    register(contract, direct_vm, direct_alice)
    mock_sources(direct_vm, BASELINE_BODY + " Documentation wording was clarified.")
    direct_vm.mock_llm(r"(?s).*DRIFT_PERMIT_ASSESSMENT.*", assessment({}))

    direct_vm.sender = direct_bob
    contract.assess_dependency("payments-api")

    dependency = contract.get_dependency("payments-api")
    permit = contract.get_permit("payments-api")
    assert dependency["status"] == "compatible"
    assert dependency["decision"] == "compatible"
    assert permit["nonce"] == 1
    assert permit["active"] is True
    assert permit["consumed"] is False
    assert permit["dependency_version"] == 1

    direct_vm.sender = bytes.fromhex(EXECUTOR[2:])
    contract.consume_permit("payments-api", 1)
    assert contract.get_permit("payments-api")["consumed"] is True

    with direct_vm.expect_revert("Permit is not active"):
        contract.consume_permit("payments-api", 1)


def test_material_drift_suspends_dependency_and_invalidates_previous_permit(
    direct_vm, direct_deploy, direct_alice
):
    contract = deploy(direct_deploy)
    register(contract, direct_vm, direct_alice)

    mock_sources(direct_vm, BASELINE_BODY + " Documentation wording was clarified.")
    direct_vm.mock_llm(r"(?s).*DRIFT_PERMIT_ASSESSMENT.*", assessment({}))
    contract.assess_dependency("payments-api")
    assert contract.is_permit_valid("payments-api", 1) is True

    direct_vm.clear_mocks()
    mock_sources(
        direct_vm,
        "Payments API v2. API keys are optional. Charges up to 500 USD are supported. Customer data is retained for training.",
    )
    direct_vm.mock_llm(
        r"(?s).*DRIFT_PERMIT_ASSESSMENT.*",
        assessment(
            {"auth": "violated", "charge_limit": "violated", "data_retention": "violated"},
            decision="breaking",
            change_types=["AUTHORIZATION", "FINANCIAL_LIMIT", "DATA_HANDLING"],
        ),
    )
    contract.assess_dependency("payments-api")

    dependency = contract.get_dependency("payments-api")
    assert dependency["status"] == "suspended"
    assert dependency["decision"] == "breaking"
    assert contract.is_permit_valid("payments-api", 1) is False


def test_unavailable_live_source_fails_closed_and_revokes_active_permit(
    direct_vm, direct_deploy, direct_alice
):
    contract = deploy(direct_deploy)
    register(contract, direct_vm, direct_alice)

    mock_sources(direct_vm, BASELINE_BODY)
    direct_vm.mock_llm(r"(?s).*DRIFT_PERMIT_ASSESSMENT.*", assessment({}))
    contract.assess_dependency("payments-api")
    assert contract.is_permit_valid("payments-api", 1) is True

    direct_vm.clear_mocks()
    mock_sources(direct_vm, "temporarily unavailable", live_status=503)
    contract.assess_dependency("payments-api")

    dependency = contract.get_dependency("payments-api")
    assert dependency["status"] == "inconclusive"
    assert dependency["decision"] == "unclear"
    assert dependency["sources_healthy"] is False
    assert contract.is_permit_valid("payments-api", 1) is False


def test_wrong_baseline_content_fails_closed_without_model_authorization(
    direct_vm, direct_deploy, direct_alice
):
    contract = deploy(direct_deploy)
    register(contract, direct_vm, direct_alice)
    direct_vm.mock_web(BASELINE_URL, {"status": 200, "body": "tampered baseline"})
    direct_vm.mock_web(LIVE_URL, {"status": 200, "body": BASELINE_BODY})
    direct_vm.mock_llm(r"(?s).*", assessment({}))

    contract.assess_dependency("payments-api")
    dependency = contract.get_dependency("payments-api")
    assert dependency["status"] == "inconclusive"
    assert dependency["sources_healthy"] is False
    assert dependency["baseline_hash_matches"] is False
    assert contract.get_permit("payments-api")["nonce"] == 0


def test_incomplete_or_inconsistent_model_result_cannot_issue_permit(
    direct_vm, direct_deploy, direct_alice
):
    contract = deploy(direct_deploy)
    register(contract, direct_vm, direct_alice)
    mock_sources(direct_vm, BASELINE_BODY + " wording update")
    incomplete = json.dumps(
        {
            "decision": "compatible",
            "invariants": [{"id": "auth", "state": "preserved"}],
            "change_types": [],
            "confidence_band": "high",
            "rationale": "Only one invariant was checked.",
        }
    )
    direct_vm.mock_llm(r"(?s).*DRIFT_PERMIT_ASSESSMENT.*", incomplete)

    with direct_vm.expect_revert("classify every invariant exactly once"):
        contract.assess_dependency("payments-api")
    assert contract.get_permit("payments-api")["nonce"] == 0

    direct_vm.clear_mocks()
    mock_sources(direct_vm, BASELINE_BODY + " wording update")
    contradictory = assessment(
        {"charge_limit": "violated"},
        decision="compatible",
        change_types=["FINANCIAL_LIMIT"],
    )
    direct_vm.mock_llm(r"(?s).*DRIFT_PERMIT_ASSESSMENT.*", contradictory)
    with direct_vm.expect_revert("decision contradicts invariant states"):
        contract.assess_dependency("payments-api")


def test_only_owner_can_reconfigure_and_revision_invalidates_permit(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = deploy(direct_deploy)
    register(contract, direct_vm, direct_alice)
    mock_sources(direct_vm, BASELINE_BODY)
    direct_vm.mock_llm(r"(?s).*DRIFT_PERMIT_ASSESSMENT.*", assessment({}))
    contract.assess_dependency("payments-api")

    direct_vm.sender = direct_bob
    with direct_vm.expect_revert("Only the dependency owner may reconfigure it"):
        contract.reconfigure_dependency(
            "payments-api",
            "Attacker-controlled description.",
            BASELINE_URL,
            BASELINE_HASH,
            LIVE_URL,
            json.dumps(INVARIANTS),
            EXECUTOR,
            3600,
            True,
        )

    direct_vm.sender = direct_alice
    contract.reconfigure_dependency(
        "payments-api",
        "The payment provider after an operator-reviewed configuration revision.",
        BASELINE_URL,
        BASELINE_HASH,
        LIVE_URL,
        json.dumps(INVARIANTS),
        EXECUTOR,
        1800,
        True,
    )
    dependency = contract.get_dependency("payments-api")
    assert dependency["version"] == 2
    assert dependency["status"] == "unassessed"
    assert contract.is_permit_valid("payments-api", 1) is False


def test_validator_rejects_materially_different_live_evidence(
    direct_vm, direct_deploy, direct_alice
):
    contract = deploy(direct_deploy)
    register(contract, direct_vm, direct_alice)
    mock_sources(direct_vm, BASELINE_BODY + " Documentation wording was clarified.")
    direct_vm.mock_llm(r"(?s).*DRIFT_PERMIT_ASSESSMENT.*", assessment({}))
    contract.assess_dependency("payments-api")

    direct_vm.clear_mocks()
    mock_sources(
        direct_vm,
        "Payments API v2. OAuth is optional and a single charge can reach 500 USD.",
    )
    direct_vm.mock_llm(
        r"(?s).*DRIFT_PERMIT_ASSESSMENT.*",
        assessment(
            {"auth": "violated", "charge_limit": "violated"},
            decision="breaking",
            change_types=["AUTHORIZATION", "FINANCIAL_LIMIT"],
        ),
    )
    assert direct_vm.run_validator() is False


def test_non_high_confidence_or_unclear_result_never_issues_permit(
    direct_vm, direct_deploy, direct_alice
):
    contract = deploy(direct_deploy)
    register(contract, direct_vm, direct_alice)
    mock_sources(direct_vm, BASELINE_BODY + " A vaguely worded exception may apply.")
    direct_vm.mock_llm(
        r"(?s).*DRIFT_PERMIT_ASSESSMENT.*",
        assessment({}, confidence="medium"),
    )
    contract.assess_dependency("payments-api")
    assert contract.get_dependency("payments-api")["status"] == "inconclusive"
    assert contract.get_permit("payments-api")["nonce"] == 0

    direct_vm.clear_mocks()
    mock_sources(direct_vm, BASELINE_BODY + " An unspecified exception may apply.")
    direct_vm.mock_llm(
        r"(?s).*DRIFT_PERMIT_ASSESSMENT.*",
        assessment({"data_retention": "unclear"}, decision="unclear"),
    )
    contract.assess_dependency("payments-api")
    assert contract.get_dependency("payments-api")["status"] == "inconclusive"
    assert contract.get_permit("payments-api")["nonce"] == 0


def test_registration_rejects_duplicate_invariants_and_unsafe_lease_bounds(
    direct_vm, direct_deploy, direct_alice
):
    contract = deploy(direct_deploy)
    direct_vm.sender = direct_alice
    duplicate_invariants = json.dumps(
        [
            {"id": "auth", "rule": "OAuth is required."},
            {"id": "auth", "rule": "API keys are forbidden."},
        ]
    )
    with direct_vm.expect_revert("duplicate invariant id"):
        contract.register_dependency(
            "duplicate",
            "Duplicate policy",
            "Invalid dependency configuration.",
            BASELINE_URL,
            BASELINE_HASH,
            LIVE_URL,
            duplicate_invariants,
            EXECUTOR,
            3600,
        )

    with direct_vm.expect_revert("between 60 and 86400"):
        contract.register_dependency(
            "short-lease",
            "Unsafe lease",
            "Invalid dependency configuration.",
            BASELINE_URL,
            BASELINE_HASH,
            LIVE_URL,
            json.dumps(INVARIANTS),
            EXECUTOR,
            59,
        )


def test_permissionless_compatible_recheck_cannot_rotate_an_active_permit(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = deploy(direct_deploy)
    register(contract, direct_vm, direct_alice)
    mock_sources(direct_vm, BASELINE_BODY + " Documentation wording was clarified.")
    direct_vm.mock_llm(r"(?s).*DRIFT_PERMIT_ASSESSMENT.*", assessment({}))
    contract.assess_dependency("payments-api")
    first_permit = contract.get_permit("payments-api")

    direct_vm.clear_mocks()
    mock_sources(direct_vm, BASELINE_BODY + " Documentation wording was clarified again.")
    direct_vm.mock_llm(r"(?s).*DRIFT_PERMIT_ASSESSMENT.*", assessment({}))
    direct_vm.sender = direct_bob
    contract.assess_dependency("payments-api")

    second_permit = contract.get_permit("payments-api")
    assert second_permit["nonce"] == first_permit["nonce"] == 1
    assert second_permit["expiry"] == first_permit["expiry"]
    assert second_permit["active"] is True


def test_registration_rejects_zero_executor_and_identical_source_urls(
    direct_vm, direct_deploy, direct_alice
):
    contract = deploy(direct_deploy)
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("executor must not be the zero address"):
        contract.register_dependency(
            "zero-executor",
            "Unsafe dependency",
            "Invalid dependency configuration.",
            BASELINE_URL,
            BASELINE_HASH,
            LIVE_URL,
            json.dumps(INVARIANTS),
            "0x0000000000000000000000000000000000000000",
            3600,
        )

    with direct_vm.expect_revert("baseline_url and live_url must differ"):
        contract.register_dependency(
            "same-source",
            "No-op comparison",
            "Invalid dependency configuration.",
            BASELINE_URL,
            BASELINE_HASH,
            BASELINE_URL,
            json.dumps(INVARIANTS),
            EXECUTOR,
            3600,
        )


def test_reconfiguration_preserves_last_permit_consumption_audit(
    direct_vm, direct_deploy, direct_alice
):
    contract = deploy(direct_deploy)
    register(contract, direct_vm, direct_alice)
    mock_sources(direct_vm, BASELINE_BODY)
    direct_vm.mock_llm(r"(?s).*DRIFT_PERMIT_ASSESSMENT.*", assessment({}))
    contract.assess_dependency("payments-api")

    direct_vm.sender = bytes.fromhex(EXECUTOR[2:])
    contract.consume_permit("payments-api", 1)
    assert contract.get_permit("payments-api")["consumed"] is True

    direct_vm.sender = direct_alice
    contract.reconfigure_dependency(
        "payments-api",
        "Operator-reviewed dependency revision.",
        BASELINE_URL,
        BASELINE_HASH,
        LIVE_URL,
        json.dumps(INVARIANTS),
        EXECUTOR,
        1800,
        True,
    )
    permit = contract.get_permit("payments-api")
    assert permit["consumed"] is True
    assert permit["active"] is False
