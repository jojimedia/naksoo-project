"use client";

import { useEffect, useState } from "react";

import { FanRanking } from "./streamer-member-row";
import { useLiveInfo } from "./live-status-context";

type Fan = {
  rank: number;
  user_id: string;
  nickname: string;
  balloons: number;
};

type LiveThumbnailCardProps = {
  member: {
    user_id: string;
    nickname: string;
    rank: number;
    previous_balloons: number;
    change_balloons: number;
    change_rate: number;
  };
  crewName: string;
  crewColor: string;
  broadcastBalloons: number;
  donors: Fan[];
  liveBroadcastMode: boolean;
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function formatElapsed(broadStartMs: number) {
  const minutesTotal = Math.max(
    0,
    Math.floor((Date.now() - broadStartMs) / 60_000),
  );
  const hours = Math.floor(minutesTotal / 60);
  const minutes = minutesTotal % 60;

  return `${pad2(hours)}:${pad2(minutes)}`;
}

function useElapsedLabel(broadStartMs: number | null | undefined) {
  const [label, setLabel] = useState(() =>
    broadStartMs != null ? formatElapsed(broadStartMs) : null,
  );

  useEffect(() => {
    if (broadStartMs == null) {
      setLabel(null);
      return;
    }

    const startMs = broadStartMs;

    function tick() {
      setLabel(formatElapsed(startMs));
    }

    tick();
    const timerId = window.setInterval(tick, 1000);
    return () => window.clearInterval(timerId);
  }, [broadStartMs]);

  return label;
}

function buildProfileImageUrl(userId: string) {
  const trimmed = userId.trim();

  if (!trimmed) {
    return null;
  }

  const prefix = trimmed.slice(0, 2).toLowerCase();

  return `https://profile.img.sooplive.co.kr/LOGO/${prefix}/${trimmed}/${trimmed}.jpg`;
}

export default function LiveThumbnailCard({
  member,
  crewName,
  crewColor,
  broadcastBalloons,
  donors,
  liveBroadcastMode,
}: LiveThumbnailCardProps) {
  const liveInfo = useLiveInfo(member.user_id);
  const elapsedLabel = useElapsedLabel(liveInfo?.broadStartMs);
  const [expanded, setExpanded] = useState(false);
  const streamUrl = `https://play.sooplive.co.kr/${encodeURIComponent(member.user_id)}`;
  const profileUrl = buildProfileImageUrl(member.user_id);
  const thumbnailUrl = liveInfo?.thumbnailUrl
    ? `${liveInfo.thumbnailUrl}?t=${Math.floor(Date.now() / 60_000)}`
    : null;

  return (
    <article className="flex h-full flex-col overflow-hidden rounded-xl border border-[#3a3548] bg-[#17151f] shadow-sm">
      <a
        href={streamUrl}
        target="_blank"
        rel="noreferrer"
        className="group relative block aspect-video overflow-hidden bg-[#111018]"
        aria-label={`${member.nickname} 방송 보기`}
      >
        {thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl}
            alt={`${member.nickname} 라이브 썸네일`}
            className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.03]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[#211e2b] text-sm font-semibold text-[#a8a2b8]">
            LIVE
          </div>
        )}

        <span className="absolute top-2 left-2 inline-flex items-center gap-1 rounded bg-black/70 px-2 py-1 text-[11px] font-bold text-white">
          <span className="h-1.5 w-1.5 rounded-full bg-[#ef4444]" aria-hidden="true" />
          <span className="tabular-nums">
            {liveInfo?.viewerCount != null
              ? formatNumber(liveInfo.viewerCount)
              : "—"}
          </span>
        </span>

        {elapsedLabel ? (
          <span className="absolute top-2 right-2 rounded bg-black/70 px-2 py-1 text-[11px] font-bold tabular-nums text-white">
            {elapsedLabel}
          </span>
        ) : null}

        <span className="absolute right-2 bottom-2 rounded bg-black/70 px-2 py-1 text-[11px] font-bold tabular-nums text-white">
          별풍선 {formatNumber(broadcastBalloons)}
        </span>
      </a>

      <div className="flex min-h-0 flex-1 flex-col p-2.5">
        <div className="flex gap-2.5">
          <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full bg-[#2b2836] ring-1 ring-[#3a3548]">
            {profileUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={profileUrl}
                alt=""
                className="h-full w-full object-cover"
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                }}
              />
            ) : null}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <p className="truncate text-[14px] font-bold text-[#e5e7eb]">
                  {member.nickname}
                </p>
                <span
                  className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none text-white"
                  style={{ backgroundColor: crewColor }}
                >
                  {crewName}
                </span>
              </div>
              <span className="shrink-0 text-[11px] font-semibold tabular-nums text-[#8d879c]">
                #{member.rank}
              </span>
            </div>
            <p className="mt-0.5 line-clamp-2 min-h-[2.5rem] text-[12px] leading-snug text-[#a8a2b8]">
              {liveInfo?.title?.trim() || "방송 제목 없음"}
            </p>
          </div>
        </div>

        <button
          type="button"
          className="mt-2.5 w-full rounded-lg border border-[#3a3548] bg-[#211e2b] px-2.5 py-1.5 text-[12px] font-semibold text-[#d8d4e5] transition hover:border-[#5b4bdb] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#a99cff]"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded
            ? "후원자 접기"
            : `이번 방송 후원자보기(${donors.length}명)`}
        </button>

        <div
          className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
            expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
          }`}
        >
          <div className="overflow-hidden">
            <div className="pt-2">
              <FanRanking
                fans={donors}
                previousBalloons={member.previous_balloons}
                changeBalloons={member.change_balloons}
                changeRate={member.change_rate}
                todayBalloons={broadcastBalloons}
                liveBroadcastMode={liveBroadcastMode}
                fanPanelTitle="이번 방송 후원자"
              />
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
