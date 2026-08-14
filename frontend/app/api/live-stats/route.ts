import { NextResponse } from "next/server";

import { jsonError } from "@/lib/api-utils";
import { fetchBcrapingLiveStats } from "@/lib/bcraping-stats";
import { fetchLiveDayBalloons } from "@/lib/poongtu-stats";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      user_ids?: string[];
      streams?: Array<{ user_id?: string; station_id?: number | null }>;
      skip_fallback?: boolean;
    };
    const streams = Array.isArray(body.streams)
      ? body.streams
          .map((stream) => ({
            user_id: String(stream.user_id ?? "").trim(),
            station_id: Number(stream.station_id) || null,
          }))
          .filter((stream) => stream.user_id)
      : (Array.isArray(body.user_ids) ? body.user_ids : []).map((userId) => ({
          user_id: userId,
          station_id: null,
        }));

    if (streams.length === 0) {
      return NextResponse.json({ stats: [] });
    }

    const bcrapingStats = await fetchBcrapingLiveStats(streams);
    const bcrapingByUserId = new Map(
      bcrapingStats.map((entry) => [entry.user_id, entry]),
    );

    const fallbackUserIds = body.skip_fallback
      ? []
      : streams
          .map((stream) => stream.user_id.trim().toLowerCase())
          .filter((userId) => userId && !bcrapingByUserId.has(userId));

    const poongtuStats =
      fallbackUserIds.length > 0
        ? await fetchLiveDayBalloons(fallbackUserIds)
        : [];

    const stats = [
      ...bcrapingStats.map((entry) => ({
        user_id: entry.user_id,
        day_balloons: entry.day_balloons,
        source: entry.source,
        station_id: entry.station_id,
        donors: entry.donors,
      })),
      ...poongtuStats.map((entry) => ({
        user_id: entry.user_id,
        day_balloons: entry.day_balloons,
        source: "poongtu" as const,
        station_id: null,
        donors: [],
      })),
    ];

    return NextResponse.json({ stats });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "라이브 별풍선 조회에 실패했습니다.";
    return jsonError(message, 500);
  }
}
