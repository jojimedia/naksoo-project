"use client";

import { useEffect, useMemo, useState } from "react";
import AdminLoginModal from "./admin-login-modal";
import AdminPanelModal from "./admin-panel-modal";
import MemberRequestModal from "./member-request-modal";
import { getTrimmedAverage } from "@/lib/stats";
import { FA_CREW_NAME, isFaCrew } from "@/lib/crews";

import CrewCard, {
  getCrewHeaderColor,
  type CrewCardData,
} from "./crew-card";
import StreamerMemberRow from "./streamer-member-row";
import {
  getGuestbookPreview,
  hasUnreadGuestbook,
  loadGuestbookReads,
  saveGuestbookRead,
} from "./fa-guestbook-panel";
import {
  getGuestbookPosts,
  previewsFromPosts,
  type GuestbookPost,
} from "@/lib/guestbook-shared";

type CrewDashboardData = {
  created_date: string;
  created_time: string;
  crews: CrewCardData[];
  fa_crew: CrewCardData | null;
};

type SearchMode = "members" | "donors";

type DonorSearchResult = {
  key: string;
  nickname: string;
  totalBalloons: number;
  crews: {
    crewName: string;
    balloons: number;
    streamers: {
      nickname: string;
      balloons: number;
    }[];
  }[];
};

type OverallMember = {
  crewName: string;
  crewColor: string;
  member: CrewCardData["members"][number];
};

type UpdateStatus = {
  label: string;
  className: string;
};

type AdminSession = {
  login_id: string;
  crews: string[];
};

