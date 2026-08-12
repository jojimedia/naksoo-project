import { NextResponse } from "next/server";

import {
  assertCrewAccess,
  getSessionFromCookies,
} from "@/lib/admin-session";
import { jsonError } from "@/lib/api-utils";
import { listPendingMemberRequests } from "@/lib/google-sheets";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSessionFromCookies();

    if (!session) {
      return jsonError("로그인이 필요합니다.", 401);
    }

    const pending = await listPendingMemberRequests();
    const requests = pending.filter((entry) => {
      try {
        assertCrewAccess(session, entry.crew_name);
        return true;
      } catch {
        return false;
      }
    });

    return NextResponse.json({
      requests: requests.map((entry) => ({
        row_index: entry.rowIndex,
        action: entry.action,
        crew_name: entry.crew_name,
        user_id: entry.user_id,
        nickname: entry.nickname,
        status: entry.status,
        requested_at: entry.requested_at,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "신청 목록 조회에 실패했습니다.";
    return jsonError(message, 500);
  }
}
