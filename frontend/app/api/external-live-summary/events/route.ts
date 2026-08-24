export const dynamic = "force-dynamic";

const DEFAULT_EVENTS_URL =
  "https://excel-stream-api-139146601312.asia-northeast3.run.app/api/external/live-summary/events?crew_id=1&scope=crew";

export async function GET(request: Request) {
  const endpoint =
    process.env.EXTERNAL_LIVE_SUMMARY_EVENTS_URL?.trim() ||
    DEFAULT_EVENTS_URL;
  const token = process.env.SOOP_EXTERNAL_SSE_TOKEN?.trim();

  if (!token) {
    return Response.json(
      { message: "라이브 요약 API 토큰이 설정되지 않았습니다." },
      { status: 503 },
    );
  }

  try {
    const upstream = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: request.signal,
    });

    if (!upstream.ok || !upstream.body) {
      return Response.json(
        { message: "라이브 요약 연결에 실패했습니다." },
        { status: upstream.status || 502 },
      );
    }

    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch {
    return Response.json(
      { message: "라이브 요약 서버에 연결할 수 없습니다." },
      { status: 502 },
    );
  }
}
