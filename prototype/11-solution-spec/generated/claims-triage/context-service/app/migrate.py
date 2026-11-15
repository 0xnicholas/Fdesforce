# PROTOTYPE — generated skeleton.
# Source: solution.lock#/runtime + migrations/*.sql
import sqlite3
from pathlib import Path

from . import settings

MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"


def run() -> None:
    settings.AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(settings.AUDIT_PATH)
    for sql in sorted(MIGRATIONS.glob("*.sql")):
        print(f"applying {sql.name}")
        connection.executescript(sql.read_text())
    connection.commit()
    print("migrations applied")


if __name__ == "__main__":
    run()
