export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_COLLECTOR_URL = "http://naksoo-collector:8000";

export async function GET(request: Request) {
  const collectorUrl = (
    process.env.NAKSOO_LIVE_INTERNAL_URL || DEFAULT_COLLECTOR_URL
  ).replace(/\/$/, "");

  try {
    const upstream = await fetch(`${collectorUrl}/live/events`, {
      cache: "no-store",
      headers: { Accept: "text/event-stream" },
      signal: request.signal,
    });
    if (!upstream.ok || !upstream.body) {
      return Response.json(
        { error: "실시간 수집기에 연결할 수 없습니다." },
        { status: 503 },
      );
    }

    return new Response(upstream.body, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return Response.json(
      { error: "실시간 수집기가 아직 준비되지 않았습니다." },
      { status: 503 },
    );
  }
}
