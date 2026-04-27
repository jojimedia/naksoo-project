import Image from "next/image";
import MobileCrewCard from "./mobile-crew-card";

const DATA_URL =
  "https://raw.githubusercontent.com/jojimedia/naksoo-project/main/backend/data/result.json";

type DailyBalloons = {
  day: number;
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
};

type CrewCard = {
  rank: number;
  crew_name: string;
  member_count: number;
  current_total_balloons: number;
  previous_total_balloons: number;
  change_balloons: number;
  change_rate: number;
  average_current_balloons: number;
  average_previous_balloons: number;
  top_member: CrewMember | null;
  current_daily_balloons: DailyBalloons[];
  previous_daily_balloons: DailyBalloons[];
  members: CrewMember[];
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

const crewHeaderThemes = [
  {
    header:
      "border-cyan-300/25 bg-linear-to-br from-cyan-950 via-slate-900 to-teal-950 shadow-cyan-950/35",
    rankBadge: "border-cyan-300/35 bg-cyan-300/15 text-cyan-200",
    title: "text-cyan-50",
  },
  {
    header:
      "border-rose-300/25 bg-linear-to-br from-rose-950 via-slate-900 to-orange-950 shadow-rose-950/35",
    rankBadge: "border-rose-300/35 bg-rose-300/15 text-rose-200",
    title: "text-rose-50",
  },
  {
    header:
      "border-violet-300/25 bg-linear-to-br from-violet-950 via-slate-900 to-fuchsia-950 shadow-violet-950/35",
    rankBadge: "border-violet-300/35 bg-violet-300/15 text-violet-200",
    title: "text-violet-50",
  },
  {
    header:
      "border-emerald-300/25 bg-linear-to-br from-emerald-950 via-slate-900 to-lime-950 shadow-emerald-950/35",
    rankBadge: "border-emerald-300/35 bg-emerald-300/15 text-emerald-200",
    title: "text-emerald-50",
  },
  {
    header:
      "border-amber-300/25 bg-linear-to-br from-amber-950 via-slate-900 to-yellow-950 shadow-amber-950/35",
    rankBadge: "border-amber-300/35 bg-amber-300/15 text-amber-200",
    title: "text-amber-50",
  },
];

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatSignedPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function normalizeImageUrl(url: string) {
  return url.startsWith("//") ? `https:${url}` : url;
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

function sumDaily(items: RankingItem[], period: "current_month" | "previous_month") {
  const days = new Map<number, number>();

  for (const item of items) {
    for (const daily of item[period].daily_balloons) {
      days.set(daily.day, (days.get(daily.day) ?? 0) + daily.balloons);
    }
  }

  return Array.from(days.entries())
    .map(([day, balloons]) => ({ day, balloons }))
    .sort((a, b) => a.day - b.day);
}

function makeCrewCardData(result: NaksooResult): CrewCardData {
  const displayDate = getDisplayDate();
  const successfulItems = result.items.filter((item) => item.success);
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
          };
        });
      const currentTotal = members.reduce(
        (sum, member) => sum + member.current_balloons,
        0,
      );
      const previousTotal = members.reduce(
        (sum, member) => sum + member.previous_balloons,
        0,
      );

      return {
        rank: 0,
        crew_name: crewName,
        member_count: members.length,
        current_total_balloons: currentTotal,
        previous_total_balloons: previousTotal,
        change_balloons: currentTotal - previousTotal,
        change_rate: Number(getChangeRate(currentTotal, previousTotal).toFixed(1)),
        average_current_balloons: Math.round(currentTotal / members.length),
        average_previous_balloons: Math.round(previousTotal / members.length),
        top_member: members[0] ?? null,
        current_daily_balloons: sumDaily(crewItems, "current_month"),
        previous_daily_balloons: sumDaily(crewItems, "previous_month"),
        members,
      };
    })
    .sort((a, b) => b.current_total_balloons - a.current_total_balloons)
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

function StatBox({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: "sky" | "emerald";
}) {
  const colorClass =
    color === "sky"
      ? "border-sky-400/15 bg-sky-400/[0.07] text-sky-300"
      : "border-emerald-400/15 bg-emerald-400/[0.07] text-emerald-300";

  return (
    <div
      className={`flex min-h-[82px] flex-col items-center justify-center rounded-2xl border p-2.5 text-center ${colorClass}`}
    >
      <p className="text-xs font-semibold text-slate-400 md:text-sm">
        {label}
      </p>
      <p className="mt-1 text-[24px] font-black leading-none tabular-nums md:text-[28px]">
        {formatNumber(value)}
      </p>
    </div>
  );
}

function ProfileImage({ member }: { member: CrewMember }) {
  return (
    <Image
      src={member.profile_image_url}
      alt=""
      width={48}
      height={48}
      unoptimized
      className="h-11 w-11 rounded-full border border-white/10 bg-slate-800 object-cover xl:h-9 xl:w-9 2xl:h-10 2xl:w-10 min-[1680px]:h-11 min-[1680px]:w-11"
    />
  );
}

