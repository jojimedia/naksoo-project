import { readFile } from "fs/promises";
import path from "path";

import CrewDashboard from "./crew-dashboard";

const GITHUB_REPO = "jojimedia/naksoo-project";
const GITHUB_DATA_REF = process.env.GITHUB_DATA_REF ?? "main";
const REMOTE_DATA_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_DATA_REF}/backend/data/result.json`;
const LOCAL_DATA_PATHS = [
  path.join(process.cwd(), "..", "backend", "data", "result.json"),
  path.join(process.cwd(), "public", "data", "result.json"),
];

function useLocalDataInDev(): boolean {
  if (process.env.NAKSOO_USE_LOCAL_DATA === "1") return true;
  if (process.env.NAKSOO_USE_LOCAL_DATA === "0") return false;
  return process.env.NODE_ENV === "development";
}

async function loadLocalResult(): Promise<RawNaksooResult | null> {
  for (const filePath of LOCAL_DATA_PATHS) {
    try {
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw) as RawNaksooResult;
    } catch {
      continue;
    }
  }
  return null;
}

export const dynamic = "force-dynamic";

type DailyBalloons = {
  day: number;
  balloons: number;
};

type Fan = {
  rank: number;
  user_id: string;
  nickname: string;
  profile_image_url?: string | null;
  balloons: number;
};

type CrewMember = {
  rank: number;
  user_id: string;
  nickname: string;
  profile_image_url: string;
  broadcast_start: string | null;
  is_live: boolean;
  current_balloons: number;
  previous_balloons: number;
  change_balloons: number;
  change_rate: number;
  display_day_balloons: number;
  current_daily_balloons: DailyBalloons[];
  previous_daily_balloons: DailyBalloons[];
  monthly_fans: Fan[];
  monthly_top_fans: Fan[];
};

type NaksooGodTarget = {
  nickname: string;
  balloons: number;
};

type NaksooGod = {
  rank: number;
  user_id: string;
  nickname: string;
  profile_image_url: string;
  total_balloons: number;
  target_count: number;
  max_target_nickname: string;
  max_target_balloons: number;
  max_target_rate: number;
  all_targets: NaksooGodTarget[];
};

type CrewKing = NaksooGod;

type CrewCard = {
  rank: number;
  crew_name: string;
  member_count: number;
  current_total_balloons: number;
  average_current_balloons: number;
  members: CrewMember[];
  naksoo_gods: NaksooGod[];
  crew_kings: CrewKing[];
};

type CrewCardData = {
  created_date: string;
  created_time: string;
  display_date: {
    year: number;
    month: number;
    day: number;
  };
  current_period: {
    year: number;
    month: number;
  };
  previous_period: {
    year: number;
    month: number;
  };
  crews: CrewCard[];
};

type MonthlyStats = {
  year: number;
  month: number;
  total_balloons: number;
  daily_balloons: DailyBalloons[];
  fans?: Omit<Fan, "rank">[];
};

type Period = {
  year: number;
  month: number;
};

type RankingItem = {
  crew_name: string;
  user_id: string;
  nickname: string;
  profile_image_url: string;
  broadcast_start?: string | null;
  is_live?: boolean;
  is_password_broadcast?: boolean;
  current_month: MonthlyStats;
  previous_month: MonthlyStats;
  success: boolean;
};

type NaksooResult = {
  created_date: string;
  created_time: string;
  current_period: Period;
  previous_period: Period;
  items: RankingItem[];
};

type RawNaksooResult = Partial<Omit<NaksooResult, "items">> & {
  items?: Partial<RankingItem>[];
};

function normalizeImageUrl(url: string) {
  return url.startsWith("//") ? `https:${url}` : url;
}

function getSoopProfileImageUrl(userId: string) {
  const prefix = userId.slice(0, 2);

  return `https://stimg.sooplive.com/LOGO/${prefix}/${userId}/m/${userId}.webp`;
}

function getChangeRate(current: number, previous: number) {
  if (previous === 0) {
    return current > 0 ? 100 : 0;
  }

  return ((current - previous) / previous) * 100;
}

