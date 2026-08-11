const LIVE_API_URL = "https://live.sooplive.co.kr/afreeca/player_live_api.php";
const CONCURRENCY = 12;

export type LiveStatusEntry = {
  user_id: string;
  is_live: boolean;
};

const defaultHeaders = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
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
        ...defaultHeaders,
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://live.sooplive.co.kr",
        Referer: `https://live.sooplive.co.kr/${encodeURIComponent(trimmed)}`,
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
        TITLE?: string;
        BTIME?: number | string;
      };
    };
    const channel = data.CHANNEL ?? {};
    const result = Number(channel.RESULT);
    const isPassword = channel.BPWD === "Y";

    if (isPassword || Number.isNaN(result) || result === 0) {
      return { user_id: trimmed, is_live: false };
    }

    // RESULT 1: 일반 공개 방송
    // RESULT -6: 19금 등으로 시청 제한이지만 방송 중
    // 그 외 음수 코드도 TITLE/BTIME이 있으면 제한된 라이브로 본다.
    const isLive =
      result === 1 ||
      result === -6 ||
      (result < 0 && Boolean(channel.TITLE || channel.BTIME));

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
      chunk.map((id) => fetchOneLiveStatus(id)),
    );
    results.push(...chunkResults);
  }

  return results;
}
