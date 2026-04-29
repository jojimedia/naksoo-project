"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import MobileCrewCard from "./mobile-crew-card";
import StreamerMemberRow from "./streamer-member-row";

const PROFILE_FALLBACK_URL =
  "https://res.sooplive.com/images/svg/thumb_profile.svg";

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

type CrewKing = NaksooGod;
type CrewBodyMode = "members" | "gods" | "kings";

type CrewCardData = {
  rank: number;
  crew_name: string;
  member_count: number;
  current_total_balloons: number;
  average_current_balloons: number;
  members: CrewMember[];
  naksoo_gods: NaksooGod[];
  crew_kings: CrewKing[];
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
      className={`flex min-h-[76px] flex-col items-center justify-center rounded-2xl border px-2 py-2 text-center md:min-h-[74px] lg:min-h-[72px] min-[1800px]:min-h-[82px] ${colorClass}`}
    >
      <p className="text-[12px] font-semibold text-slate-400 md:text-[12px] min-[1800px]:text-sm">
        {label}
      </p>
      <p className="mt-1 text-[22px] font-black leading-none tabular-nums md:text-[22px] lg:text-[20px] xl:text-[21px] 2xl:text-[23px] min-[1800px]:text-[26px]">
        {formatNumber(value)}
      </p>
    </div>
  );
}

