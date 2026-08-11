const STATION_API_URL = "https://chapi.sooplive.co.kr/api";
const LIVE_THUMB_BASE = "https://liveimg.sooplive.co.kr/m";
const CONCURRENCY = 40;
const REQUEST_TIMEOUT_MS = 3500;

export type LiveStatusEntry = {
  user_id: string;
  is_live: boolean;
  thumbnail_url: string | null;
  title: string | null;
  viewer_count: number | null;
};

function offlineEntry(userId: string): LiveStatusEntry {
  return {
    user_id: userId,
    is_live: false,
    thumbnail_url: null,
    title: null,
    viewer_count: null,
  };
}

const defaultHeaders = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Referer: "https://www.sooplive.co.kr/",
};

export function buildLiveThumbnailUrl(broadNo: number | string) {
  return `${LIVE_THUMB_BASE}/${broadNo}`;
}

async function fetchOneLiveStatus(userId: string): Promise<LiveStatusEntry> {
  const trimmed = userId.trim();

  if (!trimmed) {
    return offlineEntry(userId);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${STATION_API_URL}/${encodeURIComponent(trimmed)}/station`,
      {
        headers: defaultHeaders,
        cache: "no-store",
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      return offlineEntry(trimmed);
    }

    const data = (await response.json()) as {
      broad?: {
        broad_no?: number | string;
        broad_title?: string;
        current_sum_viewer?: number | string;
        is_password?: boolean;
      } | null;
    };
    const broad = data.broad;

    if (!broad || broad.is_password || broad.broad_no == null) {
      return offlineEntry(trimmed);
    }

    const viewerCount = Number(broad.current_sum_viewer);

    return {
      user_id: trimmed,
      is_live: true,
      thumbnail_url: buildLiveThumbnailUrl(broad.broad_no),
      title: broad.broad_title?.trim() || null,
      viewer_count: Number.isFinite(viewerCount) ? viewerCount : null,
    };
  } catch {
    return offlineEntry(trimmed);
  } finally {
    clearTimeout(timer);
  }
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

export async function fetchLiveStatuses(
  userIds: string[],
): Promise<LiveStatusEntry[]> {
  const originalByLower = new Map<string, string>();

  for (const userId of userIds) {
    const trimmed = userId.trim();

    if (!trimmed) {
      continue;
    }

    const key = trimmed.toLowerCase();

    if (!originalByLower.has(key)) {
      originalByLower.set(key, trimmed);
    }
  }

  const unique = Array.from(originalByLower.values()).slice(0, 200);

  return mapWithConcurrency(unique, CONCURRENCY, fetchOneLiveStatus);
}
