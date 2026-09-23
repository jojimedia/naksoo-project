import { NextRequest, NextResponse } from "next/server";

import { getCachedDashboardSnapshot } from "@/lib/ranking-cache";

export const dynamic = "force-dynamic";

type Period = { year: number; month: number };

function kstPeriod(date = new Date()): Period {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month) };
}

function previousPeriod(period: Period): Period {
  return period.month === 1
    ? { year: period.year - 1, month: 12 }
    : { year: period.year, month: period.month - 1 };
}

export async function GET(request: NextRequest) {
  const current = kstPeriod();
  const previous = previousPeriod(current);
  const periods = [previousPeriod(previous), previous, current];
  const year = Number(request.nextUrl.searchParams.get("year"));
  const month = Number(request.nextUrl.searchParams.get("month"));
  const selected = periods.find(
    (period) => period.year === year && period.month === month,
  );
  const cacheKey = selected
    ? `dashboard:period:${selected.year}-${String(selected.month).padStart(2, "0")}`
    : "dashboard:current";

  try {
    const snapshot = await getCachedDashboardSnapshot(cacheKey);
    if (!snapshot?.value || typeof snapshot.value !== "object") {
      return NextResponse.json(
        { error: "dashboard_snapshot_not_ready" },
        { status: 503 },
      );
    }

    return NextResponse.json(
      {
        ...snapshot.value,
        data_version: snapshot.version,
        month_options: periods,
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=5, stale-while-revalidate=30",
        },
      },
    );
  } catch (error) {
    console.error("Failed to serve dashboard snapshot", error);
    return NextResponse.json(
      { error: "dashboard_snapshot_unavailable" },
      { status: 503 },
    );
  }
}
