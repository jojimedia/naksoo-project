"use client";

import { createContext, useContext } from "react";

export type LiveStreamInfo = {
  thumbnailUrl: string | null;
  title: string | null;
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
