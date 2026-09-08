import { NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/admin-session";
import { jsonError } from "@/lib/api-utils";
import { hashPassword } from "@/lib/operations-db";
import { getPostgresPool } from "@/lib/ranking-cache";
import { ensureOperationsSchema, verifyPassword } from "@/lib/operations-db";
import { getAdmin } from "@/lib/operations-store";

export async function POST(request: Request) {
  try {
    const session = await getSessionFromCookies();
    if (!session) return jsonError("로그인이 필요합니다.", 401);
    const body = await request.json() as { current_password?: string; new_password?: string };
    if (!body.current_password || !body.new_password || body.new_password.length < 8) return jsonError("새 비밀번호는 8자 이상이어야 합니다.");
    const admin = await getAdmin(session.loginId);
    if (!admin || !verifyPassword(body.current_password, admin.password)) return jsonError("현재 비밀번호가 일치하지 않습니다.", 403);
    await ensureOperationsSchema();
    const pool = getPostgresPool();
    await pool!.query("UPDATE admins SET password_hash=$1,must_change_password=FALSE,updated_at=NOW() WHERE login_id=$2", [hashPassword(body.new_password), session.loginId]);
    return NextResponse.json({ ok: true });
  } catch (error) { return jsonError(error instanceof Error ? error.message : "비밀번호 변경에 실패했습니다.", 500); }
}
