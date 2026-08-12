import { NextResponse } from "next/server";

import { searchSoopBroadcasters } from "@/lib/admin-auth";
import { jsonError } from "@/lib/api-utils";
import { isFaCrew } from "@/lib/crews";
import { findMembersByUserIds } from "@/lib/google-sheets";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() ?? "";
  const targetCrew = searchParams.get("crew")?.trim() ?? "";

  if (!query) {
    return jsonError("검색어를 입력해주세요.");
  }

  if (query.length < 2) {
    return jsonError("검색어는 2글자 이상 입력해주세요.");
  }

  try {
    const hits = await searchSoopBroadcasters(query, 8);
    const existingById = await findMembersByUserIds(
      hits.map((hit) => hit.user_id),
    );
    const candidates = hits.map((hit) => {
      const existing = existingById.get(hit.user_id.toLowerCase()) ?? null;
      const existingCrew = existing?.crew_name ?? null;
      const sameCrew = Boolean(
        existing &&
          (isFaCrew(targetCrew)
            ? isFaCrew(existing.crew_name)
            : existing.crew_name === targetCrew),
      );
      const fromFa = Boolean(
        existing && isFaCrew(existing.crew_name) && !isFaCrew(targetCrew),
      );
      const selectable = !sameCrew && (!existing || fromFa);

      return {
        user_id: hit.user_id,
        nickname: hit.nickname,
        profile_image_url: hit.profile_image_url,
        already_registered: Boolean(existing) && !fromFa,
        from_fa: fromFa,
        existing_crew_name: existingCrew,
        selectable,
      };
    });

    return NextResponse.json({
      query,
      candidates,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "스트리머 검색에 실패했습니다.";
    return jsonError(message, 500);
  }
}
