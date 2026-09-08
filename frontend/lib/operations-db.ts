import { pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto";

import { getPostgresPool } from "./ranking-cache";

const OPERATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS crews (
  crew_name TEXT PRIMARY KEY,
  representative_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS members (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  crew_name TEXT NOT NULL,
  user_id TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS members_crew_idx ON members (crew_name, user_id);
CREATE TABLE IF NOT EXISTS admins (
  login_id TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  crews TEXT[] NOT NULL DEFAULT '{}',
  is_superadmin BOOLEAN NOT NULL DEFAULT FALSE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS member_requests (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action TEXT NOT NULL,
  crew_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_by TEXT NOT NULL DEFAULT '',
  processed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS member_requests_pending_unique
  ON member_requests (action, lower(crew_name), lower(user_id)) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS guestbook_entries (
  id TEXT PRIMARY KEY,
  streamer_id TEXT NOT NULL,
  parent_id TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  password TEXT NOT NULL,
  password_salt TEXT NOT NULL DEFAULT '',
  likes INTEGER NOT NULL DEFAULT 0,
  dislikes INTEGER NOT NULL DEFAULT 0,
  like_voters TEXT NOT NULL DEFAULT '',
  dislike_voters TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS guestbook_entries_streamer_idx ON guestbook_entries (streamer_id, created_at DESC);
CREATE TABLE IF NOT EXISTS operations_migrations (
  migration_key TEXT PRIMARY KEY,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);`;

export async function ensureOperationsSchema() {
  const pool = getPostgresPool();
  if (!pool) throw new Error("PostgreSQL 연결이 설정되지 않았습니다.");
  await pool.query(OPERATIONS_SCHEMA);
  const passwordHash = hashPassword("1234");
  await pool.query(
    `INSERT INTO admins (login_id, password_hash, is_superadmin, must_change_password)
     VALUES ('admin', $1, TRUE, TRUE)
     ON CONFLICT (login_id) DO NOTHING`,
    [passwordHash],
  );
  const marker = await pool.query(
    "SELECT 1 FROM operations_migrations WHERE migration_key = 'google-sheets-v1'",
  );
  if (marker.rows[0]) return;

  // The old module is imported only for this one-time server-side copy. All
  // normal page/API code uses operations-store and no longer reads Sheets.
  const source = await import("./google-sheets");
  const [members, admins, requests, guestbook, crews] = await Promise.all([
    source.listMembers(),
    source.listAdmins(),
    source.listMemberRequests(),
    source.listGuestbookEntries(),
    source.listRegisteredCrewNames(),
  ]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const crew of crews) {
      await client.query(
        "INSERT INTO crews (crew_name) VALUES ($1) ON CONFLICT DO NOTHING",
        [crew],
      );
    }
    for (const row of members) {
      await client.query(
        "INSERT INTO members (crew_name,user_id,nickname,note) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET crew_name=EXCLUDED.crew_name,nickname=EXCLUDED.nickname,note=EXCLUDED.note",
        [row.crew_name, row.user_id, row.nickname, row.note],
      );
    }
    for (const row of admins) {
      await client.query(
        "INSERT INTO admins (login_id,password_hash,crews) VALUES ($1,$2,$3) ON CONFLICT (login_id) DO NOTHING",
        [row.login_id, hashPassword(row.password), row.crews],
      );
    }
    for (const row of requests) {
      await client.query(
        "INSERT INTO member_requests(action,crew_name,user_id,nickname,status,requested_at,processed_by,processed_at) VALUES($1,$2,$3,$4,$5,$6,$7,NULLIF($8,'')::timestamptz)",
        [row.action,row.crew_name,row.user_id,row.nickname,row.status,row.requested_at || new Date().toISOString(),row.processed_by,row.processed_at],
      );
    }
    for (const row of guestbook) {
      await client.query(
        "INSERT INTO guestbook_entries(id,streamer_id,parent_id,author,body,created_at,password,password_salt,likes,dislikes,like_voters,dislike_voters) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING",
        [row.id,row.streamer_id,row.parent_id,row.author,row.body,row.created_at,row.password,row.password_salt,row.likes,row.dislikes,row.like_voters,row.dislike_voters],
      );
    }
    await client.query(
      "INSERT INTO operations_migrations (migration_key,details) VALUES ('google-sheets-v1',$1::jsonb)",
      [JSON.stringify({ members: members.length, admins: admins.length, requests: requests.length, guestbook: guestbook.length })],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const digest = pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex");
  return `pbkdf2$${salt}$${digest}`;
}

export function verifyPassword(password: string, stored: string) {
  const [kind, salt, expected] = stored.split("$");
  if (kind !== "pbkdf2" || !salt || !expected) return false;
  const actual = pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex");
  return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
