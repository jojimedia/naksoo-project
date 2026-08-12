import { NextResponse } from "next/server";

import {
  assertCrewAccess,
  getSessionFromCookies,
} from "@/lib/admin-session";
import { jsonError } from "@/lib/api-utils";
import { isFaCrew } from "@/lib/crews";
import {
  addMember,
  getMemberRequestsByRowIndexes,
  moveMemberToFa,
  updateMemberNote,
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
      return jsonError("승인할 항목을 선택해주세요.");
    }

    const entries = await getMemberRequestsByRowIndexes(rowIndexes);
    const byRow = new Map(entries.map((entry) => [entry.rowIndex, entry]));
    const approved: number[] = [];
    const failures: Array<{ row_index: number; error: string }> = [];

    for (const rowIndex of rowIndexes) {
      const entry = byRow.get(rowIndex);

      if (!entry) {
        failures.push({ row_index: rowIndex, error: "신청을 찾을 수 없습니다." });
        continue;
      }

      if (entry.status !== "pending") {
        failures.push({
          row_index: rowIndex,
          error: "이미 처리된 신청입니다.",
        });
        continue;
      }

      try {
        assertCrewAccess(session, entry.crew_name);

        if (entry.action === "add") {
          await addMember(entry.crew_name, entry.user_id, entry.nickname);
        } else if (entry.action === "leave") {
          await updateMemberNote(entry.crew_name, entry.user_id, "휴직");
        } else if (entry.action === "restore") {
          await updateMemberNote(entry.crew_name, entry.user_id, "");
        } else if (entry.action === "retire") {
          if (isFaCrew(entry.crew_name)) {
            throw new Error("무소속 멤버는 퇴사 처리할 수 없습니다.");
          }
          await moveMemberToFa(entry.crew_name, entry.user_id);
        } else {
          throw new Error("지원하지 않는 신청 유형입니다.");
        }

        await updateMemberRequestStatuses(
          [rowIndex],
          "approved",
          session.loginId,
        );
        approved.push(rowIndex);
      } catch (error) {
        failures.push({
          row_index: rowIndex,
          error:
            error instanceof Error ? error.message : "승인 처리에 실패했습니다.",
        });
      }
    }

    return NextResponse.json({
      ok: failures.length === 0,
      approved_count: approved.length,
      failed_count: failures.length,
      failures,
      message:
        failures.length === 0
          ? `${approved.length}건을 승인했습니다.`
          : `${approved.length}건 승인, ${failures.length}건 실패`,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "승인 처리에 실패했습니다.";
    return jsonError(message, 500);
  }
}
