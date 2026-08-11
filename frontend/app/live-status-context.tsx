"use client";

import { createContext, useContext } from "react";

const LiveStatusContext = createContext<ReadonlySet<string>>(new Set());

export function LiveStatusProvider({
  liveUserIds,
  children,
}: {
  liveUserIds: ReadonlySet<string>;
  children: React.ReactNode;
}) {
  return (
    <LiveStatusContext.Provider value={liveUserIds}>
      {children}
    </LiveStatusContext.Provider>
  );
}

export function useIsLive(userId: string) {
  return useContext(LiveStatusContext).has(userId.trim().toLowerCase());
}
