"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useIsLive, useLiveInfo } from "./live-status-context";

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
  monthly_fans: Fan[];
  monthly_top_fans: Fan[];
  is_on_leave?: boolean;
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

function getScoreTone(value: number) {
  if (value >= 1_000_000) {
    return {
      row: "bg-[#F87171]/72",
      muted: "text-[#fecdd3]",
      name: "text-[#fff7f8]",
      score: "text-[#fff7f8]",
    };
  }

  if (value >= 700_000) {
    return {
      row: "bg-[#FACC15]/72",
      muted: "text-[#fde68a]",
      name: "text-[#fffbeb]",
      score: "text-[#fffbeb]",
    };
  }

  if (value >= 500_000) {
    return {
      row: "bg-[#22D3EE]/72",
      muted: "text-[#a5f3fc]",
      name: "text-[#ecfeff]",
      score: "text-[#ecfeff]",
    };
  }

  if (value >= 200_000) {
    return {
      row: "bg-[#C4B5FD]/72",
      muted: "text-[#ddd6fe]",
      name: "text-[#f5f3ff]",
      score: "text-[#f5f3ff]",
    };
  }

  return {
    row: "",
    muted: "text-[#a8a2b8]",
    name: "text-[#e5e7eb]",
    score: "text-[#e5e7eb]",
  };
}

function FanRow({ fan }: { fan: Fan }) {
  const tone = getScoreTone(fan.balloons);

  return (
    <div
      className={`grid min-h-[27px] grid-cols-[30px_minmax(0,1fr)_104px] items-center gap-1 rounded border-t border-[#3a3548]/70 px-0.5 py-0.5 text-[15px] first:border-t-0 ${tone.row}`}
    >
      <p className={`text-center text-xs font-extrabold tabular-nums ${tone.muted}`}>
        {fan.rank}
      </p>
      <p className={`min-w-0 truncate text-sm font-semibold ${tone.name}`}>
        {fan.nickname}
      </p>
      <p className={`text-right text-[13px] font-bold tabular-nums ${tone.score}`}>
        {formatNumber(fan.balloons)}
      </p>
    </div>
  );
}