function getKstDateParts(date = new Date()) {
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

function getDisplayDate(now = getKstDateParts()) {
  return {
    year: now.year,
    month: now.month,
    day: now.day,
  };
}

function getPreviousPeriod(period: Period) {
  return period.month === 1
    ? { year: period.year - 1, month: 12 }
    : { year: period.year, month: period.month - 1 };
}

function formatDateParts(
  date: Pick<ReturnType<typeof getKstDateParts>, "year" | "month" | "day">,
) {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNumber(value: unknown, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}

function isPeriod(value: unknown): value is Period {
  return (
    isRecord(value) &&
    Number.isFinite(Number(value.year)) &&
    Number.isFinite(Number(value.month))
  );
}

function normalizeDailyBalloons(value: unknown): DailyBalloons[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((daily) => ({
      day: toNumber(daily.day),
      balloons: toNumber(daily.balloons),
    }));
}

function normalizeFans(value: unknown): Omit<Fan, "rank">[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map((fan) => ({
    user_id: String(fan.user_id ?? ""),
    nickname: String(fan.nickname ?? fan.user_id ?? ""),
    profile_image_url:
      typeof fan.profile_image_url === "string" ? fan.profile_image_url : null,
    balloons: toNumber(fan.balloons),
  }));
}

function normalizeMonthlyStats(
  value: unknown,
  fallbackPeriod: Period,
): MonthlyStats {
  const stats = isRecord(value) ? value : {};

  return {
    year: toNumber(stats.year, fallbackPeriod.year),
    month: toNumber(stats.month, fallbackPeriod.month),
    total_balloons: toNumber(stats.total_balloons),
    daily_balloons: normalizeDailyBalloons(stats.daily_balloons),
    fans: normalizeFans(stats.fans),
  };
}

function normalizeRankingItem(
  value: Partial<RankingItem>,
  currentPeriod: Period,
  previousPeriod: Period,
): RankingItem | null {
  if (!value.success) {
    return null;
  }

  const userId = String(value.user_id ?? "");
  const crewName = String(value.crew_name ?? "");

  if (!userId || !crewName) {
    return null;
  }

  return {
    crew_name: crewName,
    user_id: userId,
    nickname: String(value.nickname ?? userId),
    profile_image_url:
      typeof value.profile_image_url === "string" && value.profile_image_url
        ? value.profile_image_url
        : getSoopProfileImageUrl(userId),
    broadcast_start:
      typeof value.broadcast_start === "string" ? value.broadcast_start : null,
    is_live: Boolean(value.is_live),
    is_password_broadcast: Boolean(value.is_password_broadcast),
    current_month: normalizeMonthlyStats(value.current_month, currentPeriod),
    previous_month: normalizeMonthlyStats(value.previous_month, previousPeriod),
    success: true,
  };
}

function normalizeResult(raw: RawNaksooResult): NaksooResult {
  const now = getKstDateParts();
  const fallbackCurrentPeriod = { year: now.year, month: now.month };
  const currentPeriod = isPeriod(raw.current_period)
    ? {
        year: toNumber(raw.current_period.year, fallbackCurrentPeriod.year),
        month: toNumber(raw.current_period.month, fallbackCurrentPeriod.month),
      }
    : fallbackCurrentPeriod;
  const previousPeriod = isPeriod(raw.previous_period)
    ? {
        year: toNumber(
          raw.previous_period.year,
          getPreviousPeriod(currentPeriod).year,
        ),
        month: toNumber(
          raw.previous_period.month,
          getPreviousPeriod(currentPeriod).month,
        ),
      }
    : getPreviousPeriod(currentPeriod);
  const items = Array.isArray(raw.items)
    ? raw.items
        .map((item) => normalizeRankingItem(item, currentPeriod, previousPeriod))
        .filter((item): item is RankingItem => item !== null)
    : [];

  return {
    created_date:
      typeof raw.created_date === "string"
        ? raw.created_date
        : formatDateParts(now),
    created_time:
      typeof raw.created_time === "string" ? raw.created_time : "00:00:00",
    current_period: currentPeriod,
    previous_period: previousPeriod,
    items,
  };
}

function parseKstDateTime(value?: string | null) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (!match) {
    return null;
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function getDailyBalloonsForDate(
  period: MonthlyStats | null,
  day: number,
) {
  return period?.daily_balloons.find((daily) => daily.day === day)?.balloons ?? 0;
}

function getMonthlyStatsForDate(
  item: RankingItem,
  result: NaksooResult,
  date: Pick<ReturnType<typeof getKstDateParts>, "year" | "month" | "day">,
) {
  return date.year === result.current_period.year &&
    date.month === result.current_period.month
      ? item.current_month
      : date.year === result.previous_period.year &&
          date.month === result.previous_period.month
        ? item.previous_month
        : null;
}

function getDailyBalloonsForDisplayDate(
  item: RankingItem,
  result: NaksooResult,
) {
  const targetDate =
    item.is_live && item.broadcast_start
      ? parseKstDateTime(item.broadcast_start)
      : null;

  if (!targetDate) {
    return 0;
  }

  return getDailyBalloonsForDate(
    getMonthlyStatsForDate(item, result, targetDate),
    targetDate.day,
  );
}

function getMonthlyTopFans(item: RankingItem) {
  return [...(item.current_month.fans ?? [])]
    .sort((a, b) => b.balloons - a.balloons)
    .slice(0, 10)
    .map((fan, index) => ({
      rank: index + 1,
      user_id: fan.user_id,
      nickname: fan.nickname,
      balloons: fan.balloons,
    }));
}

function getNaksooThresholds(
  successfulItems: RankingItem[],
  result: NaksooResult,
) {
  if (successfulItems.length === 0) {
    return {
      correctionRate: 1,
      totalFloor: 0,
      perTargetThreshold: 0,
    };
  }

  const dataDay = Number(result.created_date.slice(8, 10));
  const daysInMonth = new Date(
    result.current_period.year,
    result.current_period.month,
    0,
  ).getDate();
  const monthProgress = dataDay / daysInMonth;
  const correctionRate = Math.max(monthProgress, 0.25);
  const overallTotal = successfulItems.reduce(
    (sum, item) => sum + item.current_month.total_balloons,
    0,
  );
  const overallAverage = overallTotal / successfulItems.length;
  const adjustedOverallAverage = overallAverage / correctionRate;

  // 월초 데이터가 너무 작게 잡히지 않도록 전체 평균을 월 진행률로 보정한다.
  return {
    correctionRate,
    totalFloor: Math.round(adjustedOverallAverage * 0.18),
    perTargetThreshold: Math.round(adjustedOverallAverage * 0.012),
  };
}

function getFanDisplayNicknames(crewItems: RankingItem[]) {
  const nicknames = new Map<
    string,
    {
      nickname: string;
      balloons: number;
    }
  >();

  for (const item of crewItems) {
    for (const fan of item.current_month.fans ?? []) {
      const key = fan.user_id || fan.nickname;
      const current = nicknames.get(key);

      if (!current || fan.balloons > current.balloons) {
        nicknames.set(key, {
          nickname: fan.nickname,
          balloons: fan.balloons,
        });
      }
    }
  }

  return new Map(
    Array.from(nicknames.entries()).map(([key, value]) => [
      key,
      value.nickname,
    ]),
  );
}

function getNaksooGods(
  crewItems: RankingItem[],
  thresholds: ReturnType<typeof getNaksooThresholds>,
) {
  const crewTotal = crewItems.reduce(
    (sum, item) => sum + item.current_month.total_balloons,
    0,
  );
  const crewAverage = crewTotal / crewItems.length;
  const adjustedCrewTotal = crewTotal / thresholds.correctionRate;
  const adjustedCrewAverage = crewAverage / thresholds.correctionRate;
  // 낙신 선정 컷: 크루 규모 컷과 전체 평균 기반 하한을 함께 적용한다.
  const totalThreshold = Math.round(
    Math.max(
      adjustedCrewTotal * 0.01,
      adjustedCrewAverage * 0.15,
      thresholds.totalFloor,
    ),
  );
  const displayNicknames = getFanDisplayNicknames(crewItems);
  const fans = new Map<
    string,
    {
      user_id: string;
      nickname: string;
      profile_image_url?: string | null;
      total_balloons: number;
      targets: Map<string, number>;
    }
  >();

  for (const item of crewItems) {
    for (const fan of item.current_month.fans ?? []) {
      const key = fan.user_id || fan.nickname;
      const current = fans.get(key) ?? {
        user_id: fan.user_id,
        nickname: displayNicknames.get(key) ?? fan.nickname,
        profile_image_url: fan.profile_image_url,
        total_balloons: 0,
        targets: new Map<string, number>(),
      };

      current.profile_image_url ??= fan.profile_image_url;
      current.total_balloons += fan.balloons;
      current.targets.set(
        item.nickname,
        (current.targets.get(item.nickname) ?? 0) + fan.balloons,
      );
      fans.set(key, current);
    }
  }

  // 선정은 개인별 컷 이상 대상수로 판단하되, 상세는 크루 내 전체 후원 분포를 보여준다.
  return Array.from(fans.values())
    .map((fan) => {
      const targets = Array.from(fan.targets.entries()).sort((a, b) => b[1] - a[1]);
      const qualifiedTargets = targets.filter(
        ([, balloons]) => balloons >= thresholds.perTargetThreshold,
      );
      const maxTarget = targets[0] ?? ["", 0];
      const maxTargetRate =
        fan.total_balloons > 0 ? (maxTarget[1] / fan.total_balloons) * 100 : 0;

      return {
        ...fan,
        target_count: qualifiedTargets.length,
        max_target_nickname: maxTarget[0],
        max_target_balloons: maxTarget[1],
        max_target_rate: maxTargetRate,
        qualified_target_count: qualifiedTargets.length,
        all_targets: targets.map(([nickname, balloons]) => ({
          nickname,
          balloons,
        })),
      };
    })
    .filter(
      (fan) =>
        fan.total_balloons >= totalThreshold &&
        fan.qualified_target_count >= 3 &&
        fan.max_target_rate < 80,
    )
    .sort((a, b) => b.total_balloons - a.total_balloons)
    .slice(0, 10)
    .map((fan, index) => ({
      rank: index + 1,
      user_id: fan.user_id,
      nickname: fan.nickname,
      profile_image_url:
        fan.profile_image_url ?? getSoopProfileImageUrl(fan.user_id),
      total_balloons: fan.total_balloons,
      target_count: fan.qualified_target_count,
      max_target_nickname: fan.max_target_nickname,
      max_target_balloons: fan.max_target_balloons,
      max_target_rate: Number(fan.max_target_rate.toFixed(1)),
      all_targets: fan.all_targets,
    }));
}

function getCrewKings(crewItems: RankingItem[]) {
  const displayNicknames = getFanDisplayNicknames(crewItems);
  const fans = new Map<
    string,
    {
      user_id: string;
      nickname: string;
      profile_image_url?: string | null;
      total_balloons: number;
      targets: Map<string, number>;
    }
  >();

  for (const item of crewItems) {
    for (const fan of item.current_month.fans ?? []) {
      const key = fan.user_id || fan.nickname;
      const current = fans.get(key) ?? {
        user_id: fan.user_id,
        nickname: displayNicknames.get(key) ?? fan.nickname,
        profile_image_url: fan.profile_image_url,
        total_balloons: 0,
        targets: new Map<string, number>(),
      };

      current.profile_image_url ??= fan.profile_image_url;
      current.total_balloons += fan.balloons;
      current.targets.set(
        item.nickname,
        (current.targets.get(item.nickname) ?? 0) + fan.balloons,
      );
      fans.set(key, current);
    }
  }

  return Array.from(fans.values())
    .map((fan) => {
      const targets = Array.from(fan.targets.entries()).sort((a, b) => b[1] - a[1]);
      const maxTarget = targets[0] ?? ["", 0];
      const maxTargetRate =
        fan.total_balloons > 0 ? (maxTarget[1] / fan.total_balloons) * 100 : 0;

      return {
        ...fan,
        target_count: targets.length,
        max_target_nickname: maxTarget[0],
        max_target_balloons: maxTarget[1],
        max_target_rate: maxTargetRate,
        all_targets: targets.map(([nickname, balloons]) => ({
          nickname,
          balloons,
        })),
      };
    })
    .sort((a, b) => b.total_balloons - a.total_balloons)
    .slice(0, 15)
    .map((fan, index) => ({
      rank: index + 1,
      user_id: fan.user_id,
      nickname: fan.nickname,
      profile_image_url:
        fan.profile_image_url ?? getSoopProfileImageUrl(fan.user_id),
      total_balloons: fan.total_balloons,
      target_count: fan.target_count,
      max_target_nickname: fan.max_target_nickname,
      max_target_balloons: fan.max_target_balloons,
      max_target_rate: Number(fan.max_target_rate.toFixed(1)),
      all_targets: fan.all_targets,
    }));
}

function makeCrewCardData(result: NaksooResult): CrewCardData {
  const now = getKstDateParts();
  const displayDate = getDisplayDate(now);
  const successfulItems = result.items.filter((item) => item.success);
  const naksooThresholds = getNaksooThresholds(successfulItems, result);
  const crewNames = Array.from(
    new Set(successfulItems.map((item) => item.crew_name)),
  );
  const crews = crewNames
    .map((crewName) => {
      const crewItems = successfulItems.filter(
        (item) => item.crew_name === crewName,
      );
      const members = crewItems
        .sort(
          (a, b) =>
            b.current_month.total_balloons - a.current_month.total_balloons,
        )
        .map((item, index) => {
          const current = item.current_month.total_balloons;
          const previous = item.previous_month.total_balloons;

          return {
            rank: index + 1,
            user_id: item.user_id,
            nickname: item.nickname,
            profile_image_url: normalizeImageUrl(item.profile_image_url),
            broadcast_start: item.broadcast_start ?? null,
            is_live: item.is_live ?? false,
            current_balloons: current,
            previous_balloons: previous,
            change_balloons: current - previous,
            change_rate: Number(getChangeRate(current, previous).toFixed(1)),
            display_day_balloons: getDailyBalloonsForDisplayDate(
              item,
              result,
            ),
            current_daily_balloons: item.current_month.daily_balloons,
            previous_daily_balloons: item.previous_month.daily_balloons,
            monthly_fans: (item.current_month.fans ?? []).map((fan, fanIndex) => ({
              rank: fanIndex + 1,
              user_id: fan.user_id,
              nickname: fan.nickname,
              profile_image_url: fan.profile_image_url,
              balloons: fan.balloons,
            })),
            monthly_top_fans: getMonthlyTopFans(item),
          };
        });
      const currentTotal = members.reduce(
        (sum, member) => sum + member.current_balloons,
        0,
      );

      return {
        rank: 0,
        crew_name: crewName,
        member_count: members.length,
        current_total_balloons: currentTotal,
        average_current_balloons: Math.round(currentTotal / members.length),
        members,
        naksoo_gods: getNaksooGods(crewItems, naksooThresholds),
        crew_kings: getCrewKings(crewItems),
      };
    })
    .sort((a, b) => b.average_current_balloons - a.average_current_balloons)
    .map((crew, index) => ({ ...crew, rank: index + 1 }));

  return {
    created_date: result.created_date,
    created_time: result.created_time,
    display_date: displayDate,
    current_period: result.current_period,
    previous_period: result.previous_period,
    crews,
  };
}

async function getCrewCardData() {
  const emptyData = () => makeCrewCardData(normalizeResult({ items: [] }));

  if (useLocalDataInDev()) {
    const local = await loadLocalResult();
    if (local) {
      return makeCrewCardData(normalizeResult(local));
    }
  }

  try {
    const response = await fetch(REMOTE_DATA_URL, {
      cache: "no-store",
      next: { revalidate: 0 },
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
      },
    });

    if (!response.ok) {
      return emptyData();
    }

    return makeCrewCardData(
      normalizeResult((await response.json()) as RawNaksooResult),
    );
  } catch {
    return emptyData();
  }
}

export default async function Home() {
  const data = await getCrewCardData();

  return <CrewDashboard data={data} />;
}