function formatUpdatedAt(data: CrewDashboardData) {
  return `${Number(data.created_date.slice(0, 4))}년 ${Number(
    data.created_date.slice(5, 7),
  )}월 ${Number(data.created_date.slice(8, 10))}일 ${data.created_time.slice(
    0,
    5,
  )} 업데이트 출처: 풍투`;
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function normalizeDonorKey(userId: string, nickname: string) {
  return (userId || nickname).trim().toLowerCase();
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

function getUpdateStatus(data: CrewDashboardData): UpdateStatus {
  const updatedAt = new Date(`${data.created_date}T${data.created_time}+09:00`);
  const diffHours = (Date.now() - updatedAt.getTime()) / 1000 / 60 / 60;

  if (!Number.isFinite(diffHours)) {
    return {
      label: formatUpdatedAt(data),
      className:
        "border-[#3a3548] bg-[#17151f]/70 text-[#8d879c]",
    };
  }

  if (diffHours >= 24) {
    return {
      label: `${formatUpdatedAt(data)} · 업데이트 지연`,
      className:
        "border-[#dc2626]/40 bg-[#dc2626]/10 text-[#fca5a5]",
    };
  }

  if (diffHours >= 12) {
    return {
      label: `${formatUpdatedAt(data)} · 확인 필요`,
      className:
        "border-[#f59e0b]/40 bg-[#f59e0b]/10 text-[#fbbf24]",
    };
  }

  return {
    label: formatUpdatedAt(data),
    className:
      "border-[#3a3548] bg-[#17151f]/70 text-[#8d879c]",
  };
}

function aggregateDonors(
  crews: CrewCardData[],
  search = "",
): DonorSearchResult[] {
  const donors = new Map<
    string,
    {
      key: string;
      nickname: string;
      totalBalloons: number;
      crews: Map<
        string,
        {
          crewName: string;
          balloons: number;
          streamers: Map<
            string,
            {
              nickname: string;
              balloons: number;
            }
          >;
        }
      >;
    }
  >();

  for (const crew of crews) {
    for (const member of crew.members) {
      for (const fan of member.monthly_fans) {
        const nickname = normalizeSearch(fan.nickname);
        const userId = normalizeSearch(fan.user_id);

        if (
          search &&
          !nickname.includes(search) &&
          !userId.includes(search)
        ) {
          continue;
        }

        const key = normalizeDonorKey(fan.user_id, fan.nickname);
        const current = donors.get(key) ?? {
          key,
          nickname: fan.nickname,
          totalBalloons: 0,
          crews: new Map(),
        };
        const currentCrew = current.crews.get(crew.crew_name) ?? {
          crewName: crew.crew_name,
          balloons: 0,
          streamers: new Map(),
        };
        const streamer = currentCrew.streamers.get(member.user_id) ?? {
          nickname: member.nickname,
          balloons: 0,
        };

        streamer.balloons += fan.balloons;
        currentCrew.streamers.set(member.user_id, streamer);
        currentCrew.balloons += fan.balloons;
        current.crews.set(crew.crew_name, currentCrew);
        current.totalBalloons += fan.balloons;
        donors.set(key, current);
      }
    }
  }

  return Array.from(donors.values())
    .map((donor) => ({
      key: donor.key,
      nickname: donor.nickname,
      totalBalloons: donor.totalBalloons,
      crews: Array.from(donor.crews.values())
        .map((crew) => ({
          crewName: crew.crewName,
          balloons: crew.balloons,
          streamers: Array.from(crew.streamers.values()).sort(
            (a, b) => b.balloons - a.balloons,
          ),
        }))
        .sort((a, b) => b.balloons - a.balloons),
    }))
    .sort((a, b) => b.totalBalloons - a.totalBalloons);
}

function KingsRankingRow({
  rank,
  donor,
}: {
  rank: number;
  donor: DonorSearchResult;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const tone = getScoreTone(donor.totalBalloons);

  return (
    <div className="border-b border-[#3a3548]/70">
      <div
        className={`grid min-h-7 grid-cols-[34px_minmax(0,1fr)_92px] items-center gap-x-3 rounded px-0.5 py-0.5 text-[16px] tracking-tight transition hover:ring-1 hover:ring-white/35 ${tone.row}`}
      >
        <p className={`font-semibold tabular-nums ${tone.muted}`}>{rank}</p>
        <button
          type="button"
          className={`block min-w-0 cursor-pointer truncate text-left font-semibold hover:underline hover:decoration-current hover:underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#93c5fd] ${tone.name}`}
          aria-expanded={isOpen}
          aria-label={`${donor.nickname} 후원 내역 ${isOpen ? "접기" : "열기"}`}
          onClick={() => setIsOpen((current) => !current)}
        >
          {donor.nickname}
        </button>
        <p className={`text-right font-bold tabular-nums ${tone.score}`}>
          {formatNumber(donor.totalBalloons)}
        </p>
      </div>

      {isOpen ? (
        <div className="mx-1 mb-2 rounded border border-[#3a3548] bg-[#211e2b] px-2 py-2">
          <div className="mb-1 grid min-h-6 grid-cols-[92px_minmax(0,1fr)_112px] items-center gap-x-0.5 border-b border-[#3a3548] px-1 py-0.5 text-[13px] font-semibold text-[#a8a2b8]">
            <p>후원크루</p>
            <p>스트리머</p>
            <p className="text-right">별풍선</p>
          </div>
          {donor.crews.map((crew) => (
            <DonorCrewRow key={crew.crewName} crew={crew} query="" />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function KingsRankingCard({ rows }: { rows: DonorSearchResult[] }) {
  return (
    <section className="w-full max-w-[520px] overflow-hidden rounded-xl border border-[#3a3548] bg-[#17151f] shadow-sm">
      <div className="bg-[#2563EB] p-3 text-white">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[23px] font-semibold leading-7">큰손순위</h2>
          <p className="rounded bg-black/10 px-2.5 py-1.5 text-[12px] font-bold">
            {rows.length}명
          </p>
        </div>
      </div>

      <div className="bg-[#17151f] p-1">
        <div className="grid min-h-6 grid-cols-[34px_minmax(0,1fr)_92px] items-center gap-x-3 border-b border-[#3a3548] px-0.5 py-0.5 text-[14px] font-semibold tracking-tight text-[#a8a2b8]">
          <p>순위</p>
          <p>닉네임</p>
          <p className="text-right">별풍선</p>
        </div>

        {rows.length > 0 ? (
          rows.map((donor, index) => (
            <KingsRankingRow
              key={donor.key}
              rank={index + 1}
              donor={donor}
            />
          ))
        ) : (
          <p className="rounded border border-[#3a3548] bg-[#211e2b] px-3 py-6 text-center text-sm font-bold text-[#a8a2b8]">
            큰손 데이터 없음
          </p>
        )}
      </div>
    </section>
  );
}

function DonorResultCard({
  donor,
  query,
}: {
  donor: DonorSearchResult;
  query: string;
}) {
  const donorTone = getScoreTone(donor.totalBalloons);

  return (
    <section className="w-full max-w-[520px] overflow-hidden rounded-xl border border-[#3a3548] bg-[#17151f] shadow-sm">
      <div className="bg-[#5b4bdb] p-3 text-white">
        <div className="flex items-center justify-between gap-3">
          <h2 className="min-w-0 truncate text-[23px] font-semibold leading-7">
            <HighlightText text={donor.nickname} query={query} />
          </h2>
          <div className="shrink-0 rounded bg-black/10 px-2.5 py-1.5 text-right">
            <p className="text-[10px] font-bold leading-none opacity-80">
              전체 별풍선
            </p>
            <p className={`mt-1 text-[19px] font-bold leading-none tabular-nums ${donorTone.score}`}>
              {formatNumber(donor.totalBalloons)}
            </p>
          </div>
        </div>
      </div>

      <div className="p-2">
        <div className="grid min-h-6 grid-cols-[92px_minmax(0,1fr)_112px] items-center gap-x-0.5 border-b border-[#3a3548] px-1 py-0.5 text-[14px] font-semibold tracking-tight text-[#a8a2b8]">
          <p>후원크루</p>
          <p>스트리머</p>
          <p className="text-right">별풍선</p>
        </div>

        {donor.crews.map((crew) => (
          <DonorCrewRow key={crew.crewName} crew={crew} query={query} />
        ))}
      </div>
    </section>
  );
}

function DonorCrewRow({
  crew,
  query,
}: {
  crew: DonorSearchResult["crews"][number];
  query: string;
}) {
  const tone = getScoreTone(crew.balloons);

  return (
    <div className="border-b border-[#3a3548]/70 py-1">
      <div
        className={`grid grid-cols-[92px_minmax(0,1fr)_112px] items-center gap-x-1 rounded px-1 text-[16px] ${tone.row}`}
      >
        <p className={`truncate font-semibold ${tone.name}`}>{crew.crewName}</p>
        <p className={`truncate font-semibold ${tone.muted}`}>
          {crew.streamers.length}명
        </p>
        <p className={`text-right font-bold tabular-nums ${tone.score}`}>
          {formatNumber(crew.balloons)}
        </p>
      </div>
      <div className="mt-1 space-y-0.5">
        {crew.streamers.map((streamer) => (
          <DonorStreamerRow
            key={`${crew.crewName}-${streamer.nickname}`}
            streamer={streamer}
            query={query}
          />
        ))}
      </div>
    </div>
  );
}

function DonorStreamerRow({
  streamer,
  query,
}: {
  streamer: DonorSearchResult["crews"][number]["streamers"][number];
  query: string;
}) {
  const tone = getScoreTone(streamer.balloons);

  return (
    <div
      className={`grid min-h-[25px] grid-cols-[92px_minmax(0,1fr)_112px] items-center gap-x-1 rounded px-1 text-[15px] ${tone.row}`}
    >
      <span />
      <p className={`truncate font-semibold ${tone.name}`}>
        <HighlightText text={streamer.nickname} query={query} />
      </p>
      <p className={`text-right font-bold tabular-nums ${tone.score}`}>
        {formatNumber(streamer.balloons)}
      </p>
    </div>
  );
}

function OverallRankingCard({ rows }: { rows: OverallMember[] }) {
  return (
    <PeriodRankingCard
      title="전체순위"
      headerColor="#5b4bdb"
      scoreLabel="별풍선"
      rows={rows}
    />
  );
}

function PeriodRankingCard({
  title,
  headerColor,
  scoreLabel,
  headerNote,
  rows,
  getRowProps,
}: {
  title: string;
  headerColor: string;
  scoreLabel: string;
  headerNote?: string;
  rows: OverallMember[];
  getRowProps?: (row: OverallMember) => {
    scoreOverride?: number;
    scoreToneValue?: number;
    scoreSubLabel?: string;
    fansOverride?: Array<{
      rank: number;
      user_id: string;
      nickname: string;
      balloons: number;
    }>;
    fanPanelTitle?: string;
    liveBroadcastMode?: boolean;
    todayBalloonsOverride?: number;
  };
}) {
  return (
    <section className="w-full max-w-[520px] overflow-hidden rounded-xl border border-[#3a3548] bg-[#17151f] shadow-sm">
      <div className="p-3 text-white" style={{ backgroundColor: headerColor }}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[23px] font-semibold leading-7">{title}</h2>
            {headerNote ? (
              <p className="mt-0.5 text-[11px] font-medium text-white/80">
                {headerNote}
              </p>
            ) : null}
          </div>
          <p className="rounded bg-black/10 px-2.5 py-1.5 text-[12px] font-bold">
            {rows.length}명
          </p>
        </div>
      </div>

      <div className="bg-[#17151f] p-1">
        <div className="grid min-h-6 grid-cols-[34px_92px_minmax(0,1fr)_78px] items-center gap-x-3 border-b border-[#3a3548] px-0.5 py-0.5 text-[14px] font-semibold tracking-tight text-[#a8a2b8]">
          <p>순위</p>
          <p>소속크루</p>
          <p>닉네임</p>
          <p className="text-right">{scoreLabel}</p>
        </div>

        {rows.length > 0 ? (
          rows.map((row) => {
            const props = getRowProps?.(row) ?? {};

            return (
              <StreamerMemberRow
                key={`${row.crewName}-${row.member.user_id}`}
                member={row.member}
                showCrew
                crewName={row.crewName}
                crewColor={row.crewColor}
                disableScoreTone
                scoreOverride={props.scoreOverride}
                scoreToneValue={props.scoreToneValue}
                scoreSubLabel={props.scoreSubLabel}
                fansOverride={props.fansOverride}
                fanPanelTitle={props.fanPanelTitle}
                liveBroadcastMode={props.liveBroadcastMode}
                todayBalloonsOverride={props.todayBalloonsOverride}
              />
            );
          })
        ) : (
          <p className="rounded border border-[#3a3548] bg-[#211e2b] px-3 py-6 text-center text-sm font-bold text-[#a8a2b8]">
            표시할 스트리머가 없습니다.
          </p>
        )}
      </div>
    </section>
  );
}

const EMPTY_GUESTBOOK_POSTS: GuestbookPost[] = [];

function FaRankingCard({
  rows,
  isAdmin,
}: {
  rows: OverallMember[];
  isAdmin: boolean;
}) {
  const [postsByUserId, setPostsByUserId] = useState<
    Record<string, GuestbookPost[]> | null
  >(null);
  const [readAtByUserId, setReadAtByUserId] = useState<Record<string, string>>(
    {},
  );
  const previewByUserId = previewsFromPosts(postsByUserId ?? {});
  const prefetching = postsByUserId === null;

  useEffect(() => {
    setReadAtByUserId(loadGuestbookReads());
    void prefetchGuestbook();
  }, []);

  async function prefetchGuestbook() {
    try {
      const response = await fetch("/api/guestbook/summary", {
        cache: "no-store",
      });
      const data = (await response.json()) as {
        posts?: Record<string, GuestbookPost[]>;
      };

      setPostsByUserId((current) => ({
        ...(response.ok && data.posts ? data.posts : {}),
        ...(current ?? {}),
      }));
    } catch {
      setPostsByUserId((current) => current ?? {});
    }
  }

  function updateStreamerPosts(userId: string, posts: GuestbookPost[]) {
    setPostsByUserId((current) => ({
      ...(current ?? {}),
      [userId.toLowerCase()]: posts,
    }));
  }

  return (
    <section className="w-full min-w-0 max-w-[760px] overflow-hidden rounded-xl border border-[#3a3548] bg-[#17151f] shadow-sm">
      <div className="bg-[#0F766E] p-3 text-white">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[23px] font-semibold leading-7">FA</h2>
          <p className="rounded bg-black/10 px-2.5 py-1.5 text-[12px] font-bold">
            {rows.length}명
          </p>
        </div>
        <p className="mt-1 text-[11px] font-semibold text-white/80">
          스트리머에게 적합한 크루를 추천해주세요
        </p>
      </div>

      <div className="min-w-0 bg-[#17151f] p-1">
        <div className="grid min-h-6 grid-cols-[20px_minmax(0,0.62fr)_auto_minmax(0,1.7fr)] items-center gap-x-0.5 border-b border-[#3a3548] px-0.5 py-0.5 text-[12px] font-semibold tracking-tight text-[#a8a2b8] sm:grid-cols-[28px_minmax(88px,0.8fr)_86px_minmax(0,1.6fr)] sm:gap-x-1.5 sm:text-[14px]">
          <p>순위</p>
          <p>닉네임</p>
          <p className="text-right">별풍선</p>
          <p className="text-center">메모</p>
        </div>

        {rows.length > 0 ? (
          rows.map((row) => (
            <StreamerMemberRow
              key={`${row.crewName}-${row.member.user_id}`}
              member={row.member}
              crewName={row.crewName}
              crewColor={row.crewColor}
              disableScoreTone
              guestbookEnabled
              isAdmin={isAdmin}
              guestbookPreview={getGuestbookPreview(
                row.member.user_id,
                previewByUserId,
              )}
              guestbookPosts={
                postsByUserId
                  ? (getGuestbookPosts(row.member.user_id, postsByUserId) ??
                    EMPTY_GUESTBOOK_POSTS)
                  : undefined
              }
              guestbookPrefetching={prefetching}
              hasNewGuestbook={hasUnreadGuestbook(
                row.member.user_id,
                previewByUserId,
                readAtByUserId,
              )}
              onGuestbookOpened={() => {
                setReadAtByUserId(saveGuestbookRead(row.member.user_id));
              }}
              onGuestbookPosted={() => {
                setReadAtByUserId(saveGuestbookRead(row.member.user_id));
              }}
              onGuestbookPostsChange={(posts) => {
                updateStreamerPosts(row.member.user_id, posts);
              }}
            />
          ))
        ) : (
          <p className="rounded border border-[#3a3548] bg-[#211e2b] px-3 py-6 text-center text-sm font-bold text-[#a8a2b8]">
            FA 스트리머가 없습니다.
          </p>
        )}
      </div>
    </section>
  );
}

export default function CrewDashboard({ data }: { data: CrewDashboardData }) {
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("members");
  const [showOverall, setShowOverall] = useState(false);
  const [showKings, setShowKings] = useState(false);
  const [showFa, setShowFa] = useState(false);
  const [adminSession, setAdminSession] = useState<AdminSession | null>(null);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [showMemberRequestModal, setShowMemberRequestModal] = useState(false);
  const search = normalizeSearch(query);
  const isSearching = search.length > 0;
  const rankingCrews = useMemo(
    () => (data.fa_crew ? [...data.crews, data.fa_crew] : data.crews),
    [data.crews, data.fa_crew],
  );

  const crews = useMemo(() => {
    // 홈/검색 카드에는 소속 크루만 표시한다. FA는 카드로 넣지 않는다.
    const sourceCrews = data.crews;

    if (!isSearching) {
      return sourceCrews;
    }

    return sourceCrews
      .map((crew) => {
        const members = crew.members.filter((member) => {
          const nickname = normalizeSearch(member.nickname);
          const userId = normalizeSearch(member.user_id);

          return nickname.includes(search) || userId.includes(search);
        });
        const activeMembers = members.filter((member) => !member.is_on_leave);
        const currentTotal = activeMembers.reduce(
          (sum, member) => sum + member.current_balloons,
          0,
        );

        return {
          ...crew,
          member_count: activeMembers.length,
          current_total_balloons: currentTotal,
          average_current_balloons: getTrimmedAverage(
            activeMembers.map((member) => member.current_balloons),
          ),
          members,
        };
      })
      .filter((crew) => crew.members.length > 0);
  }, [data.crews, isSearching, search]);
  const donorResults = useMemo(() => {
    if (!isSearching || searchMode !== "donors") {
      return [];
    }

    return aggregateDonors(rankingCrews, search);
  }, [rankingCrews, isSearching, search, searchMode]);
  const kingRows = useMemo(
    () => aggregateDonors(rankingCrews).slice(0, 100),
    [rankingCrews],
  );
  const faRows = useMemo(() => {
    if (!data.fa_crew) {
      return [];
    }

    return data.fa_crew.members
      .filter((member) => !member.is_on_leave)
      .slice()
      .sort((a, b) => b.current_balloons - a.current_balloons)
      .map((member, index) => ({
        crewName: FA_CREW_NAME,
        crewColor: "#0F766E",
        member: {
          ...member,
          rank: index + 1,
        },
      }));
  }, [data.fa_crew]);
  const hasResults =
    (showOverall || showKings || showFa) && !isSearching
      ? true
      : searchMode === "donors" && isSearching
        ? donorResults.length > 0
        : crews.length > 0;
  const updateStatus = getUpdateStatus(data);
  const overallRows = useMemo(
    () =>
      rankingCrews
        .flatMap((crew, crewIndex) =>
          crew.members
            .filter((member) => !member.is_on_leave)
            .map((member) => ({
              crewName: isFaCrew(crew.crew_name)
                ? FA_CREW_NAME
                : crew.crew_name,
              crewColor: isFaCrew(crew.crew_name)
                ? "#0F766E"
                : getCrewHeaderColor(crewIndex),
              member,
            })),
        )
        .sort(
          (a, b) => b.member.current_balloons - a.member.current_balloons,
        )
        .map((row, index) => ({
          ...row,
          member: {
            ...row.member,
            rank: index + 1,
          },
        })),
    [rankingCrews],
  );

  useEffect(() => {
    async function loadSession() {
      try {
        const response = await fetch("/api/admin/session");
        const sessionData = (await response.json()) as {
          authenticated?: boolean;
          login_id?: string;
          crews?: string[];
        };

        if (sessionData.authenticated && sessionData.login_id && sessionData.crews) {
          setAdminSession({
            login_id: sessionData.login_id,
            crews: sessionData.crews,
          });
        }
      } catch {
        setAdminSession(null);
      }
    }

    void loadSession();
  }, []);

  function resetToHome() {
    setQuery("");
    setSearchMode("members");
    setShowOverall(false);
    setShowKings(false);
    setShowFa(false);
    setShowLoginModal(false);
    setShowAdminPanel(false);
    setShowMemberRequestModal(false);
  }

  function handleAdminButtonClick() {
    if (adminSession) {
      setShowAdminPanel(true);
      return;
    }

    setShowLoginModal(true);
  }

  return (
    <main className="min-h-screen bg-[#111018] bg-[radial-gradient(#2b2836_1px,transparent_1px)] bg-[length:20px_20px] text-[#e5e7eb]">
      <header className="sticky top-0 z-40 w-full border-b border-[#3a3548] bg-[#111018]/95 backdrop-blur">
        <div className="mx-auto grid min-h-16 w-full max-w-[1920px] grid-cols-1 items-center gap-2 px-3 py-2 md:grid-cols-[minmax(240px,1fr)_minmax(420px,720px)_minmax(240px,1fr)] md:px-8">
          <h1 className="text-center text-[26px] font-semibold leading-none text-[#a99cff] md:text-left md:text-[33px]">
            <button
              type="button"
              className="rounded-sm transition hover:text-[#c8bfff] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#a99cff]"
              onClick={resetToHome}
            >
              엑셀 크루 낙수표
            </button>
          </h1>

          <div className="flex items-center gap-2">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">
                {searchMode === "donors" ? "큰손검색" : "멤버검색"}
              </span>
              <span
                className="pointer-events-none absolute top-1/2 left-4 flex -translate-y-1/2 text-[#a8a2b8]"
                aria-hidden="true"
                dangerouslySetInnerHTML={{
                  __html:
                    '<box-icon name="search" color="#a8a2b8" size="20px"></box-icon>',
                }}
              />
              <input
                type="text"
                inputMode="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchMode === "donors" ? "큰손검색" : "멤버검색"}
                className="h-10 w-full rounded-full border border-[#3a3548] bg-[#17151f] pr-10 pl-11 text-center text-[16px] font-medium text-[#e5e7eb] outline-none transition placeholder:text-[#7f788f] focus:border-[#a99cff] focus:ring-2 focus:ring-[#a99cff]/20"
              />
              {query ? (
                <button
                  type="button"
                  className="absolute top-1/2 right-2.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full bg-[#2b2836] text-[16px] font-semibold leading-none text-[#d8d4e5] transition hover:bg-[#3a3548] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#a99cff]"
                  aria-label="검색어 지우기"
                  onClick={() => setQuery("")}
                >
                  ×
                </button>
              ) : null}
            </label>

            <div className="inline-flex max-w-full shrink-0 flex-wrap justify-end gap-0.5 rounded-full border border-[#3a3548] bg-[#17151f] p-1">
              <button
                type="button"
                className={`rounded-full px-2.5 py-1.5 text-[12px] font-semibold transition md:px-4 md:text-sm ${
                  !showOverall &&
                  !showKings &&
                  !showFa &&
                  searchMode === "members"
                    ? "bg-[#5b4bdb] text-white"
                    : "text-[#a8a2b8] hover:text-[#d8d4ff]"
                }`}
                onClick={() => {
                  setShowOverall(false);
                  setShowKings(false);
                  setShowFa(false);
                  setSearchMode("members");
                }}
              >
                멤버
              </button>
              <button
                type="button"
                className={`rounded-full px-2.5 py-1.5 text-[12px] font-semibold transition md:px-4 md:text-sm ${
                  showKings ||
                  (!showOverall &&
                    !showFa &&
                    searchMode === "donors")
                    ? "bg-[#5b4bdb] text-white"
                    : "text-[#a8a2b8] hover:text-[#d8d4ff]"
                }`}
                aria-pressed={showKings}
                onClick={() => {
                  setQuery("");
                  setShowOverall(false);
                  setShowFa(false);
                  setShowKings(true);
                  setSearchMode("donors");
                }}
              >
                큰손
              </button>
              <button
                type="button"
                className={`rounded-full px-2.5 py-1.5 text-[12px] font-semibold transition md:px-4 md:text-sm ${
                  showFa
                    ? "bg-[#5b4bdb] text-white"
                    : "text-[#a8a2b8] hover:text-[#d8d4ff]"
                }`}
                aria-pressed={showFa}
                onClick={() => {
                  setQuery("");
                  setShowOverall(false);
                  setShowKings(false);
                  setShowFa(true);
                  setSearchMode("members");
                }}
              >
                FA
              </button>
              <button
                type="button"
                className={`rounded-full px-2.5 py-1.5 text-[12px] font-semibold transition md:px-4 md:text-sm ${
                  showOverall
                    ? "bg-[#5b4bdb] text-white"
                    : "text-[#a8a2b8] hover:text-[#d8d4ff]"
                }`}
                aria-pressed={showOverall}
                onClick={() => {
                  setQuery("");
                  setShowKings(false);
                  setShowFa(false);
                  setShowOverall((current) => !current);
                }}
              >
                전체
              </button>
            </div>
          </div>

          <div className="hidden items-center justify-end gap-2 md:flex">
            <button
              type="button"
              className="rounded-full border border-[#3a3548] bg-[#17151f] px-2.5 py-1.5 text-[11px] font-medium text-[#d8d4ff] transition hover:border-[#a99cff]/40"
              onClick={() => setShowMemberRequestModal(true)}
            >
              스트리머 등록 신청
            </button>
            <button
              type="button"
              className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border p-0 leading-none transition ${
                adminSession
                  ? "border-[#a99cff]/50 bg-[#5b4bdb]/20 text-[#d8d4ff]"
                  : "border-[#3a3548] bg-[#17151f] text-[#a8a2b8] hover:border-[#a99cff]/40 hover:text-[#d8d4ff]"
              }`}
              aria-label={adminSession ? "크루 관리 열기" : "관리자 로그인"}
              onClick={handleAdminButtonClick}
            >
              <span
                className="flex items-center justify-center [&_box-icon]:block [&_box-icon]:leading-none"
                aria-hidden="true"
                dangerouslySetInnerHTML={{
                  __html:
                    '<box-icon name="key" color="currentColor" size="14px"></box-icon>',
                }}
              />
            </button>
            <button
              className={`rounded-full border px-2.5 py-1.5 text-[11px] font-medium leading-tight ${updateStatus.className}`}
            >
              {updateStatus.label}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1920px] px-3 pt-3 pb-8 md:px-8">
        <div className="mb-3 flex items-center justify-center gap-2 md:hidden">
          <button
            type="button"
            className="rounded-full border border-[#3a3548] bg-[#17151f] px-2.5 py-1.5 text-[11px] font-medium text-[#d8d4ff]"
            onClick={() => setShowMemberRequestModal(true)}
          >
            스트리머 등록 신청
          </button>
          <button
            type="button"
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border p-0 leading-none transition ${
              adminSession
                ? "border-[#a99cff]/50 bg-[#5b4bdb]/20 text-[#d8d4ff]"
                : "border-[#3a3548] bg-[#17151f] text-[#a8a2b8]"
            }`}
            aria-label={adminSession ? "크루 관리 열기" : "관리자 로그인"}
            onClick={handleAdminButtonClick}
          >
            <span
              className="flex items-center justify-center [&_box-icon]:block [&_box-icon]:leading-none"
              aria-hidden="true"
              dangerouslySetInnerHTML={{
                __html:
                  '<box-icon name="key" color="currentColor" size="14px"></box-icon>',
              }}
            />
          </button>
          <button
            className={`rounded-full border px-2.5 py-1.5 text-[11px] font-medium leading-tight ${updateStatus.className}`}
          >
            {updateStatus.label}
          </button>
        </div>

        {hasResults ? (
          <div
            className={`mx-auto gap-3 ${
              showFa && !isSearching
                  ? "flex w-full min-w-0 max-w-[760px] flex-col items-center"
                  : isSearching || showOverall || showKings
                    ? "flex max-w-[520px] flex-col items-center"
                    : "grid max-w-[420px] grid-cols-1 md:max-w-[820px] md:grid-cols-3 lg:max-w-none lg:grid-cols-5"
            }`}
          >
            {showOverall && !isSearching ? (
              <OverallRankingCard rows={overallRows} />
            ) : showKings && !isSearching ? (
              <KingsRankingCard rows={kingRows} />
            ) : showFa && !isSearching ? (
              <FaRankingCard rows={faRows} isAdmin={Boolean(adminSession)} />
            ) : searchMode === "donors" && isSearching ? (
              donorResults.map((donor, donorIndex) => (
                <DonorResultCard
                  key={`${donor.key}-${donorIndex}`}
                  donor={donor}
                  query={query}
                />
              ))
            ) : (
              crews.map((crew, index) => (
                <div
                  key={crew.crew_name}
                  className={isSearching ? "w-full max-w-[420px]" : "w-full"}
                >
                  <CrewCard
                    crew={crew}
                    index={index}
                    membersOnly={isSearching}
                    expandMembers={isSearching}
                    searchQuery={query}
                  />
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="mx-auto mt-12 max-w-[420px] rounded-xl border border-[#3a3548] bg-[#17151f] px-5 py-8 text-center text-[16px] font-semibold text-[#a8a2b8]">
            검색 결과가 없습니다.
          </div>
        )}

        <footer className="mx-auto mt-6 w-full max-w-[960px] border-t border-[#3a3548] px-2 pt-4 text-sm font-medium text-[#a8a2b8]">
          <section className="flex flex-col items-center justify-center gap-2 text-center md:flex-row md:gap-3">
            <span className="font-semibold text-[#e5e7eb]">문의 / 요청</span>
            <span className="hidden h-3 w-px bg-[#3a3548] md:block" />
            <p>데이터 수정 및 오류 제보는 오픈카톡으로 보내주세요</p>
            <a
              href="https://open.kakao.com/o/gPGWUCsi"
              target="_blank"
              rel="noreferrer"
              className="inline-flex rounded border border-[#f59e0b]/30 bg-[#f59e0b]/10 px-3 py-1.5 text-sm font-semibold text-[#fbbf24] transition-colors hover:border-[#f59e0b]/50 hover:bg-[#f59e0b]/15"
            >
              카카오톡 오픈채팅 문의하기
            </a>
          </section>
        </footer>
      </div>

      {showLoginModal ? (
        <AdminLoginModal
          onClose={() => setShowLoginModal(false)}
          onSuccess={(session) => {
            setAdminSession(session);
            setShowLoginModal(false);
            setShowAdminPanel(true);
          }}
        />
      ) : null}

      {showMemberRequestModal ? (
        <MemberRequestModal
          onClose={() => setShowMemberRequestModal(false)}
        />
      ) : null}

      {showAdminPanel && adminSession ? (
        <AdminPanelModal
          session={adminSession}
          onClose={() => setShowAdminPanel(false)}
          onLogout={() => {
            setAdminSession(null);
            setShowAdminPanel(false);
          }}
        />
      ) : null}
    </main>
  );
}
