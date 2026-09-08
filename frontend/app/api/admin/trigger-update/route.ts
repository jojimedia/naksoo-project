import { NextResponse } from "next/server";

import { getSessionFromCookies } from "@/lib/admin-session";
import { jsonError } from "@/lib/api-utils";
import {
  getCollectorRefreshStatus,
  requestCollectorRefresh,
} from "@/lib/ranking-cache";

export const dynamic = "force-dynamic";

async function requireSession() {
  const session = await getSessionFromCookies();

  if (!session) {
    throw new Error("UNAUTHORIZED");
  }

  return session;
}

export async function GET() {
  try {
    await requireSession();

    const status = await getCollectorRefreshStatus();

    return NextResponse.json(status);
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError("로그인이 필요합니다.", 401);
    }

    const message =
      error instanceof Error
        ? error.message
        : "데이터 갱신 상태 조회에 실패했습니다.";
    return jsonError(message, 500);
  }
}

export async function POST() {
  try {
    const session = await requireSession();
    const request = await requestCollectorRefresh(session.loginId);

    return NextResponse.json({
      ok: true,
      running: true,
      message: request.requested
        ? "수집기에 즉시 갱신을 요청했습니다. 약 1~3분 안에 반영됩니다."
        : "이미 수집기에 갱신 요청이 전달되어 있습니다.",
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError("로그인이 필요합니다.", 401);
    }

    const message =
      error instanceof Error
        ? error.message
        : "데이터 갱신 요청에 실패했습니다.";
    return jsonError(message, 500);
  }
}
