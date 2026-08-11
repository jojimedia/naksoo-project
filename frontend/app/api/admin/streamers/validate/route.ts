import { NextResponse } from "next/server";

import { validateSoopUser } from "@/lib/admin-auth";
import { getSessionFromCookies } from "@/lib/admin-session";
import { jsonError } from "@/lib/api-utils";
import { isFaCrew } from "@/lib/crews";
import { findMemberByUserId } from "@/lib/google-sheets";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await getSessionFromCookies();

  if (!session) {
    return jsonError("로그인이 필요합니다.", 401);
  }

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("user_id")?.trim() ?? "";
  const targetCrew = searchParams.get("crew")?.trim() ?? "";

  if (!userId) {
    return jsonError("user_id 파라미터가 필요합니다.");
  }

  try {
    const validated = await validateSoopUser(userId);

    if (!validated) {
      return NextResponse.json({
        valid: false,
      });
    }

    const existing = await findMemberByUserId(validated.user_id);

    if (existing) {
      if (isFaCrew(existing.crew_name) && !isFaCrew(targetCrew)) {
        return NextResponse.json({
          valid: true,
          from_fa: true,
          user_id: validated.user_id,
          nickname: validated.nickname,
          profile_image_url: validated.profile_image_url,
        });
      }

      return NextResponse.json({
        valid: false,
        already_registered: true,
        existing_crew_name: existing.crew_name,
        user_id: validated.user_id,
        nickname: validated.nickname,
        profile_image_url: validated.profile_image_url,
        error:
          existing.crew_name === targetCrew
            ? "이미 이 크루에 등록된 스트리머입니다."
            : `이미 ${existing.crew_name} 크루에 등록된 스트리머입니다.`,
      });
    }

    return NextResponse.json({
      valid: true,
      user_id: validated.user_id,
      nickname: validated.nickname,
      profile_image_url: validated.profile_image_url,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "스트리머 검증에 실패했습니다.";
    return jsonError(message, 500);
  }
}
