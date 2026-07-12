import { NextResponse } from "next/server";

import { validateSoopUser } from "@/lib/admin-auth";
import {
  assertCrewAccess,
  getSessionFromCookies,
} from "@/lib/admin-session";
import { jsonError } from "@/lib/api-utils";
import {
  addMember,
  CrewVersionConflictError,
  deleteMember,
  getCrewMembersState,
  updateMemberNote,
} from "@/lib/google-sheets";

export const dynamic = "force-dynamic";

async function requireSession() {
  const session = await getSessionFromCookies();

  if (!session) {
    throw new Error("UNAUTHORIZED");
  }

  return session;
}

export async function GET(request: Request) {
  try {
    const session = await requireSession();
    const { searchParams } = new URL(request.url);
    const crewName = searchParams.get("crew")?.trim() ?? "";

    if (!crewName) {
      return jsonError("crew 파라미터가 필요합니다.");
    }

    assertCrewAccess(session, crewName);

    const { members, version } = await getCrewMembersState(crewName);

    return NextResponse.json({
      crew_name: crewName,
      version,
      members: members.map((member) => ({
        crew_name: member.crew_name,
        user_id: member.user_id,
        nickname: member.nickname,
        note: member.note,
        is_on_leave: member.is_on_leave,
      })),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError("로그인이 필요합니다.", 401);
    }

    const message =
      error instanceof Error ? error.message : "멤버 목록 조회에 실패했습니다.";
    return jsonError(message, 500);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireSession();
    const body = (await request.json()) as {
      crew_name?: string;
      user_id?: string;
      expected_version?: string;
    };

    const crewName = body.crew_name?.trim() ?? "";
    const userId = body.user_id?.trim() ?? "";
    const expectedVersion = body.expected_version?.trim() ?? "";

    if (!crewName || !userId) {
      return jsonError("crew_name과 user_id가 필요합니다.");
    }

    assertCrewAccess(session, crewName);

    const validated = await validateSoopUser(userId);

    if (!validated) {
      return jsonError("유효하지 않은 SOOP ID입니다.");
    }

    await addMember(
      crewName,
      validated.user_id,
      validated.nickname,
      expectedVersion || undefined,
    );

    const { version } = await getCrewMembersState(crewName);

    return NextResponse.json({
      ok: true,
      version,
      member: {
        crew_name: crewName,
        user_id: validated.user_id,
        nickname: validated.nickname,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError("로그인이 필요합니다.", 401);
    }

    if (error instanceof CrewVersionConflictError) {
      return jsonError(error.message, 409);
    }

    const message =
      error instanceof Error ? error.message : "멤버 등록에 실패했습니다.";
    return jsonError(message, 500);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await requireSession();
    const body = (await request.json()) as {
      crew_name?: string;
      user_id?: string;
      expected_version?: string;
    };

    const crewName = body.crew_name?.trim() ?? "";
    const userId = body.user_id?.trim() ?? "";
    const expectedVersion = body.expected_version?.trim() ?? "";

    if (!crewName || !userId) {
      return jsonError("crew_name과 user_id가 필요합니다.");
    }

    assertCrewAccess(session, crewName);
    await deleteMember(crewName, userId, expectedVersion || undefined);

    const { version } = await getCrewMembersState(crewName);

    return NextResponse.json({ ok: true, version });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError("로그인이 필요합니다.", 401);
    }

    if (error instanceof CrewVersionConflictError) {
      return jsonError(error.message, 409);
    }

    const message =
      error instanceof Error ? error.message : "멤버 삭제에 실패했습니다.";
    return jsonError(message, 500);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireSession();
    const body = (await request.json()) as {
      crew_name?: string;
      user_id?: string;
      note?: string;
      expected_version?: string;
    };

    const crewName = body.crew_name?.trim() ?? "";
    const userId = body.user_id?.trim() ?? "";
    const note = body.note ?? "";
    const expectedVersion = body.expected_version?.trim() ?? "";

    if (!crewName || !userId) {
      return jsonError("crew_name과 user_id가 필요합니다.");
    }

    if (note !== "" && note !== "휴직") {
      return jsonError("note는 빈 문자열 또는 '휴직'만 가능합니다.");
    }

    assertCrewAccess(session, crewName);
    await updateMemberNote(
      crewName,
      userId,
      note,
      expectedVersion || undefined,
    );

    const { version } = await getCrewMembersState(crewName);

    return NextResponse.json({
      ok: true,
      version,
      note,
      is_on_leave: note.toLowerCase() === "휴직",
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError("로그인이 필요합니다.", 401);
    }

    if (error instanceof CrewVersionConflictError) {
      return jsonError(error.message, 409);
    }

    const message =
      error instanceof Error ? error.message : "멤버 상태 변경에 실패했습니다.";
    return jsonError(message, 500);
  }
}
