import { listAdmins } from "./google-sheets";
import type { AdminSession } from "./admin-session";

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

  return {
    loginId: admin.login_id,
    crews: admin.crews,
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
