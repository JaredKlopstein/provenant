"""
Provenant reference client -- Python. ~40 lines of actual logic.

Wraps the CLI rather than reimplementing the protocol, deliberately: the CLI is
the reference surface, it already emits structured JSON and structured errors,
and shelling out means this client can never drift from the format.

Run:  python3 examples/reference_client.py
"""
import json
import subprocess
from pathlib import Path

BIN = str(Path(__file__).resolve().parent.parent / "packages/core/bin/provenant.mjs")


class ProvenantError(Exception):
    def __init__(self, payload):
        super().__init__(payload.get("message", "unknown error"))
        self.code = payload.get("code")
        self.retryable = payload.get("retryable", False)
        # Every Provenant error carries a `fix` telling you exactly what to do next.
        self.fix = payload.get("fix")


def call(command, args=None):
    argv = ["node", BIN, *command.split(), "--json"]
    for key, value in (args or {}).items():
        if value is None or value is False:
            continue
        argv.append("--" + key.replace("_", "-"))
        if value is not True:
            argv.append(json.dumps(value) if isinstance(value, (dict, list)) else str(value))

    proc = subprocess.run(argv, capture_output=True, text=True)
    if proc.returncode != 0:
        payload = json.loads(proc.stderr or proc.stdout or "{}").get("error", {})
        raise ProvenantError(payload)
    return json.loads(proc.stdout)["result"]


def init(display_name):
    return call("init", {"display_name": display_name})


def record(action, detail, **opts):
    return call("record", {"action": action, "action_detail": detail, **opts})


def verify():
    return call("chain verify")


if __name__ == "__main__":
    me = init("reference-client-py")
    print("agent:", me["agent_id"])

    receipt = record(
        "refund.issue",
        {"customer_id": "c_8812", "amount_usd": 42.5},
        side_effect_class="irreversible",
        idempotency_key="refund-c_8812-0002",
    )
    print("receipt seq:", receipt["seq"], "hash:", receipt["self_hash"][:16])
    print("chain ok:", verify()["ok"])
