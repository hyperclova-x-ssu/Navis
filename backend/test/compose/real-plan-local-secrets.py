"""Check credential generation on a fresh, disposable Compose directory."""

from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory

source = Path(__file__).resolve().parents[2] / "infra/local-secrets.sh"
with TemporaryDirectory(prefix="navis-r1-compose-secrets-") as directory:
    root = Path(directory)
    script = root / "infra/local-secrets.sh"
    script.parent.mkdir()
    shutil.copy(source, script)
    subprocess.run(["sh", str(script)], check=True)
    names = [
        "local/pos_inventory_token",
        "local/inventory_account_token",
        "local/pos_customer_token",
        "local/db/inventory_wrk_password",
        "test/db/inventory_wrk_password",
        "local/db/pos_wrk_password",
        "test/db/pos_wrk_password",
    ]
    paths = [root / ".secrets" / name for name in names]
    missing = [name for name, path in zip(names, paths) if not path.is_file()]
    assert not missing, f"Missing generated Compose credential files: {missing}"
    acl = (root / ".secrets/local/redis_acl").read_text().splitlines()
    customer = next(line.split() for line in acl if line.startswith("user customer "))
    assert {"~navis.pos.0", "~navis.pos.0.epoch", "~navis.inventory.0", "~navis.inventory.0.epoch"}.issubset(customer), (
        "Customer must read POS and Inventory streams"
    )
    assert "~navis.marketing.0" not in customer, "Customer should only read active producers"
    previous = [path.stat() for path in paths]
    subprocess.run(["sh", str(script)], check=True)
    assert [path.stat() for path in paths] == previous, "Generation replaced existing workload credential files"
print("Local and test credential names are provisioned idempotently")
