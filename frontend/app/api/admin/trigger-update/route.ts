import { NextResponse } from "next/server";

import { getSessionFromCookies } from "@/lib/admin-session";
import { jsonError } from "@/lib/api-utils";
import { triggerNaksooUpdate } from "@/lib/github-actions";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const session = await getSessionFromCookies();

    if (!session) {
      return jsonError("로그인이 필요합니다.", 401);
    }

    await triggerNaksooUpdate();

    return NextResponse.json({
      ok: true,
      message: "데이터 갱신을 요청했습니다. 5~15분 후 반영됩니다.",
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "데이터 갱신 요청에 실패했습니다.";
    return jsonError(message, 500);
  }
}
