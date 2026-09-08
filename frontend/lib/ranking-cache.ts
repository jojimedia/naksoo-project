import { Pool } from "pg";

declare global {
  // Keep one pool per Next.js process during hot reload and normal runtime.
  var naksooPostgresPool: Pool | undefined;
}

function getPool(): Pool | null {
  const password = process.env.PGPASSWORD;
  const connectionString = process.env.DATABASE_URL;

  if (!password && !connectionString) {
    return null;
  }

  if (!global.naksooPostgresPool) {
    global.naksooPostgresPool = new Pool({
      ...(password
        ? {
            host: process.env.PGHOST ?? "postgresql",
            port: Number(process.env.PGPORT ?? "5432"),
            user: process.env.PGUSER ?? "postgres",
            password,
            database: process.env.PGDATABASE ?? "postgres",
          }
        : { connectionString: connectionString! }),
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 3_000,
    });
  }

  return global.naksooPostgresPool;
}

export async function getCachedRanking(): Promise<unknown | null> {
  const pool = getPool();

  if (!pool) {
    return null;
  }

  const result = await pool.query<{ payload_json: unknown }>(
    "SELECT payload_json FROM ranking_cache WHERE cache_key = 'current'",
  );

  return result.rows[0]?.payload_json ?? null;
}

export function isPostgresConfigured(): boolean {
  return Boolean(process.env.PGPASSWORD || process.env.DATABASE_URL);
}

export async function requestCollectorRefresh(requestedBy: string) {
  const pool = getPool();
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
  const pool = getPool();
  if (!pool) {
    throw new Error("PGPASSWORD 또는 DATABASE_URL이 설정되지 않았습니다.");
  }

  const [commandResult, statusResult] = await Promise.all([
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
    }>(
      "SELECT last_cycle_at, last_success_at, last_error FROM collector_status WHERE status_key = 'current'",
    ),
  ]);
  const command = commandResult.rows[0];
  const status = statusResult.rows[0];
  return {
    running: command?.status === "queued" || command?.status === "processing",
    command_status: command?.status ?? null,
    requested_at: command?.requested_at ?? null,
    completed_at: command?.completed_at ?? null,
    error: command?.error_message ?? status?.last_error ?? null,
    last_cycle_at: status?.last_cycle_at ?? null,
    last_success_at: status?.last_success_at ?? null,
  };
}
