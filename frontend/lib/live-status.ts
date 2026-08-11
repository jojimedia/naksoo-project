const LIVE_API_URL = "https://live.sooplive.co.kr/afreeca/player_live_api.php";
const CONCURRENCY = 12;

export type LiveStatusEntry = {
  user_id: string;
  is_live: boolean;
};

async function fetchOneLiveStatus(userId: string): Promise<LiveStatusEntry> {
  const trimmed = userId.trim();

  if (!trimmed) {
    return { user_id: userId, is_live: false };
  }

  try {
    const body = new URLSearchParams({
      bid: trimmed,
      from_api: "0",
      mode: "landing",
      player_type: "html5",
    });

    const response = await fetch(LIVE_API_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://live.sooplive.co.kr",
        Referer: `https://live.sooplive.co.kr/${encodeURIComponent(trimmed)}`,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      body,
      cache: "no-store",
    });

    if (!response.ok) {
      return { user_id: trimmed, is_live: false };
    }

    const data = (await response.json()) as {
      CHANNEL?: {
        RESULT?: number | string;
        BPWD?: string;
      };
    };
    const channel = data.CHANNEL ?? {};
    const result = Number(channel.RESULT);
    const isLive = result === 1 && channel.BPWD !== "Y";

    return { user_id: trimmed, is_live: isLive };
  } catch {
    return { user_id: trimmed, is_live: false };
  }
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
  const results: LiveStatusEntry[] = [];

  for (let index = 0; index < unique.length; index += CONCURRENCY) {
    const chunk = unique.slice(index, index + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map((userId) => fetchOneLiveStatus(userId)),
    );
    results.push(...chunkResults);
  }

  return results;
}
