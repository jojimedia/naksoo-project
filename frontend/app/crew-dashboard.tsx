"use client";

import { useMemo, useState } from "react";
import CrewCard, { type CrewCardData } from "./crew-card";

type CrewDashboardData = {
  created_date: string;
  created_time: string;
  crews: CrewCardData[];
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

type UpdateStatus = {
  label: string;
  className: string;
};

function formatUpdatedAt(data: CrewDashboardData) {
  return `${Number(data.created_date.slice(0, 4))}년 ${Number(
    data.created_date.slice(5, 7),
  )}월 ${Number(data.created_date.slice(8, 10))}일 ${data.created_time.slice(
    0,
    5,
  )} 업데이트 출처: 풍투데이`;
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
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

  return "text-[#e5e7eb]";
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

function DonorResultCard({
  donor,
  query,
}: {
  donor: DonorSearchResult;
  query: string;
}) {
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
            <p className="mt-1 text-[19px] font-semibold leading-none tabular-nums">
              {formatNumber(donor.totalBalloons)}
            </p>
          </div>
        </div>
      </div>

      <div className="p-2">
        <div className="grid min-h-6 grid-cols-[92px_minmax(0,1fr)_112px] items-center gap-x-1 border-b border-[#3a3548] px-1 py-0.5 text-[14px] font-semibold tracking-tight text-[#a8a2b8]">
            <p>후원크루</p>
            <p>스트리머</p>
            <p className="text-right">별풍선</p>
        </div>

        {donor.crews.map((crew) => (
          <div key={crew.crewName} className="border-b border-[#3a3548]/70 py-1">
            <div className="grid grid-cols-[92px_minmax(0,1fr)_112px] items-center gap-x-1 px-1 text-[16px]">
              <p className="truncate font-semibold text-[#a99cff]">
                {crew.crewName}
              </p>
              <p className="truncate text-[#a8a2b8]">
                {crew.streamers.length}명
              </p>
              <p
                className={`text-right font-semibold tabular-nums ${getScoreColor(
                  crew.balloons,
                )}`}
              >
                {formatNumber(crew.balloons)}
              </p>
            </div>
            <div className="mt-1 space-y-0.5">
              {crew.streamers.map((streamer) => (
                <div
                  key={`${crew.crewName}-${streamer.nickname}`}
                  className="grid min-h-[25px] grid-cols-[92px_minmax(0,1fr)_112px] items-center gap-x-1 px-1 text-[15px]"
                >
                  <span />
                  <p className="truncate text-[#e5e7eb]">
                    <HighlightText text={streamer.nickname} query={query} />
                  </p>
                  <p
                    className={`text-right font-semibold tabular-nums ${getScoreColor(
                      streamer.balloons,
                    )}`}
                  >
                    {formatNumber(streamer.balloons)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function CrewDashboard({ data }: { data: CrewDashboardData }) {
  const [query, setQuery] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("members");
  const search = normalizeSearch(query);
  const isSearching = search.length > 0;
  const crews = useMemo(() => {
    if (!isSearching) {
      return data.crews;
    }

    return data.crews
      .map((crew) => {
        const members = crew.members.filter((member) => {
          const nickname = normalizeSearch(member.nickname);
          const userId = normalizeSearch(member.user_id);

          return nickname.includes(search) || userId.includes(search);
        });
        const currentTotal = members.reduce(
          (sum, member) => sum + member.current_balloons,
          0,
        );

        return {
          ...crew,
          member_count: members.length,
          current_total_balloons: currentTotal,
          average_current_balloons:
            members.length > 0 ? Math.round(currentTotal / members.length) : 0,
          members,
        };
      })
      .filter((crew) => crew.members.length > 0);
  }, [data.crews, isSearching, search]);
  const donorResults = useMemo(() => {
    if (!isSearching || searchMode !== "donors") {
      return [];
    }

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

    for (const crew of data.crews) {
      for (const member of crew.members) {
        for (const fan of member.monthly_top_fans) {
          const nickname = normalizeSearch(fan.nickname);
          const userId = normalizeSearch(fan.user_id);

          if (!nickname.includes(search) && !userId.includes(search)) {
            continue;
          }

          const key = fan.user_id || fan.nickname;
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
  }, [data.crews, isSearching, search, searchMode]);
  const hasResults =
    searchMode === "donors" && isSearching
      ? donorResults.length > 0
      : crews.length > 0;
  const updateStatus = getUpdateStatus(data);

  return (
    <main className="min-h-screen bg-[#111018] bg-[radial-gradient(#2b2836_1px,transparent_1px)] bg-[length:20px_20px] text-[#e5e7eb]">
      <header className="sticky top-0 z-40 w-full border-b border-[#3a3548] bg-[#111018]/95 backdrop-blur">
        <div className="mx-auto grid min-h-16 w-full max-w-[1920px] grid-cols-1 items-center gap-2 px-3 py-2 md:grid-cols-[minmax(240px,1fr)_minmax(420px,720px)_minmax(240px,1fr)] md:px-8">
          <h1 className="text-center text-[26px] font-semibold leading-none text-[#a99cff] md:text-left md:text-[33px]">
            엑셀 크루 낙수표
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

            <div className="inline-flex shrink-0 rounded-full border border-[#3a3548] bg-[#17151f] p-1">
              <button
                type="button"
                className={`rounded-full px-3 py-1.5 text-[13px] font-semibold transition md:px-4 md:text-sm ${
                  searchMode === "members"
                    ? "bg-[#5b4bdb] text-white"
                    : "text-[#a8a2b8] hover:text-[#d8d4ff]"
                }`}
                onClick={() => setSearchMode("members")}
              >
                멤버
              </button>
              <button
                type="button"
                className={`rounded-full px-3 py-1.5 text-[13px] font-semibold transition md:px-4 md:text-sm ${
                  searchMode === "donors"
                    ? "bg-[#5b4bdb] text-white"
                    : "text-[#a8a2b8] hover:text-[#d8d4ff]"
                }`}
                onClick={() => setSearchMode("donors")}
              >
                큰손
              </button>
            </div>
          </div>

          <div className="hidden justify-end md:flex">
            <button
              className={`rounded-full border px-2.5 py-1.5 text-[11px] font-medium leading-tight ${updateStatus.className}`}
            >
              {updateStatus.label}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1920px] px-3 pt-3 pb-8 md:px-8">
        <div className="mb-3 text-center md:hidden">
          <button
            className={`rounded-full border px-2.5 py-1.5 text-[11px] font-medium leading-tight ${updateStatus.className}`}
          >
            {updateStatus.label}
          </button>
        </div>

        {hasResults ? (
          <div
            className={`mx-auto gap-3 ${
              isSearching
                ? "flex max-w-[520px] flex-col items-center"
                : "grid max-w-[420px] grid-cols-1 md:max-w-[820px] md:grid-cols-2 lg:max-w-none lg:grid-cols-4"
            }`}
          >
            {searchMode === "donors" && isSearching
              ? donorResults.map((donor) => (
                  <DonorResultCard
                    key={donor.key}
                    donor={donor}
                    query={query}
                  />
                ))
              : crews.map((crew, index) => (
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
                ))}
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
    </main>
  );
}
