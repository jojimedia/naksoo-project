import { Pool } from "pg";

declare global {
  // Keep one pool per Next.js process during hot reload and normal runtime.
  var naksooPostgresPool: Pool | undefined;
  var naksooRankingMemoryCache:
    | Map<string, { value: unknown; expiresAt: number }>
    | undefined;
  var naksooRankingVersionMemoryCache:
    | Map<string, { version: string | null; expiresAt: number }>
    | undefined;
}

const RANKING_MEMORY_CACHE_TTL_MS = 45_000;
const RANKING_VERSION_CHECK_TTL_MS = 2_000;

export function getPostgresPool(): Pool | null {
  const password = process.env.PGPASSWORD;
  const connectionString = process.env.DATABASE_URL;

  if (!password && !connectionString) {
    return null;
  }

  if (!global.naksooPostgresPool) {
    global.naksooPostgresPool = new Pool({
      // A complete DATABASE_URL is the authoritative Cloudtype connection
      // setting. Do not let a partial PG* setting override it.
      ...(connectionString
        ? { connectionString }
        : password
        ? {
            host: process.env.PGHOST ?? "postgresql",
            port: Number(process.env.PGPORT ?? "5432"),
            // Cloudtype's PostgreSQL template uses `root` unless explicitly
            // overridden when the database service is created.
            user: process.env.PGUSER ?? "root",
            password,
            database: process.env.PGDATABASE ?? "postgres",
          }
        : {}),
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 3_000,
    });
  }

  return global.naksooPostgresPool;
}

export async function getCachedRanking(
  cacheKey = "current",
  forceRefresh = false,
): Promise<unknown | null> {
  const pool = getPostgresPool();

  if (!pool) {
    return null;
  }

  const cache = global.naksooRankingMemoryCache ??= new Map();
  const fromMemory = cache.get(cacheKey);
  if (!forceRefresh && fromMemory && fromMemory.expiresAt > Date.now()) {
    return fromMemory.value;
  }

  const result = await pool.query<{ payload_json: unknown }>(
    "SELECT payload_json FROM ranking_cache WHERE cache_key = $1",
    [cacheKey],
  );

  const value = result.rows[0]?.payload_json ?? null;
  if (value) {
    cache.set(cacheKey, {
      value,
      expiresAt: Date.now() + RANKING_MEMORY_CACHE_TTL_MS,
    });
  }
  return value;
}

/**
 * A tiny version query lets the page keep a fully prepared dashboard in
 * process memory. Only a collector-detected data change causes a full JSON
 * read and dashboard recalculation.
 */
export async function getCachedRankingVersion(cacheKey = "current"): Promise<string | null> {
  const pool = getPostgresPool();
  if (!pool) return null;

  const cache = global.naksooRankingVersionMemoryCache ??= new Map();
  const fromMemory = cache.get(cacheKey);
  if (fromMemory && fromMemory.expiresAt > Date.now()) {
    return fromMemory.version;
  }

  const result = await pool.query<{ generated_at: Date | string }>(
    "SELECT generated_at FROM ranking_cache WHERE cache_key = $1",
    [cacheKey],
  );
  const generatedAt = result.rows[0]?.generated_at;
  const version = generatedAt ? new Date(generatedAt).toISOString() : null;
  cache.set(cacheKey, { version, expiresAt: Date.now() + RANKING_VERSION_CHECK_TTL_MS });
  return version;
}

/**
 * Local development cannot reach Cloudtype's private PostgreSQL network.
 * Use the deployed, DB-backed result API only when explicitly configured.
 */
export async function getDevelopmentRanking(): Promise<unknown | null> {
  const url = process.env.NAKSOO_RESULT_API_URL?.trim();

  if (process.env.NODE_ENV === "production" || !url) {
    return null;
  }

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    return null;
  }

  return response.json();
}

export function isPostgresConfigured(): boolean {
  return Boolean(process.env.PGPASSWORD || process.env.DATABASE_URL);
}

export async function requestCollectorRefresh(requestedBy: string) {
  const pool = getPostgresPool();
  if (!pool) {
    throw new Error("PGPASSWORD 또는 DATABASE_URL이 설정되지 않았습니다.");
  }

  const active = await pool.query<{ id: number }>(
    "SELECT id FROM collector_commands WHERE status IN ('queued', 'processing') AND command_type = 'refresh' ORDER BY requested_at DESC LIMIT 1",
  );
  if (active.rows[0]) {
    return { requested: false, commandId: active.rows[0].id };
  }

  const result = await pool.query<{ id: number }>(
    "INSERT INTO collector_commands (command_type, requested_by) VALUES ('refresh', $1) RETURNING id",
    [requestedBy],
  );
  return { requested: true, commandId: result.rows[0].id };
}

export async function getCollectorRefreshStatus() {
  const pool = getPostgresPool();
  if (!pool) {
    throw new Error("PGPASSWORD 또는 DATABASE_URL이 설정되지 않았습니다.");
  }

  const [commandResult, statusResult, overviewResult] = await Promise.all([
    pool.query<{
      id: number;
      status: "queued" | "processing" | "completed" | "failed";
      requested_at: string;
      completed_at: string | null;
      error_message: string | null;
    }>(
      "SELECT id, status, requested_at, completed_at, error_message FROM collector_commands ORDER BY id DESC LIMIT 1",
    ),
    pool.query<{
      last_cycle_at: string | null;
      last_success_at: string | null;
      last_error: string | null;
      source_request_count: number;
      source_failure_count: number;
      last_source_success_at: string | null;
    }>(
      "SELECT last_cycle_at, last_success_at, last_error, source_request_count, source_failure_count, last_source_success_at FROM collector_status WHERE status_key = 'current'",
    ),
    pool.query<{
      active_members: number;
      live_members: number;
      final_collection_due: number;
      oldest_detail_collected_at: string | null;
    }>(
      `SELECT
        COUNT(*) FILTER (WHERE NOT is_on_leave)::int AS active_members,
        COUNT(*) FILTER (WHERE NOT is_on_leave AND is_live)::int AS live_members,
        COUNT(*) FILTER (WHERE NOT is_on_leave AND last_live_end_at > COALESCE(last_detail_collected_at, '-infinity'::timestamptz))::int AS final_collection_due,
        MIN(last_detail_collected_at) FILTER (WHERE NOT is_on_leave) AS oldest_detail_collected_at
       FROM streamer_month_current
       WHERE year = EXTRACT(YEAR FROM NOW() AT TIME ZONE 'Asia/Seoul')::int
         AND month = EXTRACT(MONTH FROM NOW() AT TIME ZONE 'Asia/Seoul')::int`,
    ),
  ]);
  const command = commandResult.rows[0];
  const status = statusResult.rows[0];
  const overview = overviewResult.rows[0];
  return {
    running: command?.status === "queued" || command?.status === "processing",
    command_status: command?.status ?? null,
    requested_at: command?.requested_at ?? null,
    completed_at: command?.completed_at ?? null,
    error: command?.error_message ?? status?.last_error ?? null,
    last_cycle_at: status?.last_cycle_at ?? null,
    last_success_at: status?.last_success_at ?? null,
    last_source_success_at: status?.last_source_success_at ?? null,
    source_request_count: Number(status?.source_request_count ?? 0),
    source_failure_count: Number(status?.source_failure_count ?? 0),
    active_members: Number(overview?.active_members ?? 0),
    live_members: Number(overview?.live_members ?? 0),
    final_collection_due: Number(overview?.final_collection_due ?? 0),
    oldest_detail_collected_at: overview?.oldest_detail_collected_at ?? null,
  };
}
