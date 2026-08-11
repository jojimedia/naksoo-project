import { listAdmins, listRegisteredCrewNames, syncAdminsCrewColumns } from "./google-sheets";
import type { AdminSession } from "./admin-session";
import { resolveManagedCrews } from "./crews";

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

function getClientKey(ip: string | null) {
  return ip?.trim() || "unknown";
}

export function checkLoginRateLimit(ip: string | null) {
  const key = getClientKey(ip);
  const now = Date.now();
  const current = loginAttempts.get(key);

  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, {
      count: 1,
      resetAt: now + RATE_LIMIT_WINDOW_MS,
    });
    return;
  }

  if (current.count >= RATE_LIMIT_MAX) {
    throw new Error("로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.");
  }

  current.count += 1;
  loginAttempts.set(key, current);
}

export async function authenticateAdmin(
  loginId: string,
  password: string,
): Promise<AdminSession | null> {
  const admins = await listAdmins();
  const admin = admins.find(
    (entry) => entry.login_id === loginId && entry.password === password,
  );

  if (!admin) {
    return null;
  }

  const registeredCrews = await listRegisteredCrewNames();
  await syncAdminsCrewColumns(registeredCrews);

  return {
    loginId: admin.login_id,
    crews: resolveManagedCrews(admin.crews, registeredCrews),
  };
}

export async function validateSoopUser(userId: string) {
  const trimmed = userId.trim();

  if (!trimmed) {
    throw new Error("SOOP ID를 입력해주세요.");
  }

  const response = await fetch(
    `https://api-channel.sooplive.com/v1.1/channel/${encodeURIComponent(trimmed)}/station`,
    {
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as {
    station?: {
      userId?: string;
      userNick?: string;
      profileImage?: string;
    };
  };

  const station = data.station;

  if (!station?.userNick) {
    return null;
  }

  return {
    user_id: station.userId ?? trimmed,
    nickname: station.userNick,
    profile_image_url: station.profileImage ?? null,
  };
}

type SoopSearchHit = {
  user_id: string;
  nickname: string;
  profile_image_url: string | null;
};

function looksLikeSoopUserId(value: string) {
  return /^[a-zA-Z0-9_-]{3,30}$/.test(value);
}

export async function searchSoopBroadcasters(
  query: string,
  limit = 12,
): Promise<SoopSearchHit[]> {
  const trimmed = query.trim();

  if (!trimmed) {
    return [];
  }

  const hits = new Map<string, SoopSearchHit>();

  const exactPromise = looksLikeSoopUserId(trimmed)
    ? validateSoopUser(trimmed)
    : Promise.resolve(null);

  const searchPromise = fetch(
    `https://sch.sooplive.co.kr/api.php?${new URLSearchParams({
      m: "bjSearch",
      v: "1.0",
      c: "UTF-8",
      szKeyword: trimmed,
      nPageNo: "1",
      nListCnt: String(Math.min(Math.max(limit, 1), 30)),
    }).toString()}`,
    {
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        Referer: "https://www.sooplive.co.kr/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      cache: "no-store",
    },
  );

  const [exact, response] = await Promise.all([exactPromise, searchPromise]);

  if (exact) {
    hits.set(exact.user_id.toLowerCase(), exact);
  }

  if (response.ok) {
    const data = (await response.json()) as {
      DATA?: Array<{
        user_id?: string;
        user_nick?: string;
        station_logo?: string;
      }>;
    };

    for (const entry of data.DATA ?? []) {
      const userId = String(entry.user_id ?? "").trim();
      const nickname = String(entry.user_nick ?? "").trim();

      if (!userId || !nickname) {
        continue;
      }

      const key = userId.toLowerCase();

      if (!hits.has(key)) {
        hits.set(key, {
          user_id: userId,
          nickname,
          profile_image_url: entry.station_logo ?? null,
        });
      }
    }
  }

  return Array.from(hits.values()).slice(0, limit);
}
