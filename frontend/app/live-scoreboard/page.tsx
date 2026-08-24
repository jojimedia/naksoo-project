"use client";

import { useEffect, useState } from "react";
import ExternalLiveSummaryModal, {
  type ExternalLiveSummary,
} from "../external-live-summary-modal";

export default function LiveScoreboardPage() {
  const [summary, setSummary] = useState<ExternalLiveSummary | null>(null);
  const [connectionId, setConnectionId] = useState(0);

  useEffect(() => {
    const events = new EventSource("/api/external-live-summary/events");

    function applySnapshot(event: MessageEvent<string>) {
      try {
        const next = JSON.parse(event.data) as ExternalLiveSummary;
        setSummary(next.session?.status === "live" ? next : null);
      } catch {
        // Keep the last valid snapshot while EventSource reconnects.
      }
    }

    events.onmessage = applySnapshot;
    events.addEventListener("snapshot", (event) => applySnapshot(event as MessageEvent<string>));
    events.addEventListener("live_summary", (event) => applySnapshot(event as MessageEvent<string>));
    events.addEventListener("waiting", () => setSummary(null));
    events.addEventListener("broadcast_ended", () => {
      setSummary(null);
      window.close();
    });
    const reconnectTimer = window.setTimeout(() => {
      events.close();
      setConnectionId((current) => current + 1);
    }, 240_000);
    return () => {
      window.clearTimeout(reconnectTimer);
      events.close();
    };
  }, [connectionId]);

  if (summary) {
    return <ExternalLiveSummaryModal summary={summary} onClose={() => window.close()} />;
  }

  return <main className="grid min-h-screen place-items-center bg-[#111018] p-6 text-center text-[#a8a2b8]"><p className="text-sm font-semibold">광우상사 라이브 점수판을 기다리는 중입니다.</p></main>;
}
