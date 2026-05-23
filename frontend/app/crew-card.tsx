"use client";

import { CSSProperties, useMemo, useState } from "react";
import MobileCrewCard from "./mobile-crew-card";
import StreamerMemberRow from "./streamer-member-row";

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
  broadcast_start: string | null;
  is_live: boolean;
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

export type CrewCardData = {
  rank: number;
  crew_name: string;
  member_count: number;
  current_total_balloons: number;
  average_current_balloons: number;
  members: CrewMember[];
  naksoo_gods: NaksooGod[];
  crew_kings: CrewKing[];
};

const crewHeaderColors = [
  "#7C3AED",
  "#DB2777",
  "#EF4444",
  "#F59E0B",
  "#10B981",
  "#2563EB",
  "#0891B2",
  "#65A30D",
  "#EA580C",
  "#9333EA",
  "#0F766E",
  "#BE123C",
];

function getCrewHeaderColor(index: number) {
  if (index < crewHeaderColors.length) {
    return crewHeaderColors[index];
  }

  const hue = (index * 137.508 + 262) % 360;

  return `hsl(${Math.round(hue)} 72% 48%)`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function getScoreColor(value: number) {
  if (value >= 1_000_000) {
    return "text-[#dc2626]";
  }

  if (value >= 700_000) {
    return "text-[#059669]";
  }

  if (value >= 500_000) {
    return "text-[#fb923c]";
  }

  return "text-[#111827]";
}

function StatBox({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="flex min-h-[38px] flex-col justify-center rounded bg-black/10 px-1.5 py-1 text-white">
      <p className="text-[9px] font-bold uppercase leading-none opacity-80">
        {label}
      </p>
      <p className="mt-1 text-[17px] font-semibold leading-none tabular-nums">
        {formatNumber(value)}
      </p>
    </div>
  );
}

function CrewCardHeader({
  crew,
  headerColor,
}: {
  crew: CrewCardData;
  headerColor: string;
}) {
  const style = { "--crew-header": headerColor } as CSSProperties;

  return (
    <div className="bg-[var(--crew-header)] p-2.5 text-white" style={style}>
      <div className="mb-1.5 flex items-center justify-between">
        <h2 className="truncate text-[21px] font-semibold leading-7 text-white">
          {crew.crew_name}
        </h2>
        <div className="rounded bg-white/20 px-2 py-0.5 text-[10px] font-semibold leading-4 text-white tabular-nums">
          TOP {crew.rank}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <StatBox
          label="Total Balloons"
          value={crew.current_total_balloons}
        />
        <StatBox
          label="Average Balloons"
          value={crew.average_current_balloons}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[10px] font-semibold leading-none">
          Members: {crew.member_count}
        </span>
      </div>
    </div>
  );
}

function PatronRow({ patron }: { patron: NaksooGod | CrewKing }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="border-b border-[#c7c4d6]/30">
      <div className="grid min-h-[26px] grid-cols-[30px_minmax(0,1fr)_104px] items-center gap-x-1 px-0.5 py-0.5 text-[15px] tracking-tight">
        <p className="text-[#464554] tabular-nums">
          {patron.rank}
        </p>
        <button
          type="button"
          className="block min-w-0 cursor-pointer truncate text-left font-normal text-[#1b1b23] hover:text-[#3f3bbd] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3f3bbd]"
          aria-expanded={isOpen}
          aria-label={`${patron.nickname} 후원 대상 ${isOpen ? "접기" : "열기"}`}
          onClick={() => setIsOpen((current) => !current)}
        >
          {patron.nickname}
        </button>
        <p className={`text-right font-semibold whitespace-nowrap tabular-nums ${getScoreColor(patron.total_balloons)}`}>
          {formatNumber(patron.total_balloons)}
        </p>
      </div>

      {isOpen ? <NaksooTargetRanking targets={patron.all_targets} /> : null}
    </div>
  );
}

