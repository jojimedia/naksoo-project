import { NextResponse } from "next/server";

import { jsonError } from "@/lib/api-utils";
import { appendMemberRequests } from "@/lib/google-sheets";
import {
  validateMemberRequestDrafts,
  type PublicMemberRequestDraft,
} from "@/lib/member-requests";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      requests?: PublicMemberRequestDraft[];
    };
    const validated = await validateMemberRequestDrafts(body.requests ?? []);
    const created = await appendMemberRequests(validated);

    return NextResponse.json({
      ok: true,
      count: created.length,
      message: `${created.length}건의 신청이 접수되었습니다. 관리자 승인 후 반영됩니다.`,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "신청 접수에 실패했습니다.";
    return jsonError(message, 400);
  }
}