function CrewCardHeader({
  crew,
  theme,
}: {
  crew: CrewCardData;
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

      <div className="mt-4 grid grid-cols-2 items-center gap-2">
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

function PatronRow({ patron }: { patron: NaksooGod | CrewKing }) {
  const [profileSrc, setProfileSrc] = useState(patron.profile_image_url);
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border-t border-white/[0.04]">
      <div className="grid min-h-[74px] grid-cols-[24px_40px_minmax(0,1fr)_112px] grid-rows-[16px_26px_17px] items-center gap-x-2 gap-y-1 px-1 py-2.5 md:grid-cols-[24px_40px_minmax(0,1fr)_106px] lg:grid-cols-[24px_40px_minmax(0,1fr)_104px] xl:grid-cols-[24px_40px_minmax(0,1fr)_108px] 2xl:grid-cols-[26px_42px_minmax(0,1fr)_120px] min-[1800px]:grid-cols-[30px_46px_minmax(0,1fr)_136px]">
        <p className="row-span-2 row-start-2 self-center text-center text-[16px] font-black leading-none tabular-nums text-slate-500 xl:text-[16px] min-[1800px]:text-[17px]">
          {patron.rank}
        </p>
        <div className="row-span-2 row-start-2 self-center">
          <Image
            src={profileSrc}
            alt=""
            width={48}
            height={48}
            unoptimized
            onError={() => setProfileSrc(PROFILE_FALLBACK_URL)}
            className="h-10 w-10 rounded-full border border-white/10 bg-slate-800 object-cover xl:h-10 xl:w-10 min-[1800px]:h-11 min-[1800px]:w-11"
          />
        </div>

        <p className="col-start-4 row-start-1 self-end text-right text-[13px] font-black leading-none tabular-nums text-amber-300 xl:text-[14px] min-[1800px]:text-[15px]">
          {patron.all_targets.length}명
        </p>
        <button
          type="button"
          className="col-start-3 row-start-2 block min-w-0 cursor-pointer truncate text-left text-[18px] font-extrabold leading-none text-slate-100 hover:text-amber-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 xl:text-[19px] 2xl:text-[19px] min-[1800px]:text-[22px]"
          aria-expanded={isOpen}
          aria-label={`${patron.nickname} 후원 대상 ${isOpen ? "접기" : "열기"}`}
          onClick={() => setIsOpen((current) => !current)}
        >
          {patron.nickname}
        </button>
        <p className="col-start-4 row-start-2 text-right text-[20px] font-black leading-none whitespace-nowrap tabular-nums text-sky-300 xl:text-[21px] 2xl:text-[22px] min-[1800px]:text-[26px]">
          {formatNumber(patron.total_balloons)}
        </p>

        <p className="col-start-3 row-start-3 truncate text-[14px] font-extrabold leading-none text-sky-200 xl:text-[15px] min-[1800px]:text-[16px]">
          {patron.max_target_nickname}
        </p>
        <p className="col-start-4 row-start-3 truncate text-right text-[13px] font-extrabold leading-none whitespace-nowrap tabular-nums text-slate-400 xl:text-[14px] min-[1800px]:text-[15px]">
          몰빵 {patron.max_target_rate.toFixed(1)}%
        </p>
      </div>

      {isOpen ? <NaksooTargetRanking targets={patron.all_targets} /> : null}
    </div>
  );
}

function NaksooTargetRanking({ targets }: { targets: NaksooGodTarget[] }) {
  return (
    <div className="mx-1 mb-3 rounded-2xl border border-white/[0.07] bg-slate-900/80 px-3 py-3 shadow-inner shadow-black/25">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-black text-slate-100">후원 대상</p>
        <p className="text-xs font-bold text-slate-500">전체 {targets.length}명</p>
      </div>

      <div className="space-y-1.5">
        {targets.map((target, index) => (
          <div
            key={`${index + 1}-${target.nickname}`}
            className="grid min-h-9 grid-cols-[34px_minmax(0,1fr)_104px] items-center gap-2 rounded-xl bg-white/[0.035] px-2.5 py-1.5"
          >
            <p className="text-center text-sm font-black tabular-nums text-slate-500">
              {index + 1}
            </p>
            <p className="min-w-0 truncate text-[15px] font-extrabold text-slate-100">
              {target.nickname}
            </p>
            <p className="text-right text-[15px] font-black tabular-nums text-amber-300">
              {formatNumber(target.balloons)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function CrewCardBody({ crew }: { crew: CrewCardData }) {
  const [mode, setMode] = useState<CrewBodyMode>("members");
  const [showFormula, setShowFormula] = useState(false);
  // 카드 본문은 같은 공간에서 스트리머, 낙수의 신, 큰손 랭킹 목록만 전환한다.
  const rows = useMemo(
    () => {
      if (mode === "gods") {
        return crew.naksoo_gods.map((god) => (
          <PatronRow key={`god-${god.rank}-${god.user_id}`} patron={god} />
        ));
      }

      if (mode === "kings") {
        return crew.crew_kings.map((king) => (
          <PatronRow key={`king-${king.rank}-${king.user_id}`} patron={king} />
        ));
      }

      return crew.members.map((member) => (
        <StreamerMemberRow key={member.user_id} member={member} />
      ));
    },
    [crew.members, crew.naksoo_gods, crew.crew_kings, mode],
  );
  const emptyMessage =
    mode === "kings"
      ? "큰손 랭킹 없음"
      : mode === "gods"
        ? "낙수의 신 없음"
        : "크루원 데이터 없음";
  const activeCount =
    mode === "kings"
      ? crew.crew_kings.length
      : mode === "gods"
        ? crew.naksoo_gods.length
        : crew.member_count;

  return (
    <div className="bg-slate-950 px-2.5 py-4">
      <div className="relative mb-2 flex items-center justify-between px-1">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={`rounded-full border px-3 py-1.5 text-xs font-black transition-colors ${
              mode === "gods"
                ? "border-amber-300/40 bg-amber-300/15 text-amber-200"
                : "border-white/10 bg-white/[0.03] text-slate-400 hover:border-amber-300/30 hover:text-amber-200"
            }`}
            aria-pressed={mode === "gods"}
            onClick={() => {
              setShowFormula(false);
              setMode((current) => (current === "gods" ? "members" : "gods"));
            }}
          >
            낙수의 신
          </button>

          <button
            type="button"
            className={`rounded-full border px-3 py-1.5 text-xs font-black transition-colors ${
              mode === "kings"
                ? "border-amber-300/40 bg-amber-300/15 text-amber-200"
                : "border-white/10 bg-white/[0.03] text-slate-400 hover:border-amber-300/30 hover:text-amber-200"
            }`}
            aria-pressed={mode === "kings"}
            onClick={() => {
              setShowFormula(false);
              setMode((current) => (current === "kings" ? "members" : "kings"));
            }}
          >
            큰손 랭킹
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <p className="text-sm font-black tabular-nums text-slate-500">
            {activeCount}명
          </p>

          {mode === "gods" ? (
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-[10px] font-black text-slate-400 transition-colors hover:border-amber-300/30 hover:text-amber-200"
              aria-label={`낙수의 신 계산식 ${showFormula ? "닫기" : "열기"}`}
              aria-expanded={showFormula}
              onClick={() => setShowFormula((current) => !current)}
            >
              i
            </button>
          ) : null}
        </div>

        {mode === "gods" && showFormula ? (
          <div className="absolute top-9 left-1 z-10 w-[min(330px,calc(100vw-56px))] rounded-2xl border border-amber-300/20 bg-slate-950 p-3 text-xs font-bold leading-5 text-slate-300 shadow-2xl shadow-black/50">
            <div className="mb-2 flex items-center justify-between">
              <p className="font-black text-amber-200">낙수의 신 계산식</p>
              <button
                type="button"
                className="rounded-full px-2 text-sm font-black text-slate-500 hover:text-slate-200"
                aria-label="낙수의 신 계산식 닫기"
                onClick={() => setShowFormula(false)}
              >
                ×
              </button>
            </div>
            <p>월 보정률 = max(월 진행률, 25%)</p>
            <p>총 후원 컷 = max(크루합계 보정값 1%, 크루평균 보정값 15%, 전체평균 보정값 18%)</p>
            <p>개인별 컷 = 전체평균 보정값 1.2%</p>
            <p>대상수 3명 이상, 몰빵 80% 미만, 최대 10명</p>
          </div>
        ) : null}
      </div>

      <div>
        {rows.length > 0 ? (
          rows
        ) : (
          <p className="rounded-2xl border border-white/[0.06] bg-white/[0.03] px-3 py-6 text-center text-sm font-bold text-slate-500">
            {emptyMessage}
          </p>
        )}
      </div>
    </div>
  );
}

export default function CrewCard({
  crew,
  index,
}: {
  crew: CrewCardData;
  index: number;
}) {
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
