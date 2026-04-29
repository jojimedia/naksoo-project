import Image from "next/image";
import CrewCard from "./crew-card";

const DATA_URL =
  "https://raw.githubusercontent.com/jojimedia/naksoo-project/main/backend/data/result.json";

type DailyBalloons = {
  day: number;
  balloons: number;
};

type Fan = {
  rank: number;
  user_id: string;
  nickname: string;
  balloons: number;
};

type CrewMember = {
  rank: number;
  user_id: string;
  nickname: string;
  profile_image_url: string;
  current_balloons: number;
  previous_balloons: number;
  change_balloons: number;
  change_rate: number;
  display_day_balloons: number;
  current_daily_balloons: DailyBalloons[];
  previous_daily_balloons: DailyBalloons[];
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

type CrewCard = {
  rank: number;
  crew_name: string;
  member_count: number;
  current_total_balloons: number;
  average_current_balloons: number;
  members: CrewMember[];
  naksoo_gods: NaksooGod[];
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

type RankingItem = {
  crew_name: string;
  user_id: string;
  nickname: string;
  profile_image_url: string;
  current_month: MonthlyStats;
  previous_month: MonthlyStats;
  success: boolean;
};

type NaksooResult = {
  created_date: string;
  created_time: string;
  current_period: {
    year: number;
    month: number;
  };
  previous_period: {
    year: number;
    month: number;
  };
  items: RankingItem[];
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

function getDisplayDate() {
  const now = getKstDateParts();
  const displayDate = new Date(Date.UTC(now.year, now.month - 1, now.day, 12));

  if (now.hour < 9) {
    displayDate.setUTCDate(displayDate.getUTCDate() - 1);
  }

  return {
    year: displayDate.getUTCFullYear(),
    month: displayDate.getUTCMonth() + 1,
    day: displayDate.getUTCDate(),
  };
}

function getDailyBalloonsForDisplayDate(
  item: RankingItem,
  result: NaksooResult,
  displayDate: CrewCardData["display_date"],
) {
  const period =
    displayDate.year === result.current_period.year &&
    displayDate.month === result.current_period.month
      ? item.current_month
      : displayDate.year === result.previous_period.year &&
          displayDate.month === result.previous_period.month
        ? item.previous_month
        : null;

  return (
    period?.daily_balloons.find((daily) => daily.day === displayDate.day)
      ?.balloons ?? 0
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
  const fans = new Map<
    string,
    {
      user_id: string;
      nickname: string;
      total_balloons: number;
      targets: Map<string, number>;
    }
  >();

  for (const item of crewItems) {
    for (const fan of item.current_month.fans ?? []) {
      const current = fans.get(fan.nickname) ?? {
        user_id: fan.user_id,
        nickname: fan.nickname,
        total_balloons: 0,
        targets: new Map<string, number>(),
      };

      current.total_balloons += fan.balloons;
      current.targets.set(
        item.nickname,
        (current.targets.get(item.nickname) ?? 0) + fan.balloons,
      );
      fans.set(fan.nickname, current);
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
      profile_image_url: getSoopProfileImageUrl(fan.user_id),
      total_balloons: fan.total_balloons,
      target_count: fan.qualified_target_count,
      max_target_nickname: fan.max_target_nickname,
      max_target_balloons: fan.max_target_balloons,
      max_target_rate: Number(fan.max_target_rate.toFixed(1)),
      all_targets: fan.all_targets,
    }));
}

function makeCrewCardData(result: NaksooResult): CrewCardData {
  const displayDate = getDisplayDate();
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
            current_balloons: current,
            previous_balloons: previous,
            change_balloons: current - previous,
            change_rate: Number(getChangeRate(current, previous).toFixed(1)),
            display_day_balloons: getDailyBalloonsForDisplayDate(
              item,
              result,
              displayDate,
            ),
            current_daily_balloons: item.current_month.daily_balloons,
            previous_daily_balloons: item.previous_month.daily_balloons,
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
  const url = new URL(DATA_URL);
  url.searchParams.set("cache_bust", Date.now().toString());

  const response = await fetch(url.toString(), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
    },
  });

  if (!response.ok) {
    throw new Error(`데이터를 불러오지 못했습니다. (${response.status})`);
  }

  return makeCrewCardData((await response.json()) as NaksooResult);
}

export default async function Home() {
  const data = await getCrewCardData();

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,#1D4ED8_0%,transparent_28%),radial-gradient(circle_at_top_right,#0F766E_0%,transparent_26%),linear-gradient(180deg,#020617_0%,#0F172A_48%,#020617_100%)] text-slate-100">
      <div className="mx-auto max-w-[1920px] px-5 pt-5 pb-10">
        <header className="mb-3 text-center">
          <h1 className="flex items-center justify-center gap-3 text-[28px] font-black tracking-tight text-white md:gap-4 md:text-[42px]">
            <Image
              src="/images/starballoon.png"
              alt=""
              width={72}
              height={72}
              priority
              className="h-10 w-auto object-contain md:h-16"
            />
            <span>크루별 개인 방송 낙수표</span>
          </h1>

          <button className="mt-4 text-base font-medium text-slate-400 md:text-lg">
            {Number(data.created_date.slice(0, 4))}년{" "}
            {Number(data.created_date.slice(5, 7))}월{" "}
            {Number(data.created_date.slice(8, 10))}일{" "}
            {data.created_time.slice(0, 5)} 업데이트 출처: 풍투데이
          </button>
        </header>

        <div className="mx-auto grid max-w-[420px] grid-cols-1 gap-2 md:max-w-[820px] md:grid-cols-2 lg:max-w-[1210px] lg:grid-cols-3 xl:max-w-[1620px] xl:grid-cols-4 2xl:max-w-none 2xl:grid-cols-5">
          {data.crews.map((crew, index) => (
            <CrewCard key={crew.crew_name} crew={crew} index={index} />
          ))}
        </div>

        <footer className="mx-auto mt-8 max-w-[720px] border-t border-white/10 px-2 pt-6 text-center text-sm font-medium text-slate-400">
          <section>
            <h2 className="text-base font-black text-slate-200">문의 / 요청</h2>
            <p className="mt-2">데이터 수정 및 오류 제보는 오픈카톡으로 보내주세요</p>
            <a
              href="https://open.kakao.com/o/gPGWUCsi"
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex rounded-full border border-amber-300/25 bg-amber-300/10 px-4 py-2 text-sm font-black text-amber-200 transition-colors hover:border-amber-300/45 hover:bg-amber-300/15"
            >
              카카오톡 오픈채팅 문의하기
            </a>
          </section>
        </footer>
      </div>
    </main>
  );
}