function NaksooTargetRanking({ targets }: { targets: NaksooGodTarget[] }) {
  return (
    <div className="mx-1 mb-3 rounded border border-[#c7c4d6] bg-[#f5f2fd] px-2 py-2">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-extrabold text-[#131b2e]">후원 대상</p>
        <p className="text-xs font-bold text-[#737686]">전체 {targets.length}명</p>
      </div>

      <div className="tracking-tighter">
        {targets.map((target, index) => (
          <div
            key={`${index + 1}-${target.nickname}`}
            className="grid min-h-7 grid-cols-[34px_minmax(0,1fr)_96px] items-center gap-1 border-t border-[#c7c4d6]/30 px-0.5 py-0.5 first:border-t-0"
          >
            <p className="text-center text-xs font-extrabold tabular-nums text-[#737686]">
              {index + 1}
            </p>
            <p className="min-w-0 truncate text-sm font-normal text-[#1b1b23]">
              {target.nickname}
            </p>
            <p className={`text-right text-[13px] font-extrabold tabular-nums ${getScoreColor(target.balloons)}`}>
              {formatNumber(target.balloons)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function CrewCardBody({
  crew,
  membersOnly = false,
  expandMembers = false,
}: {
  crew: CrewCardData;
  membersOnly?: boolean;
  expandMembers?: boolean;
}) {
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
        <StreamerMemberRow
          key={member.user_id}
          member={member}
          defaultOpen={expandMembers}
        />
      ));
    },
    [crew.members, crew.naksoo_gods, crew.crew_kings, expandMembers, mode],
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
    <div className="bg-white p-1">
      {membersOnly ? null : (
      <div className="relative mb-1 flex items-center justify-between px-0.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`rounded border px-2.5 py-1 text-[11px] font-bold transition-colors ${
              mode === "gods"
                ? "border-[#bc4800]/40 bg-[#fffbeb] text-[#7d2d00]"
                : "border-[#cbd5e1] bg-white text-[#434655] hover:border-[#bc4800]/40 hover:text-[#7d2d00]"
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
            className={`rounded border px-2.5 py-1 text-[11px] font-bold transition-colors ${
              mode === "kings"
                ? "border-[#004ac6]/40 bg-[#eef2ff] text-[#003ea8]"
                : "border-[#cbd5e1] bg-white text-[#434655] hover:border-[#004ac6]/40 hover:text-[#003ea8]"
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
          <p className="text-xs font-bold tabular-nums text-[#737686]">
            {activeCount}명
          </p>

          {mode === "gods" ? (
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center rounded border border-[#cbd5e1] bg-white text-[10px] font-bold text-[#737686] transition-colors hover:border-[#bc4800]/40 hover:text-[#7d2d00]"
              aria-label={`낙수의 신 계산식 ${showFormula ? "닫기" : "열기"}`}
              aria-expanded={showFormula}
              onClick={() => setShowFormula((current) => !current)}
            >
              i
            </button>
          ) : null}
        </div>

        {mode === "gods" && showFormula ? (
          <div className="absolute top-9 left-1 z-10 w-[min(330px,calc(100vw-56px))] rounded border border-[#cbd5e1] bg-white p-3 text-xs font-bold leading-5 text-[#434655] shadow-lg shadow-slate-200">
            <div className="mb-2 flex items-center justify-between">
              <p className="font-extrabold text-[#7d2d00]">낙수의 신 계산식</p>
              <button
                type="button"
                className="rounded px-2 text-sm font-extrabold text-[#737686] hover:text-[#131b2e]"
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
      )}

      <div className="grid min-h-6 grid-cols-[30px_minmax(0,1fr)_104px] items-center gap-x-1 border-b border-[#c7c4d6] px-0.5 py-0.5 text-[13px] font-semibold tracking-tight text-[#464554]">
        <p>순위</p>
        <p>닉네임</p>
        <p className="text-right">별풍선</p>
      </div>

      <div>
        {rows.length > 0 ? (
          rows
        ) : (
          <p className="rounded border border-[#e2e8f0] bg-[#f8fafc] px-3 py-6 text-center text-sm font-bold text-[#737686]">
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
  membersOnly = false,
  expandMembers = false,
}: {
  crew: CrewCardData;
  index: number;
  membersOnly?: boolean;
  expandMembers?: boolean;
}) {
  const headerColor = getCrewHeaderColor(index);
  const header = <CrewCardHeader crew={crew} headerColor={headerColor} />;
  const body = (
    <CrewCardBody
      crew={crew}
      membersOnly={membersOnly}
      expandMembers={expandMembers}
    />
  );

  return (
    <>
      <MobileCrewCard header={header} body={body} forceOpen={expandMembers} />

      <section className="hidden overflow-hidden rounded-xl border border-[#c7c4d6] bg-white transition-all duration-300 hover:shadow-xl md:block">
        {header}
        {body}
      </section>
    </>
  );
}
