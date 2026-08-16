import { NextResponse } from "next/server";

import { jsonError } from "@/lib/api-utils";
import { listGuestbookSummary } from "@/lib/google-sheets";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const latest = await listGuestbookSummary();
    return NextResponse.json({ latest });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "방명록 요약을 불러오지 못했습니다.";
    return jsonError(message, 500);
  }
}
