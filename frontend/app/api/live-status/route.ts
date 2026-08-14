import { NextResponse } from "next/server";

import { jsonError } from "@/lib/api-utils";
import { fetchLiveStatuses } from "@/lib/live-status";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { user_ids?: string[] };
    const userIds = Array.isArray(body.user_ids) ? body.user_ids : [];

    if (userIds.length === 0) {
      return NextResponse.json({ live: [] });
    }

    const statuses = await fetchLiveStatuses(userIds);

    return NextResponse.json({
      live: statuses
        .filter((entry) => entry.is_live)
        .map((entry) => ({
          user_id: entry.user_id.toLowerCase(),
          thumbnail_url: entry.thumbnail_url,
          title: entry.title,
          viewer_count: entry.viewer_count,
          broad_no: entry.broad_no,
        })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "라이브 상태 조회에 실패했습니다.";
    return jsonError(message, 500);
  }
}
