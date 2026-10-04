import sys

import pytest


CONTRACT = "contracts/guarded_consumer.py"
DRIFT_PERMIT = "0x3333333333333333333333333333333333333333"


def deploy(direct_deploy, direct_vm, operator):
    direct_vm.sender = bytes.fromhex("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    return direct_deploy(CONTRACT, DRIFT_PERMIT, operator, sdk_version="v0.2.16")


class FakePermit:
    def __init__(self):
        self.valid = True
        self.permit = {
            "dependency_id": "payments-api",
            "nonce": 7,
            "expiry": 4102444800,
            "dependency_version": 1,
            "source_snapshot": "authenticated_baseline|...\nlive_dependency|...",
            "consumed": False,
            "active": True,
        }
        self.dependency = {
            "dependency_id": "payments-api",
            "executor": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "version": 1,
            "active": True,
            "status": "compatible",
        }
        self.queued = []

    def view(self):
        return self

    def is_permit_valid(self, dependency_id, nonce):
        return (
            self.valid
            and dependency_id == self.permit["dependency_id"]
            and nonce == self.permit["nonce"]
            and self.permit["active"]
            and not self.permit["consumed"]
        )

    def get_dependency(self, dependency_id):
        return self.dependency

    def get_permit(self, dependency_id):
        return self.permit

    def emit(self, on):
        assert on == "finalized"
        return self

    def consume_permit(self, dependency_id, nonce):
        self.queued.append((dependency_id, nonce))


def install_fake(consumer, fake):
    module = sys.modules[consumer._instance.__class__.__module__]
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(module.gl, "get_contract_at", lambda address: fake)
    return monkeypatch


def test_operator_action_executes_only_after_finalized_permit_consumption(
    direct_deploy, direct_vm, direct_alice
):
    consumer = deploy(direct_deploy, direct_vm, direct_alice)
    fake = FakePermit()
    fake.dependency["executor"] = "0x" + direct_vm._contract_address.hex()
    monkeypatch = install_fake(consumer, fake)
    try:
        direct_vm.sender = direct_alice
        consumer.start_action("charge-1", "payments-api", 7, "Charge 25 USD for printer paper.")
        assert fake.queued == [("payments-api", 7)]
        assert consumer.get_action("charge-1")["status"] == "awaiting_permit"

        with direct_vm.expect_revert("Permit has not been consumed"):
            consumer.finalize_action("charge-1")

        fake.permit["consumed"] = True
        fake.permit["active"] = False
        consumer.finalize_action("charge-1")
        action = consumer.get_action("charge-1")
        assert action["status"] == "executed"
        assert action["dependency_id"] == "payments-api"
        assert action["permit_nonce"] == 7
    finally:
        monkeypatch.undo()


def test_non_operator_or_suspended_dependency_cannot_start_action(
    direct_deploy, direct_vm, direct_alice, direct_bob
):
    consumer = deploy(direct_deploy, direct_vm, direct_alice)
    fake = FakePermit()
    fake.dependency["executor"] = "0x" + direct_vm._contract_address.hex()
    monkeypatch = install_fake(consumer, fake)
    try:
        direct_vm.sender = direct_bob
        with direct_vm.expect_revert("Only the configured operator"):
            consumer.start_action("charge-2", "payments-api", 7, "Unauthorized charge.")

        direct_vm.sender = direct_alice
        fake.valid = False
        fake.dependency["status"] = "suspended"
        with direct_vm.expect_revert("No valid dependency permit"):
            consumer.start_action("charge-3", "payments-api", 7, "Blocked charge.")
    finally:
        monkeypatch.undo()


def test_one_permit_cannot_be_claimed_by_two_actions(
    direct_deploy, direct_vm, direct_alice
):
    consumer = deploy(direct_deploy, direct_vm, direct_alice)
    fake = FakePermit()
    fake.dependency["executor"] = "0x" + direct_vm._contract_address.hex()
    monkeypatch = install_fake(consumer, fake)
    try:
        direct_vm.sender = direct_alice
        consumer.start_action("charge-4", "payments-api", 7, "First action.")
        with direct_vm.expect_revert("Permit is already claimed"):
            consumer.start_action("charge-5", "payments-api", 7, "Second action.")
    finally:
        monkeypatch.undo()
