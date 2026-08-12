import { NextResponse } from "next/server";

import {
  assertCrewAccess,
  getSessionFromCookies,
} from "@/lib/admin-session";
import { jsonError } from "@/lib/api-utils";
import {
  getMemberRequestsByRowIndexes,
  updateMemberRequestStatuses,
} from "@/lib/google-sheets";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const session = await getSessionFromCookies();

    if (!session) {
      return jsonError("로그인이 필요합니다.", 401);
    }

    const body = (await request.json()) as { row_indexes?: number[] };
    const rowIndexes = Array.isArray(body.row_indexes)
      ? body.row_indexes.filter((value) => Number.isInteger(value) && value > 0)
      : [];

    if (rowIndexes.length === 0) {
      return jsonError("거절할 항목을 선택해주세요.");
    }

    const entries = await getMemberRequestsByRowIndexes(rowIndexes);
    const allowed: number[] = [];
    const failures: Array<{ row_index: number; error: string }> = [];

    for (const entry of entries) {
      if (entry.status !== "pending") {
        failures.push({
          row_index: entry.rowIndex,
          error: "이미 처리된 신청입니다.",
        });
        continue;
      }

      try {
        assertCrewAccess(session, entry.crew_name);
        allowed.push(entry.rowIndex);
      } catch {
        failures.push({
          row_index: entry.rowIndex,
          error: "해당 크루에 대한 권한이 없습니다.",
        });
      }
    }

    if (allowed.length > 0) {
      await updateMemberRequestStatuses(allowed, "rejected", session.loginId);
    }

    return NextResponse.json({
      ok: failures.length === 0,
      rejected_count: allowed.length,
      failed_count: failures.length,
      failures,
      message:
        failures.length === 0
          ? `${allowed.length}건을 거절했습니다.`
          : `${allowed.length}건 거절, ${failures.length}건 실패`,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "거절 처리에 실패했습니다.";
    return jsonError(message, 500);
  }
}
