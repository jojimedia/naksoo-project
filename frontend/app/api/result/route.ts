import { getCachedRanking, isPostgresConfigured } from "@/lib/ranking-cache";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isPostgresConfigured()) {
    return Response.json(
      { error: "database_not_configured" },
      { status: 503 },
    );
  }

  try {
    const cached = await getCachedRanking();
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
