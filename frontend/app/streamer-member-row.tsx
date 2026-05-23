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

function HighlightText({ text, query }: { text: string; query: string }) {
  const keyword = query.trim();
  const index = keyword
    ? text.toLowerCase().indexOf(keyword.toLowerCase())
    : -1;

  if (index < 0) {
    return text;
  }

  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded bg-[#fbbf24]/20 px-0.5 text-[#fbbf24]">
        {text.slice(index, index + keyword.length)}
      </mark>
      {text.slice(index + keyword.length)}
    </>
  );
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

  return "text-[#e5e7eb]";
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
    <div className="mx-1 mb-3 rounded border border-[#3a3548] bg-[#211e2b] px-2 py-2">
      <div className="mb-2 grid grid-cols-[0.9fr_1.35fr_0.9fr] gap-1">
        <div className="rounded border border-[#3a3548] bg-[#17151f] px-2 py-1">
          <p className="text-[10px] font-semibold text-[#a8a2b8]">전월 별풍</p>
          <p className="mt-0.5 text-xs font-semibold tabular-nums text-[#e5e7eb]">
            {formatNumber(previousBalloons)}
          </p>
        </div>
        <div className="min-w-0 rounded border border-[#3a3548] bg-[#17151f] px-1.5 py-1">
          <p className="text-[10px] font-semibold text-[#a8a2b8]">
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
        <div className="rounded border border-[#3a3548] bg-[#17151f] px-2 py-1">
          <p className="text-[10px] font-semibold text-[#a8a2b8]">
            오늘 별풍선
          </p>
          <p className="mt-0.5 text-xs font-semibold tabular-nums text-[#e5e7eb]">
            {formatNumber(todayBalloons)}
          </p>
        </div>
      </div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-extrabold text-[#e5e7eb]">이달의 후원자</p>
        <p className="text-xs font-bold text-[#a8a2b8]">TOP 10</p>
      </div>

      {fans.length > 0 ? (
        <div className="tracking-tighter">
          {fans.map((fan) => (
            <div
              key={`${fan.rank}-${fan.user_id}`}
              className="grid min-h-[27px] grid-cols-[30px_minmax(0,1fr)_104px] items-center gap-1 border-t border-[#3a3548]/70 px-0.5 py-0.5 text-[15px] first:border-t-0"
            >
              <p className="text-center text-xs font-extrabold tabular-nums text-[#a8a2b8]">
                {fan.rank}
              </p>
              <p className="min-w-0 truncate text-sm font-normal text-[#e5e7eb]">
                {fan.nickname}
              </p>
              <p className={`text-right text-[13px] font-semibold tabular-nums ${getScoreColor(fan.balloons)}`}>
                {formatNumber(fan.balloons)}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded border border-[#3a3548] bg-[#17151f] px-3 py-3 text-center text-sm font-bold text-[#a8a2b8]">
          후원자 데이터 없음
        </p>
      )}
    </div>
  );
}

export default function StreamerMemberRow({
  member,
  defaultOpen = false,
  searchQuery = "",
}: {
  member: CrewMember;
  defaultOpen?: boolean;
  searchQuery?: string;
}) {
  const [isManuallyOpen, setIsManuallyOpen] = useState(false);
  const isOpen = defaultOpen || isManuallyOpen;

  return (
    <div className="border-b border-[#3a3548]/70">
      <div className="grid min-h-[27px] grid-cols-[30px_minmax(0,1fr)_112px] items-center gap-x-1 px-0.5 py-0.5 text-[16px] tracking-tight">
        <p className="text-[#a8a2b8] tabular-nums">
          {member.rank}
        </p>

        <button
          type="button"
          className="block min-w-0 cursor-pointer truncate text-left font-normal text-[#e5e7eb] hover:text-[#a99cff] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#a99cff]"
          aria-expanded={isOpen}
          aria-label={`${member.nickname} 이달의 후원자 ${isOpen ? "접기" : "열기"}`}
          onClick={() => setIsManuallyOpen((current) => !current)}
        >
          <HighlightText text={member.nickname} query={searchQuery} />
        </button>
        <p className={`text-right font-semibold whitespace-nowrap tabular-nums ${getScoreColor(member.current_balloons)}`}>
          {formatNumber(member.current_balloons)}
        </p>
      </div>

      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
          isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          <FanRanking
            fans={member.monthly_top_fans}
            previousBalloons={member.previous_balloons}
            changeBalloons={member.change_balloons}
            changeRate={member.change_rate}
            todayBalloons={member.display_day_balloons}
          />
        </div>
      </div>
    </div>
  );
}
