"""Create/update the PostgreSQL schema used by the real-time collector."""

from realtime_db import ensure_schema


if __name__ == "__main__":
    ensure_schema()
    print("PostgreSQL real-time schema is ready.")
