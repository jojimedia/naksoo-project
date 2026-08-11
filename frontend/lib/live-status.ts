const LIVE_API_URL = "https://live.sooplive.co.kr/afreeca/player_live_api.php";
const STATION_API_URL = "https://api-channel.sooplive.com/v1.1/channel";
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

async function fetchPlayerLive(userId: string) {
  const body = new URLSearchParams({
    bid: userId,
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
      Referer: `https://live.sooplive.co.kr/${encodeURIComponent(userId)}`,
    },
    body,
    cache: "no-store",
  });

  if (!response.ok) {
    return { is_live: false, is_password: false };
  }

  const data = (await response.json()) as {
    CHANNEL?: {
      RESULT?: number | string;
      BPWD?: string;
    };
  };
  const channel = data.CHANNEL ?? {};
  const isPassword = channel.BPWD === "Y";
  const isLive = Number(channel.RESULT) === 1 && !isPassword;

  return { is_live: isLive, is_password: isPassword };
}

async function fetchStationBroadcastStart(userId: string) {
  const response = await fetch(
    `${STATION_API_URL}/${encodeURIComponent(userId)}/station`,
    {
      headers: defaultHeaders,
      cache: "no-store",
    },
  );

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as {
    station?: {
      broadStart?: string | null;
    };
  };

  return data.station?.broadStart ?? null;
}

async function fetchOneLiveStatus(userId: string): Promise<LiveStatusEntry> {
  const trimmed = userId.trim();

  if (!trimmed) {
    return { user_id: userId, is_live: false };
  }

  try {
    const player = await fetchPlayerLive(trimmed);

    if (player.is_password) {
      return { user_id: trimmed, is_live: false };
    }

    if (player.is_live) {
      return { user_id: trimmed, is_live: true };
    }

    // 19금 등은 player RESULT가 1이 아니어도 station.broadStart가 있으면 방송 중.
    const broadcastStart = await fetchStationBroadcastStart(trimmed);

    return {
      user_id: trimmed,
      is_live: Boolean(broadcastStart),
    };
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
