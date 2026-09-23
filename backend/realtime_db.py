"""PostgreSQL persistence for the Cloudtype real-time collector.

`ranking_cache` deliberately keeps the existing ``result.json`` shape.  This
lets the Next.js application move to PostgreSQL without changing its dashboard
aggregation contract all at once.
"""

from __future__ import annotations

import json
import os
import hashlib
from datetime import datetime, timedelta
from typing import Any

import psycopg
from psycopg.rows import dict_row
from dashboard_cache import build_dashboard


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
    last_detail_collected_at TIMESTAMPTZ,
    last_live_end_at TIMESTAMPTZ,
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
    source_max_observed_at TIMESTAMPTZ NOT NULL,
    content_hash TEXT
);

ALTER TABLE ranking_cache ADD COLUMN IF NOT EXISTS content_hash TEXT;

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

ALTER TABLE collector_status ADD COLUMN IF NOT EXISTS last_recovery_at TIMESTAMPTZ;
ALTER TABLE collector_status ADD COLUMN IF NOT EXISTS source_request_count BIGINT NOT NULL DEFAULT 0;
ALTER TABLE collector_status ADD COLUMN IF NOT EXISTS source_failure_count BIGINT NOT NULL DEFAULT 0;
ALTER TABLE collector_status ADD COLUMN IF NOT EXISTS last_source_success_at TIMESTAMPTZ;
ALTER TABLE streamer_month_current ADD COLUMN IF NOT EXISTS last_detail_collected_at TIMESTAMPTZ;
ALTER TABLE streamer_month_current ADD COLUMN IF NOT EXISTS last_live_end_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS collector_lease (
    lease_key TEXT PRIMARY KEY,
    holder TEXT NOT NULL,
    lease_until TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS live_donation_events (
    donation_id TEXT PRIMARY KEY,
    streamer_id TEXT NOT NULL,
    broadcast_no TEXT,
    amount BIGINT NOT NULL CHECK (amount > 0),
    occurred_at TIMESTAMPTZ NOT NULL,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS live_donation_events_streamer_idx
    ON live_donation_events (streamer_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS streamer_live_totals (
    streamer_id TEXT PRIMARY KEY,
    crew_name TEXT NOT NULL DEFAULT '',
    nickname TEXT NOT NULL DEFAULT '',
    broadcast_no TEXT,
    reporting_date DATE NOT NULL,
    display_date DATE,
    year SMALLINT NOT NULL,
    month SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
    today_balloons BIGINT NOT NULL DEFAULT 0,
    month_balloons BIGINT NOT NULL DEFAULT 0,
    daily_fans JSONB NOT NULL DEFAULT '[]'::jsonb,
    source TEXT NOT NULL,
    counting_mode TEXT NOT NULL DEFAULT 'legacy',
    session_offset BIGINT NOT NULL DEFAULT 0,
    finalized BOOLEAN NOT NULL DEFAULT FALSE,
    connected BOOLEAN NOT NULL DEFAULT FALSE,
    observed_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE streamer_live_totals ADD COLUMN IF NOT EXISTS daily_fans JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE streamer_live_totals ADD COLUMN IF NOT EXISTS counting_mode TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE streamer_live_totals ADD COLUMN IF NOT EXISTS session_offset BIGINT NOT NULL DEFAULT 0;
ALTER TABLE streamer_live_totals ADD COLUMN IF NOT EXISTS display_date DATE;
ALTER TABLE streamer_live_totals ADD COLUMN IF NOT EXISTS finalized BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS streamer_live_sessions (
    streamer_id TEXT NOT NULL,
    broadcast_no TEXT NOT NULL,
    crew_name TEXT NOT NULL DEFAULT '',
    nickname TEXT NOT NULL DEFAULT '',
    reporting_date DATE NOT NULL,
    display_date DATE NOT NULL,
    year SMALLINT NOT NULL,
    month SMALLINT NOT NULL CHECK (month BETWEEN 1 AND 12),
    today_balloons BIGINT NOT NULL DEFAULT 0,
    month_balloons BIGINT NOT NULL DEFAULT 0,
    daily_fans JSONB NOT NULL DEFAULT '[]'::jsonb,
    source TEXT NOT NULL,
    finalized BOOLEAN NOT NULL DEFAULT FALSE,
    observed_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (streamer_id, broadcast_no)
);

CREATE INDEX IF NOT EXISTS streamer_live_sessions_date_idx
    ON streamer_live_sessions (reporting_date DESC, streamer_id);

INSERT INTO streamer_live_sessions (
  streamer_id, broadcast_no, crew_name, nickname, reporting_date, display_date,
  year, month, today_balloons, month_balloons, daily_fans, source, finalized, observed_at
)
SELECT streamer_id, broadcast_no, crew_name, nickname, reporting_date,
       COALESCE(display_date, reporting_date), year, month, today_balloons,
       month_balloons, daily_fans, source, finalized, observed_at
FROM streamer_live_totals
WHERE COALESCE(broadcast_no, '') <> ''
ON CONFLICT (streamer_id, broadcast_no) DO NOTHING;
"""


def connect():
    """Open an autocommit connection suitable for a short worker transaction."""

    value = os.environ.get("DATABASE_URL")
    if value:
        return psycopg.connect(value, autocommit=True, row_factory=dict_row)

    password = os.environ.get("PGPASSWORD")
    if password:
        return psycopg.connect(
            host=os.environ.get("PGHOST", "postgresql"),
            port=int(os.environ.get("PGPORT", "5432")),
            user=os.environ.get("PGUSER", "root"),
            password=password,
            dbname=os.environ.get("PGDATABASE", "postgres"),
            autocommit=True,
            row_factory=dict_row,
        )

    raise RuntimeError("PGPASSWORD 또는 DATABASE_URL 환경변수가 필요합니다.")


def ensure_schema() -> None:
    with connect() as conn:
        conn.execute(SCHEMA_SQL)


def _as_json(value: Any) -> str:
    return json.dumps(value if value is not None else [], ensure_ascii=False)


def _content_hash(value: Any) -> str:
    """Hash the meaningful cache body, excluding collection timestamps."""

    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _save_cache(conn, cache_key: str, payload: dict[str, Any], observed_at: datetime) -> None:
    # `source_max_observed_at` is intentionally not part of the version. A
    # successful poll with identical data must not invalidate Next.js memory.
    body = dict(payload)
    body.pop("source_max_observed_at", None)
    conn.execute(
        """
        INSERT INTO ranking_cache (cache_key, payload_json, generated_at, source_max_observed_at, content_hash)
        VALUES (%s, %s::jsonb, %s, %s, %s)
        ON CONFLICT (cache_key) DO UPDATE SET
          payload_json = EXCLUDED.payload_json,
          generated_at = EXCLUDED.generated_at,
          source_max_observed_at = EXCLUDED.source_max_observed_at,
          content_hash = EXCLUDED.content_hash
        WHERE ranking_cache.content_hash IS DISTINCT FROM EXCLUDED.content_hash
        """,
        (cache_key, _as_json(payload), observed_at, observed_at, _content_hash(body)),
    )


def _as_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            pass
    return None


def _previous_period(year: int, month: int) -> dict[str, int]:
    if month == 1:
        return {"year": year - 1, "month": 12}
    return {"year": year, "month": month - 1}


def _is_authoritative_live_source(source: Any) -> bool:
    """Return whether a source contains the broadcast-session truth."""

    value = str(source or "").lower()
    return value.startswith(("poonggo_sse", "poonggo_live"))


def _should_keep_live_snapshot(
    previous_total: int | None,
    incoming_total: int,
    previous_source: Any,
    incoming_source: Any,
) -> bool:
    return bool(
        previous_total is not None
        and incoming_total <= previous_total
        and _is_authoritative_live_source(previous_source)
        and not _is_authoritative_live_source(incoming_source)
    )


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

    # A slower detail refresh can finish after an SSE/live-final flush.  When
    # both snapshots have the same month total, replacing the whole daily
    # array lets the detail source copy today's live count into yesterday.
    # Keep the broadcast-session snapshot until a newer live source changes it.
    should_keep_live_snapshot = previous is not None and _should_keep_live_snapshot(
        previous_total,
        total,
        previous["data_source"],
        month_data.get("data_source"),
    )

    # The ranking cache must observe the same protection as the normalized
    # row; otherwise the UI could still publish the stale detail snapshot.
    if (should_keep_previous_total or should_keep_live_snapshot) and previous is not None:
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
          last_detail_collected_at, last_live_end_at,
          consecutive_failures
        ) VALUES (
          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
          %s::jsonb, %s::jsonb, %s, %s, %s, %s, %s, %s, 0
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
          last_detail_collected_at = COALESCE(EXCLUDED.last_detail_collected_at, streamer_month_current.last_detail_collected_at),
          last_live_end_at = COALESCE(EXCLUDED.last_live_end_at, streamer_month_current.last_live_end_at),
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
            observed_at, observed_at, last_changed_at or observed_at,
            _as_datetime(item.get("last_detail_collected_at")),
            _as_datetime(item.get("last_live_end_at")),
            changed,
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
                _upsert_month(conn, item, item.get("older_month") or {}, observed_at)

            _save_cache(conn, "current", payload, observed_at)
            _save_cache(conn, "dashboard:current", build_dashboard(payload), observed_at)

            # Keep the same response shape for each selectable month.  The
            # browser therefore only switches PostgreSQL cache keys; it never
            # calls the source APIs when the user chooses an older month.
            current = payload.get("current_period") or {}
            previous = payload.get("previous_period") or {}
            period_pairs = [
                (current, "current_month", "previous_month"),
                (previous, "previous_month", "older_month"),
                (payload.get("older_period") or {}, "older_month", "missing_month"),
            ]
            for period, current_key, previous_key in period_pairs:
                year = int(period.get("year") or 0)
                month = int(period.get("month") or 0)
                if not year or not month:
                    continue
                period_payload = dict(payload)
                period_payload["current_period"] = {"year": year, "month": month}
                period_payload["previous_period"] = _previous_period(year, month)
                period_payload["items"] = [
                    {
                        **item,
                        "current_month": item.get(current_key) or {},
                        "previous_month": item.get(previous_key) or {},
                    }
                    for item in payload.get("items") or []
                ]
                _save_cache(conn, f"period:{year}-{month:02d}", period_payload, observed_at)
                _save_cache(conn, f"dashboard:period:{year}-{month:02d}", build_dashboard(period_payload), observed_at)


def get_cached_result(cache_key: str = "current") -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute(
            "SELECT payload_json FROM ranking_cache WHERE cache_key = %s", (cache_key,)
        ).fetchone()
    return row["payload_json"] if row else None


def load_live_totals() -> list[dict[str, Any]]:
    """Restore today's hot totals after a collector deployment/restart."""

    with connect() as conn:
        rows = conn.execute(
            """
            SELECT current_row.streamer_id, current_row.crew_name, current_row.nickname, current_row.broadcast_no,
                   current_row.reporting_date, COALESCE(current_row.display_date, current_row.reporting_date) AS display_date,
                   current_row.year, current_row.month, current_row.today_balloons, current_row.month_balloons,
                   current_row.daily_fans, current_row.source, current_row.counting_mode,
                   current_row.session_offset, current_row.finalized, current_row.connected, current_row.observed_at,
                   previous.reporting_date AS previous_date,
                   previous.today_balloons AS previous_balloons,
                   previous.daily_fans AS previous_fans
            FROM streamer_live_totals current_row
            LEFT JOIN LATERAL (
              SELECT session.reporting_date, session.today_balloons, session.daily_fans
              FROM streamer_live_sessions session
              WHERE session.streamer_id = current_row.streamer_id
                AND session.reporting_date = (NOW() AT TIME ZONE 'Asia/Seoul')::date - 1
                AND session.reporting_date <> current_row.reporting_date
                AND session.broadcast_no <> COALESCE(current_row.broadcast_no, '')
              ORDER BY session.observed_at DESC
              LIMIT 1
            ) previous ON TRUE
            WHERE COALESCE(current_row.display_date, current_row.reporting_date) >= (NOW() AT TIME ZONE 'Asia/Seoul')::date - 1
            """
        ).fetchall()
    return [
        {
            "user_id": str(row["streamer_id"]),
            "crew_name": str(row["crew_name"] or ""),
            "nickname": str(row["nickname"] or row["streamer_id"]),
            "broadcast_no": str(row["broadcast_no"] or ""),
            "date": row["reporting_date"].isoformat(),
            "display_date": row["display_date"].isoformat(),
            "year": int(row["year"]),
            "month": int(row["month"]),
            "today": int(row["today_balloons"]),
            "total": int(row["month_balloons"]),
            "fans": row["daily_fans"] or [],
            "source": str(row["source"]),
            "counting_mode": str(row["counting_mode"] or "legacy"),
            "session_offset": int(row["session_offset"] or 0),
            "finalized": bool(row["finalized"]),
            # A restored row is not connected until its upstream task opens.
            "connected": False,
            "observed_at": row["observed_at"].isoformat(),
            "previous_date": row["previous_date"].isoformat() if row["previous_date"] else None,
            "previous_balloons": int(row["previous_balloons"] or 0),
            "previous_fans": row["previous_fans"] or [],
        }
        for row in rows
    ]


def load_recent_donation_ids() -> list[str]:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT donation_id FROM live_donation_events
            WHERE occurred_at >= NOW() - INTERVAL '2 days'
            ORDER BY occurred_at DESC LIMIT 20000
            """
        ).fetchall()
    return [str(row["donation_id"]) for row in rows]


def persist_live_updates(
    updates: list[dict[str, Any]],
    events: list[dict[str, Any]],
    observed_at: datetime,
) -> None:
    """Flush a hot-memory batch without re-upserting every member/month row."""

    if not updates and not events:
        return
    with connect() as conn:
        with conn.transaction():
            for event in events:
                conn.execute(
                    """
                    INSERT INTO live_donation_events (
                      donation_id, streamer_id, broadcast_no, amount,
                      occurred_at, payload_json
                    ) VALUES (%s, %s, %s, %s, %s, %s::jsonb)
                    ON CONFLICT (donation_id) DO NOTHING
                    """,
                    (
                        event["donation_id"], event["user_id"],
                        event.get("broadcast_no"), int(event["amount"]),
                        _as_datetime(event.get("occurred_at")) or observed_at,
                        _as_json(event.get("payload") or {}),
                    ),
                )

            for row in updates:
                if row.get("broadcast_no"):
                    conn.execute(
                        """
                        INSERT INTO streamer_live_sessions (
                          streamer_id, broadcast_no, crew_name, nickname,
                          reporting_date, display_date, year, month, today_balloons,
                          month_balloons, daily_fans, source, finalized, observed_at
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s)
                        ON CONFLICT (streamer_id, broadcast_no) DO UPDATE SET
                          crew_name = EXCLUDED.crew_name,
                          nickname = EXCLUDED.nickname,
                          reporting_date = EXCLUDED.reporting_date,
                          display_date = EXCLUDED.display_date,
                          year = EXCLUDED.year,
                          month = EXCLUDED.month,
                          today_balloons = EXCLUDED.today_balloons,
                          month_balloons = EXCLUDED.month_balloons,
                          daily_fans = EXCLUDED.daily_fans,
                          source = EXCLUDED.source,
                          finalized = EXCLUDED.finalized,
                          observed_at = EXCLUDED.observed_at,
                          updated_at = NOW()
                        """,
                        (
                            row["user_id"], str(row["broadcast_no"]),
                            row.get("crew_name") or "", row.get("nickname") or row["user_id"],
                            row["date"], row.get("display_date") or row["date"],
                            int(row["year"]), int(row["month"]), int(row["today"]),
                            int(row["total"]), _as_json(row.get("fans") or []),
                            row.get("source") or "poonggo_sse", bool(row.get("finalized")),
                            _as_datetime(row.get("observed_at")) or observed_at,
                        ),
                    )
                conn.execute(
                    """
                    INSERT INTO streamer_live_totals (
                      streamer_id, crew_name, nickname, broadcast_no,
                      reporting_date, display_date, year, month, today_balloons,
                      month_balloons, daily_fans, source, counting_mode, session_offset,
                      finalized, connected, observed_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (streamer_id) DO UPDATE SET
                      crew_name = EXCLUDED.crew_name,
                      nickname = EXCLUDED.nickname,
                      broadcast_no = EXCLUDED.broadcast_no,
                      reporting_date = EXCLUDED.reporting_date,
                      display_date = EXCLUDED.display_date,
                      year = EXCLUDED.year,
                      month = EXCLUDED.month,
                      today_balloons = EXCLUDED.today_balloons,
                      month_balloons = EXCLUDED.month_balloons,
                      daily_fans = EXCLUDED.daily_fans,
                      source = EXCLUDED.source,
                      counting_mode = EXCLUDED.counting_mode,
                      session_offset = EXCLUDED.session_offset,
                      finalized = EXCLUDED.finalized,
                      connected = EXCLUDED.connected,
                      observed_at = EXCLUDED.observed_at,
                      updated_at = NOW()
                    """,
                    (
                        row["user_id"], row.get("crew_name") or "",
                        row.get("nickname") or row["user_id"],
                        row.get("broadcast_no"), row["date"],
                        row.get("display_date") or row["date"],
                        int(row["year"]), int(row["month"]),
                        int(row["today"]), int(row["total"]),
                        _as_json(row.get("fans") or []),
                        row.get("source") or "poonggo_sse",
                        row.get("counting_mode") or "legacy",
                        int(row.get("session_offset") or 0),
                        bool(row.get("finalized")),
                        bool(row.get("connected")),
                        _as_datetime(row.get("observed_at")) or observed_at,
                    ),
                )
                session_date = str(row["date"])
                if (int(session_date[:4]), int(session_date[5:7])) == (
                    int(row["year"]), int(row["month"])
                ):
                    day = int(session_date[-2:])
                    conn.execute(
                        """
                    UPDATE streamer_month_current
                    SET total_balloons = %s,
                        daily_balloons = (
                          SELECT COALESCE(jsonb_agg(value ORDER BY (value->>'day')::int), '[]'::jsonb)
                          FROM (
                            SELECT value FROM jsonb_array_elements(daily_balloons)
                            WHERE (value->>'day')::int <> %s
                            UNION ALL
                            SELECT jsonb_build_object('day', %s, 'balloons', %s)
                          ) days
                        ),
                        data_source = %s,
                        source_observed_at = %s,
                        last_collected_at = %s,
                        last_changed_at = %s
                    WHERE streamer_id = %s AND year = %s AND month = %s
                    """,
                        (
                            int(row["total"]), day, day, int(row["today"]),
                            row.get("source") or "poonggo_sse", observed_at,
                            observed_at, observed_at, row["user_id"],
                            int(row["year"]), int(row["month"]),
                        ),
                    )
                else:
                    # A broadcast crossing a month boundary belongs to its
                    # start date, not an impossible day in the new month.
                    conn.execute(
                        """
                        UPDATE streamer_month_current
                        SET total_balloons = %s, data_source = %s,
                            source_observed_at = %s, last_collected_at = %s,
                            last_changed_at = %s
                        WHERE streamer_id = %s AND year = %s AND month = %s
                        """,
                        (
                            int(row["total"]), row.get("source") or "poonggo_sse",
                            observed_at, observed_at, observed_at, row["user_id"],
                            int(row["year"]), int(row["month"]),
                        ),
                    )



def get_collector_members() -> list[dict[str, Any]]:
    """The collector's membership source of truth is PostgreSQL, not Sheets."""

    with connect() as conn:
        rows = conn.execute(
            "SELECT crew_name, user_id, nickname, note FROM members ORDER BY crew_name, id"
        ).fetchall()
        try:
            crew_rows = conn.execute("SELECT crew_name FROM crews").fetchall()
        except Exception:
            crew_rows = []
    canonical = {
        str(row["crew_name"]).strip().lower(): str(row["crew_name"]).strip()
        for row in crew_rows
        if str(row.get("crew_name") or "").strip()
    }
    canonical["fa"] = "FA"
    output = []
    for row in rows:
        raw_crew = str(row["crew_name"] or "").strip()
        crew_name = canonical.get(raw_crew.lower(), raw_crew)
        if raw_crew.upper() == "FA":
            crew_name = "FA"
        output.append(
            {
                "crew_name": crew_name,
                "user_id": str(row["user_id"]),
                "nickname": str(row["nickname"] or row["user_id"]),
                "note": str(row["note"] or ""),
                "is_on_leave": str(row["note"] or "").strip().lower() == "휴직",
            }
        )
    return output


def get_collector_state(year: int, month: int) -> dict[tuple[str, str], dict[str, Any]]:
    """Restore scheduling hints after a worker restart from durable rows."""

    with connect() as conn:
        rows = conn.execute(
            """
            SELECT crew_name, streamer_id, is_live, last_changed_at,
                   last_detail_collected_at, last_live_end_at
            FROM streamer_month_current
            WHERE year = %s AND month = %s
            """,
            (year, month),
        ).fetchall()
    return {
        (str(row["crew_name"]), str(row["streamer_id"])): {
            "is_live": bool(row["is_live"]),
            "last_changed_at": row["last_changed_at"],
            "last_detail_collected_at": row["last_detail_collected_at"],
            "last_live_end_at": row["last_live_end_at"],
        }
        for row in rows
    }


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


def record_source_collection_result(success: bool, observed_at: datetime) -> None:
    """Persist lightweight source health counters for the admin monitor."""

    with connect() as conn:
        conn.execute(
            """
            INSERT INTO collector_status (
              status_key, source_request_count, source_failure_count,
              last_source_success_at, updated_at
            ) VALUES ('current', 1, %s, %s, %s)
            ON CONFLICT (status_key) DO UPDATE SET
              source_request_count = collector_status.source_request_count + 1,
              source_failure_count = collector_status.source_failure_count + EXCLUDED.source_failure_count,
              last_source_success_at = COALESCE(EXCLUDED.last_source_success_at, collector_status.last_source_success_at),
              updated_at = EXCLUDED.updated_at
            """,
            (0 if success else 1, observed_at if success else None, observed_at),
        )


def acquire_collector_lease(holder: str, lease_seconds: int) -> bool:
    """Claim the single collector lease without waiting for another worker."""

    with connect() as conn:
        row = conn.execute(
            """
            INSERT INTO collector_lease (lease_key, holder, lease_until, updated_at)
            VALUES ('realtime', %s, NOW() + (%s * INTERVAL '1 second'), NOW())
            ON CONFLICT (lease_key) DO UPDATE SET
              holder = EXCLUDED.holder,
              lease_until = EXCLUDED.lease_until,
              updated_at = EXCLUDED.updated_at
            WHERE collector_lease.lease_until < NOW()
               OR collector_lease.holder = EXCLUDED.holder
            RETURNING holder
            """,
            (holder, lease_seconds),
        ).fetchone()
    return bool(row and row["holder"] == holder)


def recovery_sweep_due(now: datetime) -> bool:
    """Run at most one low-rate all-member verification pass per local day."""

    with connect() as conn:
        row = conn.execute(
            "SELECT last_recovery_at FROM collector_status WHERE status_key = 'current'"
        ).fetchone()
    last_recovery_at = row["last_recovery_at"] if row else None
    return not last_recovery_at or last_recovery_at.date() != now.date()


def mark_recovery_sweep(now: datetime) -> None:
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO collector_status (status_key, last_recovery_at, updated_at)
            VALUES ('current', %s, %s)
            ON CONFLICT (status_key) DO UPDATE SET
              last_recovery_at = EXCLUDED.last_recovery_at,
              updated_at = EXCLUDED.updated_at
            """,
            (now, now),
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
        conn.execute(
            "DELETE FROM live_donation_events WHERE occurred_at < %s",
            (history_from,),
        )
