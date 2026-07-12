import { NextResponse } from "next/server";

import { getSessionFromCookies } from "@/lib/admin-session";
import { jsonError } from "@/lib/api-utils";
import {
  getWorkflowUpdateStatus,
  triggerNaksooUpdate,
  WorkflowAlreadyRunningError,
} from "@/lib/github-actions";

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

    const status = await getWorkflowUpdateStatus();

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
    await requireSession();
    await triggerNaksooUpdate();

    return NextResponse.json({
      ok: true,
      message: "데이터 갱신을 요청했습니다. 5~15분 후 반영됩니다.",
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonError("로그인이 필요합니다.", 401);
    }

    if (error instanceof WorkflowAlreadyRunningError) {
      return NextResponse.json(
        {
          error: error.message,
          running: true,
          run_url: error.runUrl ?? null,
        },
        { status: 409 },
      );
    }

    const message =
      error instanceof Error
        ? error.message
        : "데이터 갱신 요청에 실패했습니다.";
    return jsonError(message, 500);
  }
}
