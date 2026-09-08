"""PostgreSQL persistence for the Cloudtype real-time collector.

`ranking_cache` deliberately keeps the existing ``result.json`` shape.  This
lets the Next.js application move to PostgreSQL without changing its dashboard
aggregation contract all at once.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta
from typing import Any

import psycopg
from psycopg.rows import dict_row


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS streamer_month_current (
    streamer_id TEXT NOT NULL,
    year SMALLINT NOT NULL,
    month SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
    crew_name TEXT NOT NULL,
    nickname TEXT,
    profile_image_url TEXT,
    note TEXT NOT NULL DEFAULT '',
    is_on_leave BOOLEAN NOT NULL DEFAULT FALSE,
    broadcast_start TIMESTAMPTZ,
    is_live BOOLEAN NOT NULL DEFAULT FALSE,
    is_password_broadcast BOOLEAN NOT NULL DEFAULT FALSE,
    total_balloons BIGINT NOT NULL DEFAULT 0,
    daily_balloons JSONB NOT NULL DEFAULT '[]'::jsonb,
    fans JSONB NOT NULL DEFAULT '[]'::jsonb,
    data_source TEXT,
    source_observed_at TIMESTAMPTZ NOT NULL,
    last_collected_at TIMESTAMPTZ NOT NULL,
    last_changed_at TIMESTAMPTZ NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (streamer_id, year, month)
);

CREATE INDEX IF NOT EXISTS streamer_month_current_period_idx
    ON streamer_month_current (year, month, crew_name);

CREATE TABLE IF NOT EXISTS streamer_month_history (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    streamer_id TEXT NOT NULL,
    year SMALLINT NOT NULL,
    month SMALLINT NOT NULL,
    previous_balloons BIGINT,
    current_balloons BIGINT,
    delta BIGINT,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'increase', 'regression', 'source_error', 'recovery', 'bootstrap'
    )),
    source_observed_at TIMESTAMPTZ NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    raw_summary_json JSONB
);

CREATE INDEX IF NOT EXISTS streamer_month_history_detected_idx
    ON streamer_month_history (detected_at DESC);

CREATE TABLE IF NOT EXISTS ranking_cache (
    cache_key TEXT PRIMARY KEY,
    payload_json JSONB NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL,
    source_max_observed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS collector_commands (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    command_type TEXT NOT NULL CHECK (command_type = 'refresh'),
    requested_by TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS collector_commands_pending_idx
    ON collector_commands (status, requested_at);

CREATE TABLE IF NOT EXISTS collector_status (
    status_key TEXT PRIMARY KEY,
    last_cycle_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


def database_url() -> str:
    value = os.environ.get("DATABASE_URL")
    if not value:
        raise RuntimeError("DATABASE_URL 환경변수가 필요합니다.")
    return value


def connect():
    """Open an autocommit connection suitable for a short worker transaction."""

    return psycopg.connect(database_url(), autocommit=True, row_factory=dict_row)


def ensure_schema() -> None:
    with connect() as conn:
        conn.execute(SCHEMA_SQL)


def _as_json(value: Any) -> str:
    return json.dumps(value if value is not None else [], ensure_ascii=False)


def _as_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            pass
    return None


def _upsert_month(conn, item: dict[str, Any], month_data: dict[str, Any], observed_at: datetime) -> None:
    streamer_id = str(item.get("user_id") or "")
    year = int(month_data.get("year") or 0)
    month = int(month_data.get("month") or 0)
    if not streamer_id or not year or not month:
        return

    total = int(month_data.get("total_balloons") or 0)
    previous = conn.execute(
        """
        SELECT total_balloons, daily_balloons, fans, data_source
        FROM streamer_month_current
        WHERE streamer_id = %s AND year = %s AND month = %s
        """,
        (streamer_id, year, month),
    ).fetchone()
    previous_total = int(previous["total_balloons"]) if previous else None

    # A lower value is recorded for diagnosis, but does not replace a known
    # higher total.  The source sometimes publishes delayed/regressed totals.
    should_keep_previous_total = previous_total is not None and total < previous_total
    effective_total = previous_total if should_keep_previous_total else total
    changed = previous_total is None or effective_total != previous_total

    # The ranking cache must observe the same regression protection as the
    # normalized row; otherwise the UI could briefly show a lower total.
    if should_keep_previous_total and previous is not None:
        month_data["total_balloons"] = effective_total
        month_data["daily_balloons"] = previous["daily_balloons"]
        month_data["fans"] = previous["fans"]
        month_data["data_source"] = previous["data_source"]

    if previous_total is None:
        event_type = "bootstrap"
    elif total < previous_total:
        event_type = "regression"
    elif total > previous_total:
        event_type = "increase"
    else:
        event_type = None

    if event_type:
        conn.execute(
            """
            INSERT INTO streamer_month_history (
              streamer_id, year, month, previous_balloons, current_balloons,
              delta, event_type, source_observed_at, raw_summary_json
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
            """,
            (
                streamer_id, year, month, previous_total, total,
                None if previous_total is None else total - previous_total,
                event_type, observed_at,
                _as_json({"source": month_data.get("data_source"), "item": item}),
            ),
        )

    last_changed_at = observed_at if changed else None
    conn.execute(
        """
        INSERT INTO streamer_month_current (
          streamer_id, year, month, crew_name, nickname, profile_image_url,
          note, is_on_leave, broadcast_start, is_live, is_password_broadcast,
          total_balloons, daily_balloons, fans, data_source,
          source_observed_at, last_collected_at, last_changed_at,
          consecutive_failures
        ) VALUES (
          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
          %s::jsonb, %s::jsonb, %s, %s, %s, %s, 0
        )
        ON CONFLICT (streamer_id, year, month) DO UPDATE SET
          crew_name = EXCLUDED.crew_name,
          nickname = COALESCE(EXCLUDED.nickname, streamer_month_current.nickname),
          profile_image_url = COALESCE(EXCLUDED.profile_image_url, streamer_month_current.profile_image_url),
          note = EXCLUDED.note,
          is_on_leave = EXCLUDED.is_on_leave,
          broadcast_start = EXCLUDED.broadcast_start,
          is_live = EXCLUDED.is_live,
          is_password_broadcast = EXCLUDED.is_password_broadcast,
          total_balloons = GREATEST(streamer_month_current.total_balloons, EXCLUDED.total_balloons),
          daily_balloons = CASE WHEN EXCLUDED.total_balloons >= streamer_month_current.total_balloons
            THEN EXCLUDED.daily_balloons ELSE streamer_month_current.daily_balloons END,
          fans = CASE WHEN EXCLUDED.total_balloons >= streamer_month_current.total_balloons
            THEN EXCLUDED.fans ELSE streamer_month_current.fans END,
          data_source = EXCLUDED.data_source,
          source_observed_at = EXCLUDED.source_observed_at,
          last_collected_at = EXCLUDED.last_collected_at,
          last_changed_at = CASE WHEN %s THEN EXCLUDED.last_changed_at
            ELSE streamer_month_current.last_changed_at END,
          consecutive_failures = 0
        """,
        (
            streamer_id, year, month, item.get("crew_name") or "",
            item.get("nickname"), item.get("profile_image_url"), item.get("note") or "",
            bool(item.get("is_on_leave")),
            _as_datetime(item.get("broadcast_start")),
            bool(item.get("is_live")), bool(item.get("is_password_broadcast")),
            effective_total, _as_json(month_data.get("daily_balloons")),
            _as_json(month_data.get("fans")), month_data.get("data_source"),
            observed_at, observed_at, last_changed_at or observed_at, changed,
        ),
    )


def save_result(result: dict[str, Any], observed_at: datetime) -> None:
    """Persist a compatible result JSON and normalized month rows atomically."""

    payload = dict(result)
    payload["source_max_observed_at"] = observed_at.isoformat()

    with connect() as conn:
        with conn.transaction():
            for item in payload.get("items") or []:
                _upsert_month(conn, item, item.get("current_month") or {}, observed_at)
                _upsert_month(conn, item, item.get("previous_month") or {}, observed_at)

            conn.execute(
                """
                INSERT INTO ranking_cache (cache_key, payload_json, generated_at, source_max_observed_at)
                VALUES ('current', %s::jsonb, %s, %s)
                ON CONFLICT (cache_key) DO UPDATE SET
                  payload_json = EXCLUDED.payload_json,
                  generated_at = EXCLUDED.generated_at,
                  source_max_observed_at = EXCLUDED.source_max_observed_at
                """,
                (_as_json(payload), observed_at, observed_at),
            )


def get_cached_result() -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT payload_json FROM ranking_cache WHERE cache_key = 'current'"
        ).fetchone()
    return row["payload_json"] if row else None


def claim_refresh_requests() -> list[int]:
    """Mark queued manual refreshes as processing and return their ids."""

    with connect() as conn:
        with conn.transaction():
            rows = conn.execute(
                """
                SELECT id FROM collector_commands
                WHERE status = 'queued' AND command_type = 'refresh'
                ORDER BY requested_at
                FOR UPDATE SKIP LOCKED
                """
            ).fetchall()
            ids = [int(row["id"]) for row in rows]
            if ids:
                conn.execute(
                    """
                    UPDATE collector_commands
                    SET status = 'processing', started_at = NOW(), error_message = NULL
                    WHERE id = ANY(%s)
                    """,
                    (ids,),
                )
    return ids


def complete_refresh_requests(ids: list[int], error: str | None = None) -> None:
    if not ids:
        return
    status = "failed" if error else "completed"
    with connect() as conn:
        conn.execute(
            """
            UPDATE collector_commands
            SET status = %s, completed_at = NOW(), error_message = %s
            WHERE id = ANY(%s)
            """,
            (status, error, ids),
        )


def update_collector_status(now: datetime, error: str | None = None) -> None:
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO collector_status (
              status_key, last_cycle_at, last_success_at, last_error, updated_at
            ) VALUES ('current', %s, %s, %s, %s)
            ON CONFLICT (status_key) DO UPDATE SET
              last_cycle_at = EXCLUDED.last_cycle_at,
              last_success_at = CASE WHEN EXCLUDED.last_error IS NULL
                THEN EXCLUDED.last_success_at ELSE collector_status.last_success_at END,
              last_error = EXCLUDED.last_error,
              updated_at = EXCLUDED.updated_at
            """,
            (now, now if error is None else None, error, now),
        )


def cleanup_expired_data(now: datetime) -> None:
    """Keep the two prior calendar months and 90 days of observations."""

    current_month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    keep_from = (current_month_start - timedelta(days=62)).date()
    history_from = now - timedelta(days=90)
    with connect() as conn:
        conn.execute(
            "DELETE FROM streamer_month_current WHERE make_date(year, month, 1) < %s",
            (keep_from,),
        )
        conn.execute(
            "DELETE FROM streamer_month_history WHERE detected_at < %s",
            (history_from,),
        )