function MemberRow({ member }: { member: CrewMember }) {
  const changeColor =
    member.change_balloons >= 0 ? "text-emerald-300" : "text-rose-300";

  return (
    <div className="grid min-h-[78px] grid-cols-[34px_46px_minmax(0,1fr)_150px] grid-rows-[17px_28px_18px] items-center gap-x-2 gap-y-1 border-t border-white/[0.04] px-1 py-2.5 xl:grid-cols-[26px_40px_minmax(0,1fr)_116px] 2xl:grid-cols-[30px_42px_minmax(0,1fr)_128px] min-[1680px]:grid-cols-[34px_46px_minmax(0,1fr)_150px]">
      <p className="row-span-2 row-start-2 self-center text-center text-[18px] font-black leading-none tabular-nums text-slate-500 xl:text-[16px] min-[1680px]:text-[18px]">
        {member.rank}
      </p>
      <div className="row-span-2 row-start-2 self-center">
        <ProfileImage member={member} />
      </div>

      <p
        className={`col-start-4 row-start-1 self-end text-right text-[17px] font-black leading-none tabular-nums xl:text-[14px] 2xl:text-[15px] min-[1680px]:text-[17px] ${changeColor}`}
      >
        {formatSignedPercent(member.change_rate)}
      </p>

      <p className="col-start-3 row-start-2 min-w-0 truncate text-[23px] font-extrabold leading-none text-slate-100 md:text-[24px] xl:text-[18px] 2xl:text-[20px] min-[1680px]:text-[23px]">
        {member.nickname}
      </p>
      <p className="col-start-4 row-start-2 text-right text-[28px] font-black leading-none whitespace-nowrap tabular-nums text-sky-300 xl:text-[21px] 2xl:text-[23px] min-[1680px]:text-[28px]">
        {formatNumber(member.current_balloons)}
      </p>

      <p className="col-start-3 row-start-3 truncate text-[17px] font-extrabold leading-none tabular-nums text-sky-200 xl:text-[14px] 2xl:text-[15px] min-[1680px]:text-[17px]">
        {formatNumber(member.display_day_balloons)}
      </p>
      <p className="col-start-4 row-start-3 truncate text-right text-[16px] font-extrabold leading-none whitespace-nowrap tabular-nums text-slate-400 xl:text-[12px] 2xl:text-[13px] min-[1680px]:text-[16px]">
        지난 달 {formatNumber(member.previous_balloons)}
      </p>
    </div>
  );
}

function CrewCardHeader({
  crew,
  theme,
}: {
  crew: CrewCard;
  theme: (typeof crewHeaderThemes)[number];
}) {
  return (
    <div className={`relative border-b px-4 py-4 shadow-inner ${theme.header}`}>
      <div
        className={`absolute top-4 right-4 rounded-full border px-3 py-1.5 text-sm font-black md:text-base ${theme.rankBadge}`}
      >
        #{crew.rank}
      </div>

      <h2
        className={`px-16 text-center text-2xl font-black tracking-tight md:text-[28px] ${theme.title}`}
      >
        {crew.crew_name}
      </h2>

      <div className="mt-4 grid grid-cols-2 items-center gap-2.5">
        <StatBox label="전체 합계" value={crew.current_total_balloons} color="sky" />
        <StatBox
          label="평균 별풍"
          value={crew.average_current_balloons}
          color="emerald"
        />
      </div>
    </div>
  );
}

function CrewCardBody({ crew }: { crew: CrewCard }) {
  return (
    <div className="bg-slate-950 px-2.5 py-4">
      <div>
        {crew.members.map((member) => (
          <MemberRow key={member.user_id} member={member} />
        ))}
      </div>
    </div>
  );
}

function CrewCard({ crew, index }: { crew: CrewCard; index: number }) {
  const theme = crewHeaderThemes[index % crewHeaderThemes.length];
  const header = <CrewCardHeader crew={crew} theme={theme} />;
  const body = <CrewCardBody crew={crew} />;

  return (
    <>
      <MobileCrewCard header={header} body={body} />

      <section className="hidden overflow-hidden rounded-[28px] bg-slate-950 shadow-2xl shadow-black/30 backdrop-blur-xl md:block">
        {header}
        {body}
      </section>
    </>
  );
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

        <div className="mx-auto grid max-w-[420px] grid-cols-1 gap-2 md:max-w-[820px] md:grid-cols-2 xl:max-w-none xl:grid-cols-5">
          {data.crews.slice(0, 5).map((crew, index) => (
            <CrewCard key={crew.crew_name} crew={crew} index={index} />
          ))}
        </div>
      </div>
    </main>
  );
}
