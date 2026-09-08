import { getCachedRanking, isPostgresConfigured } from "@/lib/ranking-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isPostgresConfigured()) {
    return Response.json(
      { error: "database_not_configured" },
      { status: 503 },
    );
  }

  try {
    const { searchParams } = new URL(request.url);
    const year = Number(searchParams.get("year"));
    const month = Number(searchParams.get("month"));
    const cacheKey =
      Number.isInteger(year) && year >= 2020 &&
      Number.isInteger(month) && month >= 1 && month <= 12
        ? `period:${year}-${String(month).padStart(2, "0")}`
        : "current";
    const cached = await getCachedRanking(cacheKey);
    if (!cached) {
      return Response.json(
        { error: "ranking_cache_not_ready" },
        { status: 503 },
      );
    }

    return Response.json(cached, {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=30",
        "X-Naksoo-Data-Source": "postgres",
      },
    });
  } catch (error) {
    console.error("Failed to load PostgreSQL ranking cache", error);
    return Response.json({ error: "ranking_cache_unavailable" }, { status: 503 });
  }
}
