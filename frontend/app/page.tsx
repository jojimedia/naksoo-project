import { Suspense } from "react";

import DashboardLoader from "./dashboard-loader";

function DashboardFallback() {
  return (
    <main className="min-h-screen bg-[#111018] px-4 py-8 text-[#e5e7eb]">
      <div className="mx-auto max-w-7xl animate-pulse space-y-4">
        <div className="h-9 w-52 rounded-lg bg-[#282431]" />
        <div className="h-20 rounded-2xl bg-[#1b1822]" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="h-72 rounded-2xl bg-[#1b1822]" />
          ))}
        </div>
      </div>
    </main>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<DashboardFallback />}>
      <DashboardLoader fallback={<DashboardFallback />} />
    </Suspense>
  );
}
