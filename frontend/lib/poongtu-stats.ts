const POONG_DETAIL_URL = "https://static.poong.today/bj/detail/get";
const CONCURRENCY = 16;
const REQUEST_TIMEOUT_MS = 4000;

const poongHeaders = {
  Accept: "application/json,text/plain,*/*",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://poong.today/",
  Origin: "https://poong.today",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

export type LiveDayBalloonEntry = {
  user_id: string;
  day_balloons: number;
};

type DailyBalloon = {
  day: number;
  balloons: number;
};

type DateParts = {
  year: number;
  month: number;
  day: number;
};

export function getKstDateParts(date = new Date()): DateParts & { hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
  };
}

function getPreviousCalendarDate(date: DateParts): DateParts {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  utc.setUTCDate(utc.getUTCDate() - 1);

  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

function getPreviousPeriod(date: DateParts) {
  return date.month === 1
    ? { year: date.year - 1, month: 12 }
    : { year: date.year, month: date.month - 1 };
}

function extractDailyBalloons(data: unknown): DailyBalloon[] {
  if (typeof data !== "object" || data === null) {
    return [];
  }

  const daily = (data as { d?: unknown }).d;

  if (!Array.isArray(daily)) {
    return [];
  }

  return daily
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      day: Number(item.d) || 0,
      balloons: Number(item.b) || 0,
    }));
}

function hasDailyEntry(daily: DailyBalloon[], day: number) {
  return daily.some((entry) => entry.day === day);
}

function getDailyBalloonsForDay(daily: DailyBalloon[], day: number) {
  return daily.find((entry) => entry.day === day)?.balloons ?? 0;
}

function getDisplayDayBalloons(
  currentMonthDaily: DailyBalloon[],
  previousMonthDaily: DailyBalloon[] | null,
  displayDate: DateParts,
) {
  const todayHasEntry = hasDailyEntry(currentMonthDaily, displayDate.day);
  const todayBalloons = todayHasEntry
    ? getDailyBalloonsForDay(currentMonthDaily, displayDate.day)
    : null;

  // 풍투는 다음 방송일 슬롯을 0으로 미리 두는 경우가 있다.
  // 오늘 항목이 없거나 0이면, 방송 시작 전으로 보고 전일 값을 쓴다.
  if (todayBalloons != null && todayBalloons > 0) {
    return todayBalloons;
  }

  const previousDate = getPreviousCalendarDate(displayDate);

  if (previousDate.month === displayDate.month) {
    return getDailyBalloonsForDay(currentMonthDaily, previousDate.day);
  }

  if (previousMonthDaily) {
    return getDailyBalloonsForDay(previousMonthDaily, previousDate.day);
  }

  return 0;
}

async function fetchPoongDetail(userId: string, year: number, month: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = `${POONG_DETAIL_URL}?id=${encodeURIComponent(userId)}&year=${year}&month=${month}`;
    const response = await fetch(url, {
      headers: poongHeaders,
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDisplayDayBalloons(userId: string): Promise<LiveDayBalloonEntry> {
  const trimmed = userId.trim();

  if (!trimmed) {
    return { user_id: userId, day_balloons: 0 };
  }

  const displayDate = getKstDateParts();
  const currentPeriod = { year: displayDate.year, month: displayDate.month };
  const currentData = await fetchPoongDetail(trimmed, currentPeriod.year, currentPeriod.month);
  const currentDaily = extractDailyBalloons(currentData);

  const previousDate = getPreviousCalendarDate(displayDate);
  let previousMonthDaily: DailyBalloon[] | null = null;

  if (previousDate.month !== displayDate.month) {
    const previousPeriod = getPreviousPeriod(displayDate);
    const previousData = await fetchPoongDetail(
      trimmed,
      previousPeriod.year,
      previousPeriod.month,
    );
    previousMonthDaily = extractDailyBalloons(previousData);
  }

  return {
    user_id: trimmed.toLowerCase(),
    day_balloons: getDisplayDayBalloons(currentDaily, previousMonthDaily, displayDate),
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

export async function fetchLiveDayBalloons(userIds: string[]): Promise<LiveDayBalloonEntry[]> {
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

  const unique = Array.from(originalByLower.values()).slice(0, 80);

  return mapWithConcurrency(unique, CONCURRENCY, fetchDisplayDayBalloons);
}
