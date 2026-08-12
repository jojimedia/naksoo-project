import { NextResponse } from "next/server";

import { jsonError } from "@/lib/api-utils";
import { assertValidPublicCrew } from "@/lib/member-requests";
import { listMembers } from "@/lib/google-sheets";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const crewName = searchParams.get("crew")?.trim() ?? "";

    if (!crewName) {
      return jsonError("crew 파라미터가 필요합니다.");
    }

    await assertValidPublicCrew(crewName);
    const members = await listMembers(crewName);

    return NextResponse.json({
      crew_name: crewName,
      members: members.map((member) => ({
        user_id: member.user_id,
        nickname: member.nickname,
        note: member.note,
        is_on_leave: member.is_on_leave,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "멤버 목록 조회에 실패했습니다.";
    return jsonError(message, 500);
  }
}
