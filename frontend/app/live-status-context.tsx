"use client";

import { createContext, useContext, useEffect, useState } from "react";

export type LiveStreamInfo = {
  thumbnailUrl: string | null;
  title: string | null;
  viewerCount: number | null;
  broadNo: number | null;
  broadStartMs: number | null;
};

const LiveStatusContext = createContext<ReadonlyMap<string, LiveStreamInfo>>(
  new Map(),
);

export function LiveStatusProvider({
  liveByUserId,
  children,
}: {
  liveByUserId: ReadonlyMap<string, LiveStreamInfo>;
  children: React.ReactNode;
}) {
  return (
    <LiveStatusContext.Provider value={liveByUserId}>
      {children}
    </LiveStatusContext.Provider>
  );
}

export function useIsLive(userId: string) {
  return useContext(LiveStatusContext).has(userId.trim().toLowerCase());
}

export function useLiveInfo(userId: string): LiveStreamInfo | null {
  return useContext(LiveStatusContext).get(userId.trim().toLowerCase()) ?? null;
}

const LiveClockContext = createContext(0);

export function LiveClockProvider({ children }: { children: React.ReactNode }) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => window.clearInterval(timerId);
  }, []);

  return (
    <LiveClockContext.Provider value={nowMs}>
      {children}
    </LiveClockContext.Provider>
  );
}

export function useLiveNowMs() {
  return useContext(LiveClockContext);
}
