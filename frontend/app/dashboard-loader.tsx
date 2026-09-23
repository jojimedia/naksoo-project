"use client";

import { ReactNode, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

import CrewDashboard, { type CrewDashboardData } from "./crew-dashboard";

export default function DashboardLoader({ fallback }: { fallback: ReactNode }) {
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const [data, setData] = useState<CrewDashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);

    void fetch(`/api/dashboard${query ? `?${query}` : ""}`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`dashboard_snapshot_${response.status}`);
        }
        return response.json() as Promise<CrewDashboardData>;
      })
      .then(setData)
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        console.error("Failed to load dashboard snapshot", reason);
        setError("대시보드 데이터를 불러오지 못했습니다.");
      });

    return () => controller.abort();
  }, [query]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#111018] px-4 text-[#e5e7eb]">
        <div className="rounded-2xl border border-[#3a3447] bg-[#1b1822] p-6 text-center">
          <p className="font-semibold">{error}</p>
          <button
            type="button"
            className="mt-4 rounded-lg bg-[#7c3aed] px-4 py-2 text-sm font-bold text-white"
            onClick={() => window.location.reload()}
          >
            다시 시도
          </button>
        </div>
      </main>
    );
  }

  return data ? <CrewDashboard data={data} /> : fallback;
}
