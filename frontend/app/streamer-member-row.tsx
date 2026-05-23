"use client";

import { useState } from "react";

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
  broadcast_start: string | null;
  is_live: boolean;
  current_balloons: number;
  previous_balloons: number;
  change_balloons: number;
  change_rate: number;
  display_day_balloons: number;
  monthly_top_fans: Fan[];
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatSignedNumber(value: number) {
  return `${value >= 0 ? "+" : ""}${formatNumber(value)}`;
}

function formatSignedPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
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

function FanRanking({
  fans,
  previousBalloons,
  changeBalloons,
  changeRate,
  todayBalloons,
}: {
  fans: Fan[];
  previousBalloons: number;
  changeBalloons: number;
  changeRate: number;
  todayBalloons: number;
}) {
  const changeColor =
    changeBalloons >= 0 ? "text-[#059669]" : "text-[#dc2626]";

  return (
    <div className="mx-1 mb-3 rounded border border-[#c7c4d6] bg-[#f5f2fd] px-2 py-2">
      <div className="mb-2 grid grid-cols-[0.9fr_1.35fr_0.9fr] gap-1">
        <div className="rounded border border-[#c7c4d6]/70 bg-white px-2 py-1">
          <p className="text-[10px] font-semibold text-[#737686]">전월 별풍</p>
          <p className="mt-0.5 text-xs font-semibold tabular-nums text-[#111827]">
            {formatNumber(previousBalloons)}
          </p>
        </div>
        <div className="min-w-0 rounded border border-[#c7c4d6]/70 bg-white px-1.5 py-1">
          <p className="text-[10px] font-semibold text-[#737686]">
            증감(증감률)
          </p>
          <p
            className={`mt-0.5 whitespace-nowrap text-[11px] font-semibold tabular-nums leading-none ${changeColor}`}
          >
            {formatSignedNumber(changeBalloons)}{" "}
            <span className="text-[9px]">
              ({formatSignedPercent(changeRate)})
            </span>
          </p>
        </div>
        <div className="rounded border border-[#c7c4d6]/70 bg-white px-2 py-1">
          <p className="text-[10px] font-semibold text-[#737686]">
            오늘 별풍선
          </p>
          <p className="mt-0.5 text-xs font-semibold tabular-nums text-[#111827]">
            {formatNumber(todayBalloons)}
          </p>
        </div>
      </div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-extrabold text-[#131b2e]">이달의 후원자</p>
        <p className="text-xs font-bold text-[#737686]">TOP 10</p>
      </div>

      {fans.length > 0 ? (
        <div className="tracking-tighter">
          {fans.map((fan) => (
            <div
              key={`${fan.rank}-${fan.user_id}`}
              className="grid min-h-[26px] grid-cols-[30px_minmax(0,1fr)_96px] items-center gap-1 border-t border-[#c7c4d6]/30 px-0.5 py-0.5 first:border-t-0"
            >
              <p className="text-center text-xs font-extrabold tabular-nums text-[#737686]">
                {fan.rank}
              </p>
              <p className="min-w-0 truncate text-sm font-normal text-[#1b1b23]">
                {fan.nickname}
              </p>
              <p className={`text-right text-[13px] font-semibold tabular-nums ${getScoreColor(fan.balloons)}`}>
                {formatNumber(fan.balloons)}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded border border-[#e2e8f0] bg-white px-3 py-3 text-center text-sm font-bold text-[#737686]">
          후원자 데이터 없음
        </p>
      )}
    </div>
  );
}

export default function StreamerMemberRow({
  member,
  defaultOpen = false,
}: {
  member: CrewMember;
  defaultOpen?: boolean;
}) {
  const [isManuallyOpen, setIsManuallyOpen] = useState(false);
  const isOpen = defaultOpen || isManuallyOpen;

  return (
    <div className="border-b border-[#c7c4d6]/30">
      <div className="grid min-h-[26px] grid-cols-[30px_minmax(0,1fr)_104px] items-center gap-x-1 px-0.5 py-0.5 text-[15px] tracking-tight">
        <p className="text-[#464554] tabular-nums">
          {member.rank}
        </p>

        <button
          type="button"
          className="block min-w-0 cursor-pointer truncate text-left font-normal text-[#1b1b23] hover:text-[#3f3bbd] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#3f3bbd]"
          aria-expanded={isOpen}
          aria-label={`${member.nickname} 이달의 후원자 ${isOpen ? "접기" : "열기"}`}
          onClick={() => setIsManuallyOpen((current) => !current)}
        >
          {member.nickname}
        </button>
        <p className={`text-right font-semibold whitespace-nowrap tabular-nums ${getScoreColor(member.current_balloons)}`}>
          {formatNumber(member.current_balloons)}
        </p>
      </div>

      {isOpen ? (
        <FanRanking
          fans={member.monthly_top_fans}
          previousBalloons={member.previous_balloons}
          changeBalloons={member.change_balloons}
          changeRate={member.change_rate}
          todayBalloons={member.display_day_balloons}
        />
      ) : null}
    </div>
  );
}
