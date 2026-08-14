const BCRAPING_BASE_URL = "https://bcraping.kr";
const CONCURRENCY = 8;
const REQUEST_TIMEOUT_MS = 4000;
const DONOR_LIMIT = 40;
const STATION_CACHE_TTL_MS = 5 * 60_000;

const bcrapingHeaders = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://bcraping.kr/",
};

export type LiveBroadcastDonor = {
  user_id: string;
  nickname: string;
  balloons: number;
  count: number;
};

export type LiveBroadcastStats = {
  user_id: string;
  day_balloons: number;
  source: "bcraping" | "none";
  station_id: number | null;
  donors: LiveBroadcastDonor[];
};

export type LiveStatsTarget = {
  user_id: string;
  station_id?: number | null;
};

type StationHistoryEntry = {
  STATION_ID?: number;
  RECORD_STATUS?: string;
};

type BalloonEvent = {
  BALLON_USER_ID?: string;
  BALLON_USER_NAME?: string;
  BALLON_COUNT?: number;
};

const stationIdCache = new Map<
  string,
  { expiresAt: number; stationId: number | null }
>();

async function fetchBcrapingJson<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${BCRAPING_BASE_URL}${path}`, {
      headers: {
        ...bcrapingHeaders,
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function aggregateDonors(events: BalloonEvent[]): LiveBroadcastDonor[] {
  const donors = new Map<string, LiveBroadcastDonor>();

  for (const event of events) {
    const userId = event.BALLON_USER_ID?.trim().toLowerCase();

    if (!userId) {
      continue;
    }

    const balloons = Number(event.BALLON_COUNT) || 0;
    const current = donors.get(userId) ?? {
      user_id: userId,
      nickname: event.BALLON_USER_NAME?.trim() || userId,
      balloons: 0,
      count: 0,
    };

    current.nickname = event.BALLON_USER_NAME?.trim() || current.nickname;
    current.balloons += balloons;
    current.count += 1;
    donors.set(userId, current);
  }

  return Array.from(donors.values())
    .sort((a, b) => b.balloons - a.balloons)
    .slice(0, DONOR_LIMIT);
}

async function fetchWatchStationId(userId: string): Promise<number | null> {
  const cacheKey = userId.trim().toLowerCase();
  const cached = stationIdCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.stationId;
  }

  const payload = await fetchBcrapingJson<{
    result?: boolean;
    data?: { contents?: StationHistoryEntry[] };
  }>(`/api/station/history/${encodeURIComponent(userId.trim())}`);

  if (!payload?.result) {
    stationIdCache.set(cacheKey, {
      expiresAt: Date.now() + 30_000,
      stationId: null,
    });
    return null;
  }

  const watchEntry = payload.data?.contents?.find(
    (entry) => entry.RECORD_STATUS === "WATCH",
  );
  const stationId = Number(watchEntry?.STATION_ID);
  const resolved =
    Number.isFinite(stationId) && stationId > 0 ? stationId : null;

  stationIdCache.set(cacheKey, {
    expiresAt: Date.now() + STATION_CACHE_TTL_MS,
    stationId: resolved,
  });

  return resolved;
}

async function fetchStationEvents(userId: string, stationId: number) {
  const payload = await fetchBcrapingJson<{
    result?: boolean;
    data?: { contents?: BalloonEvent[] };
  }>(
    `/api/monitor/${encodeURIComponent(userId)}/${stationId}?_=${Date.now()}`,
  );

  if (!payload?.result) {
    return [];
  }

  return payload.data?.contents ?? [];
}

async function fetchBroadcastStats(
  target: LiveStatsTarget,
): Promise<LiveBroadcastStats | null> {
  const trimmed = target.user_id.trim();

  if (!trimmed) {
    return null;
  }

  const givenStationId = Number(target.station_id);
  const stationId =
    Number.isFinite(givenStationId) && givenStationId > 0
      ? givenStationId
      : await fetchWatchStationId(trimmed);

  if (!stationId) {
    return null;
  }

  const events = await fetchStationEvents(trimmed, stationId);
  const donors = aggregateDonors(events);
  const dayBalloons = events.reduce(
    (sum, event) => sum + (Number(event.BALLON_COUNT) || 0),
    0,
  );

  return {
    user_id: trimmed.toLowerCase(),
    day_balloons: dayBalloons,
    source: "bcraping",
    station_id: stationId,
    donors,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await mapper(items[index]);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function fetchBcrapingLiveStats(
  targets: Array<string | LiveStatsTarget>,
): Promise<LiveBroadcastStats[]> {
  const unique = new Map<string, LiveStatsTarget>();

  for (const target of targets) {
    const entry =
      typeof target === "string" ? { user_id: target } : target;
    const trimmed = entry.user_id.trim();

    if (!trimmed) {
      continue;
    }

    const key = trimmed.toLowerCase();

    if (!unique.has(key)) {
      unique.set(key, {
        user_id: trimmed,
        station_id: entry.station_id,
      });
    }
  }

  const list = Array.from(unique.values()).slice(0, 80);
  const results = await mapWithConcurrency(list, CONCURRENCY, fetchBroadcastStats);

  return results.filter(
    (entry): entry is LiveBroadcastStats => entry !== null,
  );
}
