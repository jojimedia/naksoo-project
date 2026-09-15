import {
  getCachedRankingVersion,
  isPostgresConfigured,
} from "@/lib/ranking-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isPostgresConfigured()) {
    return Response.json({ error: "database_not_configured" }, { status: 503 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const year = Number(searchParams.get("year"));
    const month = Number(searchParams.get("month"));
    const cacheKey =
      Number.isInteger(year) && year >= 2020 &&
      Number.isInteger(month) && month >= 1 && month <= 12
        ? `dashboard:period:${year}-${String(month).padStart(2, "0")}`
        : "dashboard:current";
    const version = await getCachedRankingVersion(cacheKey);

    return Response.json(
      { version },
      {
        headers: {
          "Cache-Control": "public, s-maxage=2, stale-while-revalidate=2",
        },
      },
    );
  } catch (error) {
    console.error("Failed to load dashboard cache version", error);
    return Response.json({ error: "dashboard_version_unavailable" }, { status: 503 });
  }
}