function LiveBadge({
  userId,
  nickname,
  thumbnailUrl,
  title,
}: {
  userId: string;
  nickname: string;
  thumbnailUrl: string | null;
  title: string | null;
}) {
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const [preview, setPreview] = useState<{
    top: number;
    left: number;
    src: string;
  } | null>(null);

  useEffect(() => {
    if (!preview) {
      return;
    }

    function hide() {
      setPreview(null);
    }

    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);

    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [preview]);

  function showPreview() {
    if (!thumbnailUrl || !anchorRef.current) {
      return;
    }

    const rect = anchorRef.current.getBoundingClientRect();
    const previewHeight = title ? 168 : 132;
    const spaceBelow = window.innerHeight - rect.bottom;
    const top =
      spaceBelow < previewHeight && rect.top > previewHeight
        ? rect.top - previewHeight - 8
        : rect.bottom + 8;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2, 118),
      window.innerWidth - 118,
    );

    setPreview({
      top,
      left,
      src: `${thumbnailUrl}?t=${Date.now()}`,
    });
  }

  return (
    <>
      <a
        ref={anchorRef}
        href={`https://play.sooplive.co.kr/${encodeURIComponent(userId)}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex shrink-0 items-center rounded border border-white/85 px-1 py-px text-[9px] font-semibold leading-none tracking-wide text-white/90 no-underline hover:bg-white/10"
        aria-label={`${nickname} 방송국 열기`}
        onMouseEnter={showPreview}
        onMouseLeave={() => setPreview(null)}
        onFocus={showPreview}
        onBlur={() => setPreview(null)}
      >
        LIVE
      </a>
      {preview
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[80] w-[220px] -translate-x-1/2 overflow-hidden rounded-lg border border-[#4b455c] bg-[#17151f] shadow-xl shadow-black/50"
              style={{ top: preview.top, left: preview.left }}
              role="tooltip"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={preview.src}
                alt={`${nickname} 라이브 썸네일`}
                className="aspect-video w-full bg-[#111018] object-cover"
              />
              {title ? (
                <p className="line-clamp-2 px-2 py-1.5 text-[11px] font-semibold leading-snug text-[#e5e7eb]">
                  {title}
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
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
        <div className="flex min-h-[44px] flex-col justify-between rounded border border-[#3a3548] bg-[#17151f] px-2 py-1">
          <p className="h-3 text-[10px] font-semibold leading-3 text-[#a8a2b8]">
            전월 별풍
          </p>
          <p className="h-4 text-xs font-semibold leading-4 tabular-nums text-[#e5e7eb]">
            {formatNumber(previousBalloons)}
          </p>
        </div>
        <div className="flex min-h-[44px] min-w-0 flex-col justify-between rounded border border-[#3a3548] bg-[#17151f] px-1.5 py-1">
          <p className="h-3 text-[10px] font-semibold leading-3 text-[#a8a2b8]">
            증감(증감률)
          </p>
          <p
            className={`h-4 whitespace-nowrap text-[11px] font-semibold leading-4 tabular-nums ${changeColor}`}
          >
            {formatSignedNumber(changeBalloons)}{" "}
            <span className="text-[9px]">
              ({formatSignedPercent(changeRate)})
            </span>
          </p>
        </div>
        <div className="flex min-h-[44px] flex-col justify-between rounded border border-[#3a3548] bg-[#17151f] px-2 py-1">
          <p className="h-3 text-[10px] font-semibold leading-3 text-[#a8a2b8]">
            오늘 별풍선
          </p>
          <p className="h-4 text-xs font-semibold leading-4 tabular-nums text-[#e5e7eb]">
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
            <FanRow key={`${fan.rank}-${fan.user_id}`} fan={fan} />
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
  showCrew = false,
  crewName,
  crewColor,
  disableScoreTone = false,
}: {
  member: CrewMember;
  defaultOpen?: boolean;
  searchQuery?: string;
  showCrew?: boolean;
  crewName?: string;
  crewColor?: string;
  disableScoreTone?: boolean;
}) {
  const [isManuallyOpen, setIsManuallyOpen] = useState(false);
  const isLive = useIsLive(member.user_id);
  const liveInfo = useLiveInfo(member.user_id);
  const isOnLeave = member.is_on_leave === true;
  const showLive = !isOnLeave && isLive;
  const isOpen = !isOnLeave && (defaultOpen || isManuallyOpen);
  const tone =
    disableScoreTone || isOnLeave
      ? {
          row: isOnLeave ? "opacity-60" : "",
          muted: "text-[#a8a2b8]",
          name: isOnLeave ? "text-[#fbbf24]" : "text-[#e5e7eb]",
          score: "text-[#a8a2b8]",
        }
      : getScoreTone(member.current_balloons);
  const rowColumns = showCrew
    ? "grid-cols-[34px_92px_minmax(0,1fr)_78px]"
    : "grid-cols-[30px_minmax(0,1fr)_112px]";
  const rowGap = showCrew ? "gap-x-3" : "gap-x-0.5";

  return (
    <div className="border-b border-[#3a3548]/70">
      <div
        className={`grid min-h-[27px] ${rowColumns} ${rowGap} items-center rounded px-0.5 py-0.5 text-[16px] tracking-tight transition hover:ring-1 hover:ring-white/35 ${tone.row}`}
      >
        <p className={`font-semibold tabular-nums ${tone.muted}`}>
          {isOnLeave ? "—" : member.rank}
        </p>

        {showCrew ? (
          <p
            className="min-w-0 truncate rounded px-1.5 py-0.5 text-center text-[11px] font-bold leading-4 text-white"
            style={{ backgroundColor: crewColor ?? "#5b4bdb" }}
            title={crewName}
          >
            {crewName}
          </p>
        ) : null}

        {isOnLeave ? (
          <p className={`min-w-0 truncate font-semibold ${tone.name}`}>
            <HighlightText text={member.nickname} query={searchQuery} />
            <span className="ml-1 text-[11px] text-[#fbbf24]">휴직</span>
          </p>
        ) : (
          <div className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              className={`min-w-0 truncate text-left font-semibold hover:underline hover:decoration-current hover:underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#a99cff] ${tone.name}`}
              aria-expanded={isOpen}
              aria-label={`${member.nickname}${showLive ? " 방송중" : ""} 이달의 후원자 ${isOpen ? "접기" : "열기"}`}
              onClick={() => setIsManuallyOpen((current) => !current)}
            >
              <HighlightText text={member.nickname} query={searchQuery} />
            </button>
            {showLive ? (
              <LiveBadge
                userId={member.user_id}
                nickname={member.nickname}
                thumbnailUrl={liveInfo?.thumbnailUrl ?? null}
                title={liveInfo?.title ?? null}
              />
            ) : null}
          </div>
        )}
        <p className={`text-right font-bold whitespace-nowrap tabular-nums ${tone.score}`}>
          {isOnLeave ? "—" : formatNumber(member.current_balloons)}
        </p>
      </div>

      {!isOnLeave ? (
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
      ) : null}
    </div>
  );
}
