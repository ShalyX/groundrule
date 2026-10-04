# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from dataclasses import dataclass
from datetime import datetime, timezone

from genlayer import *


ERROR_EXPECTED = "[EXPECTED]"
MAX_ID_LENGTH = 100
MAX_PAYLOAD_LENGTH = 1_000


@allow_storage
@dataclass
class ActionRecord:
    action_id: str
    dependency_id: str
    permit_nonce: u256
    dependency_version: u256
    source_snapshot: str
    payload: str
    status: str
    started_at: u256
    finalized_at: u256


class GuardedConsumer(gl.Contract):
    """Example action sink that requires a finalized DriftPermit lease."""

    drift_permit: str
    operator: str
    actions: TreeMap[str, ActionRecord]
    permit_claims: TreeMap[str, str]

    def __init__(self, drift_permit: Address, operator: Address):
        self.drift_permit = self._address_text(drift_permit)
        self.operator = self._address_text(operator)

    def _now(self) -> int:
        return int(datetime.now(timezone.utc).timestamp())

    def _address_text(self, value) -> str:
        if isinstance(value, bytes):
            return "0x" + value.hex()
        if isinstance(value, int):
            return "0x" + format(value, "040x")
        try:
            return value.as_hex.lower()
        except AttributeError:
            return str(value).strip().lower()

    def _require_text(self, value: str, field_name: str, max_length: int) -> str:
        if not isinstance(value, str) or not value.strip():
            raise gl.vm.UserError(f"{ERROR_EXPECTED} {field_name} is required")
        if len(value) > max_length:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} {field_name} exceeds {max_length} characters"
            )
        return value.strip()

    def _permit(self):
        return gl.get_contract_at(Address(self.drift_permit))

    def _get_action(self, action_id: str) -> ActionRecord:
        if action_id not in self.actions:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Action does not exist")
        return self.actions[action_id]

    def _claim_key(self, dependency_id: str, permit_nonce: u256) -> str:
        return f"{dependency_id}:{int(permit_nonce)}"

    @gl.public.write
    def start_action(
        self,
        action_id: str,
        dependency_id: str,
        permit_nonce: u256,
        payload: str,
    ) -> None:
        action_id = self._require_text(action_id, "action_id", MAX_ID_LENGTH)
        dependency_id = self._require_text(
            dependency_id, "dependency_id", MAX_ID_LENGTH
        )
        payload = self._require_text(payload, "payload", MAX_PAYLOAD_LENGTH)
        if self._address_text(gl.message.sender_address) != self.operator:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Only the configured operator may start an action")
        if action_id in self.actions:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Action ID already exists")

        permit_contract = self._permit()
        if not permit_contract.view().is_permit_valid(dependency_id, permit_nonce):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} No valid dependency permit")
        dependency = permit_contract.view().get_dependency(dependency_id)
        contract_address = self._address_text(gl.message.contract_address)
        if (
            not dependency["active"]
            or dependency["status"] != "compatible"
            or self._address_text(dependency["executor"]) != contract_address
        ):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} No valid dependency permit")
        permit = permit_contract.view().get_permit(dependency_id)
        if (
            int(permit["nonce"]) != int(permit_nonce)
            or int(permit["dependency_version"]) != int(dependency["version"])
            or not permit["active"]
            or permit["consumed"]
        ):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} No valid dependency permit")

        claim_key = self._claim_key(dependency_id, permit_nonce)
        if claim_key in self.permit_claims:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Permit is already claimed")
        self.permit_claims[claim_key] = action_id
        self.actions[action_id] = ActionRecord(
            action_id=action_id,
            dependency_id=dependency_id,
            permit_nonce=permit_nonce,
            dependency_version=permit["dependency_version"],
            source_snapshot=permit["source_snapshot"],
            payload=payload,
            status="awaiting_permit",
            started_at=self._now(),
            finalized_at=0,
        )
        permit_contract.emit(on="finalized").consume_permit(dependency_id, permit_nonce)

    @gl.public.write
    def finalize_action(self, action_id: str) -> None:
        action = self._get_action(self._require_text(action_id, "action_id", MAX_ID_LENGTH))
        if action.status != "awaiting_permit":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Action is not awaiting a permit")
        permit = self._permit().view().get_permit(action.dependency_id)
        if (
            int(permit["nonce"]) != int(action.permit_nonce)
            or int(permit["dependency_version"]) != int(action.dependency_version)
            or permit["source_snapshot"] != action.source_snapshot
            or not permit["consumed"]
            or permit["active"]
        ):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Permit has not been consumed")
        action.status = "executed"
        action.finalized_at = self._now()

    @gl.public.view
    def get_action(self, action_id: str) -> dict:
        action = self._get_action(self._require_text(action_id, "action_id", MAX_ID_LENGTH))
        return {
            "action_id": action.action_id,
            "dependency_id": action.dependency_id,
            "permit_nonce": action.permit_nonce,
            "dependency_version": action.dependency_version,
            "source_snapshot": action.source_snapshot,
            "payload": action.payload,
            "status": action.status,
            "started_at": action.started_at,
            "finalized_at": action.finalized_at,
        }
