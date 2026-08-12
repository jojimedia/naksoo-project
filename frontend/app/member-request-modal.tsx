"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

import { displayCrewName, FA_CREW_NAME, isFaCrew } from "@/lib/crews";

type CrewOption = {
  crew_name: string;
  display_name: string;
};

type SearchCandidate = {
  user_id: string;
  nickname: string;
  already_registered: boolean;
  from_fa: boolean;
  existing_crew_name: string | null;
  selectable: boolean;
};

type MemberRow = {
  user_id: string;
  nickname: string;
  note: string;
  is_on_leave: boolean;
};

type DesiredStatus = "active" | "leave" | "retire";

type DraftRequest = {
  key: string;
  action: "add" | "leave" | "restore" | "retire";
  crew_name: string;
  user_id: string;
  nickname: string;
  label: string;
};

type MemberRequestModalProps = {
  onClose: () => void;
};

function actionLabel(action: DraftRequest["action"]) {
  switch (action) {
    case "add":
      return "신규 등록";
    case "leave":
      return "휴직";
    case "restore":
      return "복직";
    case "retire":
      return "퇴사";
    default:
      return action;
  }
}

function currentDesiredStatus(member: MemberRow): DesiredStatus {
  return member.is_on_leave ? "leave" : "active";
}

export default function MemberRequestModal({ onClose }: MemberRequestModalProps) {
  const [crews, setCrews] = useState<CrewOption[]>([]);
  const [addCrew, setAddCrew] = useState(FA_CREW_NAME);
  const [listCrew, setListCrew] = useState(FA_CREW_NAME);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCandidates, setSearchCandidates] = useState<SearchCandidate[]>(
    [],
  );
  const [selectedStreamer, setSelectedStreamer] =
    useState<SearchCandidate | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [desiredByUserId, setDesiredByUserId] = useState<
    Record<string, DesiredStatus>
  >({});
  const [drafts, setDrafts] = useState<DraftRequest[]>([]);
  const [isLoadingCrews, setIsLoadingCrews] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadCrews = useCallback(async () => {
    setIsLoadingCrews(true);
    setError("");

    try {
      const response = await fetch("/api/member-requests/crews");
      const data = (await response.json()) as {
        crews?: CrewOption[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "크루 목록을 불러오지 못했습니다.");
      }

      const nextCrews = data.crews ?? [];
      setCrews(nextCrews);
      const statusCrews = nextCrews.filter(
        (crew) => !isFaCrew(crew.crew_name),
      );

      if (nextCrews.length > 0) {
        setAddCrew((current) =>
          nextCrews.some((crew) => crew.crew_name === current)
            ? current
            : nextCrews[0].crew_name,
        );
      }

      if (statusCrews.length > 0) {
        setListCrew((current) =>
          statusCrews.some((crew) => crew.crew_name === current)
            ? current
            : statusCrews[0].crew_name,
        );
      } else {
        setListCrew("");
      }
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "크루 목록을 불러오지 못했습니다.",
      );
    } finally {
      setIsLoadingCrews(false);
    }
  }, []);

  const loadMembers = useCallback(async (crewName: string) => {
    if (!crewName || isFaCrew(crewName)) {
      setMembers([]);
      setDesiredByUserId({});
      return;
    }

    setIsLoadingMembers(true);
    setError("");

    try {
      const response = await fetch(
        `/api/member-requests/members?crew=${encodeURIComponent(crewName)}`,
      );
      const data = (await response.json()) as {
        members?: MemberRow[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "멤버 목록을 불러오지 못했습니다.");
      }

      const nextMembers = data.members ?? [];
      setMembers(nextMembers);
      setDesiredByUserId(
        Object.fromEntries(
          nextMembers.map((member) => [
            member.user_id.toLowerCase(),
            currentDesiredStatus(member),
          ]),
        ),
      );
    } catch (loadError) {
      setMembers([]);
      setError(
        loadError instanceof Error
          ? loadError.message
          : "멤버 목록을 불러오지 못했습니다.",
      );
    } finally {
      setIsLoadingMembers(false);
    }
  }, []);

  useEffect(() => {
    void loadCrews();
  }, [loadCrews]);

  useEffect(() => {
    void loadMembers(listCrew);
  }, [listCrew, loadMembers]);

  function upsertDraft(draft: DraftRequest) {
    setDrafts((current) => {
      const without = current.filter((entry) => entry.key !== draft.key);
      return [...without, draft];
    });
  }

  function removeDraft(key: string) {
    setDrafts((current) => current.filter((entry) => entry.key !== key));
  }

  async function handleSearch(event?: FormEvent) {
    event?.preventDefault();
    const query = searchQuery.trim();

    if (query.length < 2) {
      setError("검색어는 2글자 이상 입력해주세요.");
      return;
    }

    setIsSearching(true);
    setError("");
    setMessage("");
    setSelectedStreamer(null);

    try {
      const response = await fetch(
        `/api/member-requests/search?q=${encodeURIComponent(query)}&crew=${encodeURIComponent(addCrew)}`,
      );
      const data = (await response.json()) as {
        candidates?: SearchCandidate[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "검색에 실패했습니다.");
      }

      setSearchCandidates(data.candidates ?? []);

      if ((data.candidates ?? []).length === 0) {
        setMessage("검색 결과가 없습니다.");
      }
    } catch (searchError) {
      setSearchCandidates([]);
      setError(
        searchError instanceof Error
          ? searchError.message
          : "검색에 실패했습니다.",
      );
    } finally {
      setIsSearching(false);
    }
  }

  function handleQueueAdd() {
    if (!selectedStreamer) {
      setError("등록할 스트리머를 선택해주세요.");
      return;
    }

    const key = `add:${addCrew.toLowerCase()}:${selectedStreamer.user_id.toLowerCase()}`;
    upsertDraft({
      key,
      action: "add",
      crew_name: addCrew,
      user_id: selectedStreamer.user_id,
      nickname: selectedStreamer.nickname,
      label: `${selectedStreamer.nickname} → ${displayCrewName(addCrew)} 신규 등록`,
    });
    setMessage("신규 등록 신청이 대기열에 추가되었습니다.");
    setError("");
    setSelectedStreamer(null);
    setSearchCandidates([]);
    setSearchQuery("");
  }

  function handleDesiredChange(member: MemberRow, next: DesiredStatus) {
    const userKey = member.user_id.toLowerCase();
    setDesiredByUserId((current) => ({ ...current, [userKey]: next }));

    const base = currentDesiredStatus(member);
    const keysToClear = [
      `leave:${listCrew.toLowerCase()}:${userKey}`,
      `restore:${listCrew.toLowerCase()}:${userKey}`,
      `retire:${listCrew.toLowerCase()}:${userKey}`,
    ];

    setDrafts((current) =>
      current.filter((entry) => !keysToClear.includes(entry.key)),
    );

    if (next === base) {
      return;
    }

    if (next === "leave") {
      upsertDraft({
        key: `leave:${listCrew.toLowerCase()}:${userKey}`,
        action: "leave",
        crew_name: listCrew,
        user_id: member.user_id,
        nickname: member.nickname,
        label: `${member.nickname} · ${displayCrewName(listCrew)} 휴직`,
      });
      return;
    }

    if (next === "active" && member.is_on_leave) {
      upsertDraft({
        key: `restore:${listCrew.toLowerCase()}:${userKey}`,
        action: "restore",
        crew_name: listCrew,
        user_id: member.user_id,
        nickname: member.nickname,
        label: `${member.nickname} · ${displayCrewName(listCrew)} 복직`,
      });
      return;
    }

    if (next === "retire") {
      if (isFaCrew(listCrew)) {
        setError("무소속 멤버는 퇴사 신청할 수 없습니다.");
        setDesiredByUserId((current) => ({
          ...current,
          [userKey]: base,
        }));
        return;
      }

      upsertDraft({
        key: `retire:${listCrew.toLowerCase()}:${userKey}`,
        action: "retire",
        crew_name: listCrew,
        user_id: member.user_id,
        nickname: member.nickname,
        label: `${member.nickname} · ${displayCrewName(listCrew)} 퇴사`,
      });
    }
  }

  async function handleSubmit() {
    if (drafts.length === 0) {
      setError("신청할 항목이 없습니다.");
      return;
    }

    setIsSubmitting(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/member-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: drafts.map((draft) => ({
            action: draft.action,
            crew_name: draft.crew_name,
            user_id: draft.user_id,
            nickname: draft.nickname,
          })),
        }),
      });
      const data = (await response.json()) as {
        message?: string;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "신청에 실패했습니다.");
      }

      setDrafts([]);
      setMessage(data.message ?? "신청이 접수되었습니다.");
      await loadMembers(listCrew);
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "신청에 실패했습니다.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[#3a3548] bg-[#17151f] shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="member-request-title"
      >
        <div className="flex items-center justify-between border-b border-[#3a3548] px-5 py-4">
          <div>
            <h2
              id="member-request-title"
              className="text-xl font-semibold text-[#e5e7eb]"
            >
              스트리머 등록 신청
            </h2>
            <p className="mt-1 text-sm text-[#a8a2b8]">
              신청 후 관리자 승인 시 반영됩니다
            </p>
          </div>
          <button
            type="button"
            className="rounded px-2 text-xl text-[#a8a2b8] hover:text-[#e5e7eb]"
            aria-label="닫기"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <section className="rounded-lg border border-[#3a3548] bg-[#111018] p-4">
            <h3 className="mb-3 text-sm font-semibold text-[#e5e7eb]">
              스트리머 추가 신청
            </h3>
            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-[#a8a2b8]">
                  등록 크루
                </span>
                <select
                  value={addCrew}
                  disabled={isLoadingCrews}
                  onChange={(event) => {
                    setAddCrew(event.target.value);
                    setSelectedStreamer(null);
                    setSearchCandidates([]);
                  }}
                  className="h-10 w-full rounded-lg border border-[#3a3548] bg-[#17151f] px-3 text-[#e5e7eb] outline-none focus:border-[#a99cff]"
                >
                  {crews.map((crew) => (
                    <option key={crew.crew_name} value={crew.crew_name}>
                      {crew.display_name}
                    </option>
                  ))}
                </select>
              </label>

              <form className="flex gap-2" onSubmit={(event) => void handleSearch(event)}>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setSelectedStreamer(null);
                    setSearchCandidates([]);
                  }}
                  placeholder="SOOP ID 또는 닉네임"
                  className="h-10 min-w-0 flex-1 rounded-lg border border-[#3a3548] bg-[#17151f] px-3 text-[#e5e7eb] outline-none focus:border-[#a99cff]"
                />
                <button
                  type="submit"
                  disabled={isSearching}
                  className="shrink-0 rounded-lg border border-[#3a3548] px-4 text-sm font-semibold text-[#d8d4ff] hover:border-[#a99cff] disabled:opacity-60"
                >
                  {isSearching ? "검색 중..." : "검색"}
                </button>
              </form>

              {searchCandidates.length > 0 ? (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-[#3a3548] bg-[#17151f] p-2">
                  {searchCandidates.map((candidate) => (
                    <button
                      key={candidate.user_id}
                      type="button"
                      disabled={!candidate.selectable}
                      onClick={() => setSelectedStreamer(candidate)}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition ${
                        selectedStreamer?.user_id === candidate.user_id
                          ? "bg-[#5b4bdb]/25 text-[#d8d4ff]"
                          : candidate.selectable
                            ? "text-[#e5e7eb] hover:bg-[#2b2836]"
                            : "cursor-not-allowed text-[#8d879c] opacity-70"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">
                          {candidate.nickname}
                        </span>
                        <span className="block truncate text-xs text-[#8d879c]">
                          {candidate.user_id}
                          {candidate.from_fa
                            ? ` · ${displayCrewName(FA_CREW_NAME)}`
                            : candidate.already_registered
                              ? ` · ${displayCrewName(candidate.existing_crew_name ?? "")}`
                              : ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs font-semibold">
                        {selectedStreamer?.user_id === candidate.user_id
                          ? "선택됨"
                          : candidate.selectable
                            ? "선택"
                            : "등록됨"}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}

              <button
                type="button"
                disabled={!selectedStreamer}
                onClick={handleQueueAdd}
                className="h-10 w-full rounded-lg bg-[#5b4bdb] text-sm font-semibold text-white transition hover:bg-[#6d5ef0] disabled:opacity-50"
              >
                대기열에 추가
              </button>
            </div>
          </section>

          <section className="rounded-lg border border-[#3a3548] bg-[#111018] p-4">
            <h3 className="mb-3 text-sm font-semibold text-[#e5e7eb]">
              멤버 상태 변경 신청
            </h3>
            <label className="mb-3 block">
              <span className="mb-1 block text-sm font-medium text-[#a8a2b8]">
                크루 선택
              </span>
              <select
                value={listCrew}
                disabled={isLoadingCrews || crews.every((crew) => isFaCrew(crew.crew_name))}
                onChange={(event) => setListCrew(event.target.value)}
                className="h-10 w-full rounded-lg border border-[#3a3548] bg-[#17151f] px-3 text-[#e5e7eb] outline-none focus:border-[#a99cff]"
              >
                {crews
                  .filter((crew) => !isFaCrew(crew.crew_name))
                  .map((crew) => (
                    <option key={crew.crew_name} value={crew.crew_name}>
                      {crew.display_name}
                    </option>
                  ))}
              </select>
            </label>

            {!listCrew || isFaCrew(listCrew) ? (
              <p className="text-sm text-[#a8a2b8]">
                상태 변경은 소속 크루 멤버만 신청할 수 있습니다.
              </p>
            ) : isLoadingMembers ? (
              <p className="text-sm text-[#a8a2b8]">멤버 불러오는 중...</p>
            ) : members.length === 0 ? (
              <p className="text-sm text-[#a8a2b8]">소속 스트리머가 없습니다.</p>
            ) : (
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {members.map((member) => {
                  const userKey = member.user_id.toLowerCase();
                  const desired = desiredByUserId[userKey] ?? currentDesiredStatus(member);

                  return (
                    <div
                      key={member.user_id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-[#3a3548] bg-[#17151f] px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[#e5e7eb]">
                          {member.nickname}
                        </p>
                        <p className="truncate text-xs text-[#8d879c]">
                          {member.user_id}
                          {member.is_on_leave ? " · 휴직" : " · 활동"}
                        </p>
                      </div>
                      <select
                        value={desired}
                        onChange={(event) =>
                          handleDesiredChange(
                            member,
                            event.target.value as DesiredStatus,
                          )
                        }
                        className="h-9 shrink-0 rounded-lg border border-[#3a3548] bg-[#111018] px-2 text-sm text-[#e5e7eb] outline-none focus:border-[#a99cff]"
                      >
                        <option value="active">활동</option>
                        <option value="leave">휴직</option>
                        <option value="retire">퇴사</option>
                      </select>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-[#3a3548] bg-[#111018] p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-[#e5e7eb]">
                신청 대기열 ({drafts.length})
              </h3>
              {drafts.length > 0 ? (
                <button
                  type="button"
                  className="text-xs font-medium text-[#a8a2b8] hover:text-[#e5e7eb]"
                  onClick={() => setDrafts([])}
                >
                  비우기
                </button>
              ) : null}
            </div>
            {drafts.length === 0 ? (
              <p className="text-sm text-[#a8a2b8]">
                추가하거나 상태를 바꾸면 여기에 쌓입니다.
              </p>
            ) : (
              <ul className="mb-3 max-h-40 space-y-1 overflow-y-auto">
                {drafts.map((draft) => (
                  <li
                    key={draft.key}
                    className="flex items-center justify-between gap-2 rounded-lg bg-[#17151f] px-3 py-2 text-sm text-[#e5e7eb]"
                  >
                    <span className="min-w-0 truncate">
                      <span className="mr-2 text-xs font-semibold text-[#a99cff]">
                        {actionLabel(draft.action)}
                      </span>
                      {draft.label}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 text-xs text-[#a8a2b8] hover:text-[#e5e7eb]"
                      onClick={() => removeDraft(draft.key)}
                    >
                      제거
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              disabled={drafts.length === 0 || isSubmitting}
              onClick={() => void handleSubmit()}
              className="h-10 w-full rounded-lg bg-[#5b4bdb] text-sm font-semibold text-white transition hover:bg-[#6d5ef0] disabled:opacity-50"
            >
              {isSubmitting ? "신청 중..." : "신청하기"}
            </button>
          </section>

          {message ? (
            <p className="rounded-lg border border-[#059669]/40 bg-[#059669]/10 px-3 py-2 text-sm text-[#6ee7b7]">
              {message}
            </p>
          ) : null}
          {error ? (
            <p className="rounded-lg border border-[#dc2626]/40 bg-[#dc2626]/10 px-3 py-2 text-sm text-[#fca5a5]">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
