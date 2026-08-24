"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import CountUp from "react-countup";

export type ExternalLiveSummary = {
  session: { id: number; title: string; status: string; scope: string };
  totals: { totalBalloons: number; eventCount: number; donorCount: number };
  members: Array<{
    streamerId: number;
    streamerName: string;
    receivedBalloons: number;
    donorCount: number;
    donors: Array<{
      userId: string;
      nickname: string;
      totalBalloons: number;
      giftCount: number;
      onePlusOneApplied: boolean;
    }>;
  }>;
  donors: Array<{
    userId: string;
    nickname: string;
    totalBalloons: number;
    giftCount: number;
  }>;
  quality: { unassignedBalloons: number; noAssignmentEventCount: number };
  updatedAt: string;
};

export default function ExternalLiveSummaryModal({
  summary,
  onClose,
}: {
  summary: ExternalLiveSummary;
  onClose: () => void;
}) {
  const [selectedMemberId, setSelectedMemberId] = useState<number | null>(null);
  const [rankingMode, setRankingMode] = useState<"members" | "donors">("members");
  const members = useMemo(
    () => [...summary.members].sort((a, b) => b.receivedBalloons - a.receivedBalloons),
    [summary.members],
  );
  const topDonors = useMemo(
    () => [...summary.donors]
      .sort((a, b) => b.totalBalloons - a.totalBalloons)
      .slice(0, 20),
    [summary.donors],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="live-scoreboard-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="max-h-[calc(100vh-24px)] w-full max-w-[520px] overflow-y-auto rounded-xl border border-[#4b455c] bg-[#17151f] shadow-2xl shadow-black/60">
        <header className="sticky top-0 z-10 bg-[#DC2626] p-3 text-white">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="mb-1 text-[11px] font-bold tracking-wide text-white/75">광우상사 LIVE SCOREBOARD</p>
              <h2 id="live-scoreboard-title" className="break-words text-[15px] leading-5 font-bold">{summary.session.title || "오늘 방송"}</h2>
            </div>
            <button type="button" className="grid h-7 w-7 place-items-center rounded-full bg-black/15 text-xl leading-none hover:bg-black/25" aria-label="점수판 닫기" onClick={onClose}>×</button>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            <Stat label="총 별풍선" value={summary.totals.totalBalloons} />
            <Stat label="후원자" value={summary.totals.donorCount} suffix="명" />
            <Stat label="후원 횟수" value={summary.totals.eventCount} suffix="회" />
          </div>
        </header>

        <div className="p-2">
          <div className="mb-1 flex items-center gap-1 px-1">
            <button type="button" className={`rounded px-2 py-1 text-sm font-extrabold transition ${rankingMode === "members" ? "bg-[#dc2626]/20 text-[#fca5a5]" : "text-[#a8a2b8] hover:text-[#e5e7eb]"}`} aria-pressed={rankingMode === "members"} onClick={() => setRankingMode("members")}>스트리머 순위</button>
            <button type="button" className={`rounded px-2 py-1 text-sm font-extrabold transition ${rankingMode === "donors" ? "bg-[#dc2626]/20 text-[#fca5a5]" : "text-[#a8a2b8] hover:text-[#e5e7eb]"}`} aria-pressed={rankingMode === "donors"} onClick={() => setRankingMode("donors")}>후원 순위</button>
            {rankingMode === "donors" ? <span className="ml-auto text-[11px] font-semibold text-[#8d879c]">TOP 20</span> : null}
          </div>
          <div className="grid grid-cols-[42px_minmax(0,1fr)_100px] border-b border-[#3a3548] px-1 py-1 text-xs font-semibold text-[#a8a2b8]"><p>순위</p><p>닉네임</p><p className="text-right">별풍선</p></div>
          {rankingMode === "members" ? members.map((member, index) => <StreamerRankingRow key={member.streamerId} member={member} rank={index + 1} open={selectedMemberId === member.streamerId} onToggle={() => setSelectedMemberId((current) => current === member.streamerId ? null : member.streamerId)} />) : topDonors.map((donor, index) => <div key={donor.userId || `${donor.nickname}-${index}`} className="grid grid-cols-[42px_minmax(0,1fr)_100px] items-center border-b border-[#3a3548]/70 px-1 py-2 text-[15px]"><p className="font-bold tabular-nums text-[#a8a2b8]">{index + 1}</p><p className="min-w-0 truncate font-bold text-[#e5e7eb]">{donor.nickname}<span className="ml-1 text-[10px] font-semibold text-[#8d879c]">{donor.giftCount}회</span></p><p className="text-right font-extrabold tabular-nums text-[#e5e7eb]"><AnimatedNumber value={donor.totalBalloons} /></p></div>)}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function StreamerRankingRow({
  member,
  rank,
  open,
  onToggle,
}: {
  member: ExternalLiveSummary["members"][number];
  rank: number;
  open: boolean;
  onToggle: () => void;
}) {
  const previousScoreRef = useRef(member.receivedBalloons);
  const [isScoreUpdated, setIsScoreUpdated] = useState(false);

  useEffect(() => {
    if (previousScoreRef.current === member.receivedBalloons) {
      return;
    }

    const hasIncreased = member.receivedBalloons > previousScoreRef.current;
    previousScoreRef.current = member.receivedBalloons;

    if (!hasIncreased) {
      return;
    }

    setIsScoreUpdated(true);
    const timerId = window.setTimeout(() => setIsScoreUpdated(false), 520);
    return () => window.clearTimeout(timerId);
  }, [member.receivedBalloons]);

  return <div>
    <button type="button" className={`grid w-full grid-cols-[42px_minmax(0,1fr)_100px] items-center border-b border-[#3a3548]/70 px-1 py-2 text-left text-[15px] transition hover:bg-white/5 ${open ? "bg-[#dc2626]/10" : ""} ${isScoreUpdated ? "animate-[pulse_0.52s_ease-out] bg-[#fbbf24]/20" : ""}`} aria-expanded={open} onClick={onToggle}>
      <span className="font-bold tabular-nums text-[#a8a2b8]">{rank}</span>
      <span className="min-w-0 truncate font-bold text-[#e5e7eb]">{member.streamerName}<small className="ml-1 text-[11px] font-semibold text-[#8d879c]">{member.donorCount}명</small></span>
      <span className="text-right font-extrabold tabular-nums text-[#e5e7eb]"><AnimatedNumber value={member.receivedBalloons} /></span>
    </button>
    {open ? <MemberDonorPanel member={member} /> : null}
  </div>;
}

function MemberDonorPanel({ member }: { member: ExternalLiveSummary["members"][number] }) {
  const donors = [...member.donors].sort((a, b) => b.totalBalloons - a.totalBalloons);

  return <div className="mx-1 mb-2 rounded-lg border border-[#3a3548] bg-[#211e2b] p-2">
    <div className="mb-2 flex items-center justify-between gap-2"><p className="font-extrabold text-[#e5e7eb]">{member.streamerName} 후원자 순위</p><p className="text-xs font-bold text-[#a8a2b8]">전체 {donors.length}명</p></div>
    <div className="grid grid-cols-[40px_minmax(0,1fr)_94px] border-b border-[#3a3548] px-1 py-1 text-xs font-semibold text-[#a8a2b8]"><p>순위</p><p>닉네임</p><p className="text-right">별풍선</p></div>
    {donors.length > 0 ? donors.map((donor, index) => <div key={donor.userId || `${donor.nickname}-${index}`} className="grid grid-cols-[40px_minmax(0,1fr)_94px] items-center border-b border-[#3a3548]/70 px-1 py-1.5 text-sm"><p className="font-bold text-[#a8a2b8]">{index + 1}</p><p className="min-w-0 truncate font-semibold text-[#e5e7eb]">{donor.nickname}<span className="ml-1 text-[10px] text-[#8d879c]">{donor.giftCount}회{donor.onePlusOneApplied ? " · 1+1" : ""}</span></p><p className="text-right font-bold tabular-nums text-[#e5e7eb]"><AnimatedNumber value={donor.totalBalloons} /></p></div>) : <p className="py-4 text-center text-sm font-semibold text-[#8d879c]">후원자 데이터가 없습니다.</p>}
  </div>;
}

function Stat({ label, value, suffix = "" }: { label: string; value: number; suffix?: string }) {
  return <div className="rounded bg-black/15 px-2 py-1.5"><p className="text-[10px] font-bold text-white/75">{label}</p><p className="mt-1 text-[16px] font-extrabold leading-none tabular-nums"><AnimatedNumber value={value} />{suffix}</p></div>;
}

function AnimatedNumber({ value }: { value: number }) {
  const previousValueRef = useRef(value);
  const [animation, setAnimation] = useState<{
    start: number;
    end: number;
    key: number;
  } | null>(null);

  useEffect(() => {
    if (previousValueRef.current === value) {
      return;
    }

    const hasIncreased = value > previousValueRef.current;
    const start = previousValueRef.current;
    previousValueRef.current = value;

    if (hasIncreased) {
      setAnimation({ start, end: value, key: Date.now() });
    } else {
      setAnimation(null);
    }
  }, [value]);

  if (!animation) {
    return <>{new Intl.NumberFormat("ko-KR").format(value)}</>;
  }

  return <CountUp key={animation.key} start={animation.start} end={animation.end} duration={0.7} useEasing separator="," onEnd={() => setAnimation(null)} />;
}
