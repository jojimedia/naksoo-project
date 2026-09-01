"use client";

import {
  CSSProperties,
  SyntheticEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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
  monthly_fans: Fan[];
  monthly_top_fans: Fan[];
  is_on_leave?: boolean;
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

export function getCrewHeaderColor(index: number) {
  if (index < crewHeaderColors.length) {
    return crewHeaderColors[index];
  }

  const hue = (index * 137.508 + 262) % 360;

  return `hsl(${Math.round(hue)} 72% 48%)`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
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

function StatBox({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="flex min-h-[38px] flex-col justify-center rounded bg-black/10 px-1.5 py-1 text-white">
      <p className="text-[10px] font-bold leading-none opacity-80">{label}</p>
      <p className="mt-1 text-[18px] font-semibold leading-none tabular-nums">
        {formatNumber(value)}
      </p>
    </div>
  );
}

const TRIMMED_AVERAGE_TIP =
  "크루의 평균적인 풍력을 정확하게 보기 위해 최고·최저 1명씩 제외하고 구한 평균입니다.";

function TrimmedAverageStat({ value }: { value: number }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const tipButtonRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [tipPos, setTipPos] = useState<{ top: number; left: number } | null>(
    null,
  );

  useEffect(() => {
    if (!open) {
      setTipPos(null);
      return;
    }

    function placeTip() {
      const button = tipButtonRef.current;

      if (!button) {
        return;
      }

      const rect = button.getBoundingClientRect();
      const tipWidth = Math.min(220, window.innerWidth - 24);
      const left = Math.min(
        Math.max(rect.right - tipWidth, 12),
        window.innerWidth - tipWidth - 12,
      );
      const estimatedHeight = 72;
      const spaceBelow = window.innerHeight - rect.bottom;
      const top =
        spaceBelow < estimatedHeight + 8 && rect.top > estimatedHeight + 8
          ? rect.top - estimatedHeight - 8
          : rect.bottom + 8;

      setTipPos({ top, left });
    }

    placeTip();

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null;

      if (
        rootRef.current?.contains(target) ||
        tipRef.current?.contains(target)
      ) {
        return;
      }

      setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", placeTip);
    window.addEventListener("scroll", placeTip, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", placeTip);
      window.removeEventListener("scroll", placeTip, true);
    };
  }, [open]);

  function toggleTip(event: SyntheticEvent) {
    event.preventDefault();
    event.stopPropagation();
    setOpen((current) => !current);
  }

  return (
    <div
      ref={rootRef}
      className="group relative flex min-h-[38px] flex-col justify-center rounded bg-black/10 px-1.5 py-1 text-white"
    >
      <div className="flex items-center gap-1">
        <p className="text-[10px] font-bold leading-none opacity-80">절사평균</p>
        <span
          ref={tipButtonRef}
          role="button"
          tabIndex={0}
          className="flex h-3.5 w-3.5 shrink-0 cursor-help items-center justify-center rounded-full border border-white/45 text-[9px] font-bold leading-none text-white/90"
          aria-label="절사평균 설명"
          aria-expanded={open}
          onClick={toggleTip}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              toggleTip(event);
            }
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          ?
        </span>
      </div>
      <p className="mt-1 text-[18px] font-semibold leading-none tabular-nums">
        {formatNumber(value)}
      </p>

      {/* 모바일: 카드 overflow에 잘리지 않게 portal로 표시 */}
      {open && tipPos
        ? createPortal(
            <div
              ref={tipRef}
              className="fixed z-[80] w-[min(220px,calc(100vw-24px))] rounded-lg border border-white/20 bg-[#17151f]/95 px-2.5 py-2 text-[11px] font-semibold leading-4 text-[#e5e7eb] shadow-lg shadow-black/40 md:hidden"
              style={{ top: tipPos.top, left: tipPos.left }}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {TRIMMED_AVERAGE_TIP}
            </div>,
            document.body,
          )
        : null}

      {/* 데스크톱: 호버 시 표시 */}
      <div className="pointer-events-none absolute top-[calc(100%+4px)] right-0 z-30 hidden w-[min(220px,calc(100vw-48px))] rounded-lg border border-white/20 bg-[#17151f]/95 px-2.5 py-2 text-[11px] font-semibold leading-4 text-[#e5e7eb] opacity-0 shadow-lg shadow-black/40 transition-opacity group-hover:opacity-100 md:block">
        {TRIMMED_AVERAGE_TIP}
      </div>
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
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 className="truncate text-[22px] font-semibold leading-7 text-white">{crew.crew_name}</h2>
        </div>
        <div className="rounded bg-white/20 px-2 py-0.5 text-[10px] font-semibold leading-4 text-white tabular-nums">
          TOP {crew.rank}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <StatBox label="전체합계" value={crew.current_total_balloons} />
        <TrimmedAverageStat value={crew.average_current_balloons} />
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
  const tone = getScoreTone(patron.total_balloons);

  return (
    <div className="border-b border-[#3a3548]/70">
      <div
        className={`grid min-h-[27px] grid-cols-[30px_minmax(0,1fr)_112px] items-center gap-x-1 rounded px-0.5 py-0.5 text-[16px] tracking-tight transition hover:ring-1 hover:ring-white/35 ${tone.row}`}
      >
        <p className={`font-semibold tabular-nums ${tone.muted}`}>
          {patron.rank}
        </p>
        <button
          type="button"
          className={`block min-w-0 cursor-pointer truncate text-left font-semibold hover:underline hover:decoration-current hover:underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#a99cff] ${tone.name}`}
          aria-expanded={isOpen}
          aria-label={`${patron.nickname} 후원 대상 ${isOpen ? "접기" : "열기"}`}
          onClick={() => setIsOpen((current) => !current)}
        >
          {patron.nickname}
        </button>
        <p className={`text-right font-bold whitespace-nowrap tabular-nums ${tone.score}`}>
          {formatNumber(patron.total_balloons)}
        </p>
      </div>

      {isOpen ? <NaksooTargetRanking targets={patron.all_targets} /> : null}
    </div>
  );
}

function NaksooTargetRanking({ targets }: { targets: NaksooGodTarget[] }) {
  return (
    <div className="mx-1 mb-3 rounded border border-[#3a3548] bg-[#211e2b] px-2 py-2">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-extrabold text-[#e5e7eb]">후원 대상</p>
        <p className="text-xs font-bold text-[#a8a2b8]">전체 {targets.length}명</p>
      </div>

      <div className="tracking-tighter">
        {targets.map((target, index) => (
          <NaksooTargetRow
            key={`${index + 1}-${target.nickname}`}
            target={target}
            rank={index + 1}
          />
        ))}
      </div>
    </div>
  );
}

function NaksooTargetRow({
  target,
  rank,
}: {
  target: NaksooGodTarget;
  rank: number;
}) {
  const tone = getScoreTone(target.balloons);

  return (
    <div
      className={`grid min-h-7 grid-cols-[34px_minmax(0,1fr)_104px] items-center gap-1 border-t border-[#3a3548]/70 px-0.5 py-0.5 first:border-t-0 ${tone.row}`}
    >
      <p className={`text-center text-xs font-extrabold tabular-nums ${tone.muted}`}>
        {rank}
      </p>
      <p className={`min-w-0 truncate text-sm font-semibold ${tone.name}`}>
        {target.nickname}
      </p>
      <p className={`text-right text-[13px] font-extrabold tabular-nums ${tone.score}`}>
        {formatNumber(target.balloons)}
      </p>
    </div>
  );
}

function CrewCardBody({
  crew,
  membersOnly = false,
  expandMembers = false,
  searchQuery = "",
}: {
  crew: CrewCardData;
  membersOnly?: boolean;
  expandMembers?: boolean;
  searchQuery?: string;
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

      return crew.members.map((member, memberIndex) => (
        <StreamerMemberRow
          key={`${crew.crew_name}-${member.user_id}-${memberIndex}`}
          member={member}
          defaultOpen={expandMembers}
          searchQuery={searchQuery}
        />
      ));
    },
    [crew.crew_name, crew.members, crew.naksoo_gods, crew.crew_kings, expandMembers, mode, searchQuery],
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
    <div className="bg-[#17151f] p-1">
      {membersOnly ? null : (
      <div className="relative mb-1 flex items-center justify-between px-0.5">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`rounded border px-2.5 py-1 text-[11px] font-bold transition-colors ${
              mode === "gods"
                ? "border-[#f59e0b]/40 bg-[#f59e0b]/10 text-[#fbbf24]"
                : "border-[#3a3548] bg-[#17151f] text-[#a8a2b8] hover:border-[#f59e0b]/40 hover:text-[#fbbf24]"
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
                ? "border-[#60a5fa]/40 bg-[#60a5fa]/10 text-[#93c5fd]"
                : "border-[#3a3548] bg-[#17151f] text-[#a8a2b8] hover:border-[#60a5fa]/40 hover:text-[#93c5fd]"
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
          <p className="text-xs font-bold tabular-nums text-[#a8a2b8]">
            {activeCount}명
          </p>

          {mode === "gods" ? (
            <button
              type="button"
              className="flex h-5 w-5 items-center justify-center rounded border border-[#3a3548] bg-[#17151f] text-[10px] font-bold text-[#a8a2b8] transition-colors hover:border-[#f59e0b]/40 hover:text-[#fbbf24]"
              aria-label={`낙수의 신 계산식 ${showFormula ? "닫기" : "열기"}`}
              aria-expanded={showFormula}
              onClick={() => setShowFormula((current) => !current)}
            >
              i
            </button>
          ) : null}
        </div>

        {mode === "gods" && showFormula ? (
          <div className="absolute top-9 left-1 z-10 w-[min(330px,calc(100vw-56px))] rounded border border-[#3a3548] bg-[#17151f] p-3 text-xs font-bold leading-5 text-[#a8a2b8] shadow-lg shadow-black/30">
            <div className="mb-2 flex items-center justify-between">
              <p className="font-extrabold text-[#fbbf24]">낙수의 신 계산식</p>
              <button
                type="button"
                className="rounded px-2 text-sm font-extrabold text-[#a8a2b8] hover:text-[#e5e7eb]"
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

      <div className="grid min-h-6 grid-cols-[30px_minmax(0,1fr)_112px] items-center gap-x-1 border-b border-[#3a3548] px-0.5 py-0.5 text-[14px] font-semibold tracking-tight text-[#a8a2b8]">
        <p>순위</p>
        <p>닉네임</p>
        <p className="text-right">별풍선</p>
      </div>

      <div>
        {rows.length > 0 ? (
          rows
        ) : (
          <p className="rounded border border-[#3a3548] bg-[#211e2b] px-3 py-6 text-center text-sm font-bold text-[#a8a2b8]">
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
  searchQuery = "",
}: {
  crew: CrewCardData;
  index: number;
  membersOnly?: boolean;
  expandMembers?: boolean;
  searchQuery?: string;
}) {
  const headerColor = getCrewHeaderColor(index);
  const header = <CrewCardHeader crew={crew} headerColor={headerColor} />;
  const body = (
    <CrewCardBody
      crew={crew}
      membersOnly={membersOnly}
      expandMembers={expandMembers}
      searchQuery={searchQuery}
    />
  );

  return (
    <>
      <MobileCrewCard header={header} body={body} forceOpen={expandMembers} />

      <section className="hidden overflow-hidden rounded-xl border border-[#3a3548] bg-[#17151f] transition-all duration-300 hover:shadow-xl hover:shadow-black/25 md:block">
        {header}
        {body}
      </section>
    </>
  );
}
