import { NextResponse } from "next/server";

import { jsonError } from "@/lib/api-utils";
import { displayCrewName } from "@/lib/crews";
import { listPublicCrewNames } from "@/lib/google-sheets";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const crews = await listPublicCrewNames();

    return NextResponse.json({
      crews: crews.map((crew_name) => ({
        crew_name,
        display_name: displayCrewName(crew_name),
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "크루 목록 조회에 실패했습니다.";
    return jsonError(message, 500);
  }
}
