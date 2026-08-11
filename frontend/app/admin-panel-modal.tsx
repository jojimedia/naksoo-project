"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { displayCrewName, isFaCrew } from "@/lib/crews";

type AdminSession = {
  login_id: string;
  crews: string[];
};

type MemberRow = {
  crew_name: string;
  user_id: string;
  nickname: string;
  note: string;
  is_on_leave: boolean;
};

type ValidatedStreamer = {
  user_id: string;
  nickname: string;
  from_fa?: boolean;
};

type SearchCandidate = {
  user_id: string;
  nickname: string;
  profile_image_url?: string | null;
  already_registered: boolean;
  from_fa: boolean;
  existing_crew_name: string | null;
  selectable: boolean;
};

type AdminPanelModalProps = {
  session: AdminSession;
  onClose: () => void;
  onLogout: () => void;
};

export default function AdminPanelModal({
  session,
  onClose,
  onLogout,
}: AdminPanelModalProps) {
  const managedCrews = session.crews;
  const assignableCrews = useMemo(
    () => managedCrews.filter((crew) => !isFaCrew(crew)),
    [managedCrews],
  );
  const defaultCrew =
    managedCrews.find((crew) => isFaCrew(crew)) ?? managedCrews[0] ?? "";
  const [selectedCrew, setSelectedCrew] = useState(defaultCrew);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [membersVersion, setMembersVersion] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCandidates, setSearchCandidates] = useState<SearchCandidate[]>(
    [],
  );
  const [validatedStreamer, setValidatedStreamer] =
    useState<ValidatedStreamer | null>(null);
  const [assigningUserId, setAssigningUserId] = useState<string | null>(null);
  const [assignMenuPos, setAssignMenuPos] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const [pendingAssignments, setPendingAssignments] = useState<
    Record<string, string>
  >({});
  const [transferredMembers, setTransferredMembers] = useState<MemberRow[]>(
    [],
  );
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isAssigning, setIsAssigning] = useState(false);
  const [isTriggeringUpdate, setIsTriggeringUpdate] = useState(false);
  const [isUpdateRunning, setIsUpdateRunning] = useState(false);
  const selectingFaCrew = isFaCrew(selectedCrew);
  const pendingCount = Object.keys(pendingAssignments).length;
  const displayMembers = useMemo(() => {
    const transferredIds = new Set(
      transferredMembers.map((member) => member.user_id.toLowerCase()),
    );

    if (selectingFaCrew) {
      return members.filter(
        (member) => !transferredIds.has(member.user_id.toLowerCase()),
      );
    }

    const merged = new Map(
      members.map((member) => [member.user_id.toLowerCase(), member]),
    );

    for (const member of transferredMembers) {
      if (
        member.crew_name === selectedCrew &&
        !merged.has(member.user_id.toLowerCase())
      ) {
        merged.set(member.user_id.toLowerCase(), member);
      }
    }

    return Array.from(merged.values());
  }, [members, selectedCrew, selectingFaCrew, transferredMembers]);

  const loadMembers = useCallback(
    async (
      crewName: string,
      options?: {
        silent?: boolean;
      },
    ) => {
      if (!crewName) {
        setMembers([]);
        setMembersVersion("");
        return;
      }

      if (!options?.silent) {
        setIsLoading(true);
        setError("");
      }

      try {
        const response = await fetch(
          `/api/admin/members?crew=${encodeURIComponent(crewName)}`,
        );
        const data = (await response.json()) as {
          error?: string;
          members?: MemberRow[];
          version?: string;
        };

        if (!response.ok) {
          throw new Error(data.error ?? "멤버 목록을 불러오지 못했습니다.");
        }

        setMembers(data.members ?? []);
        setMembersVersion(data.version ?? "");
        setTransferredMembers((current) => {
          if (current.length === 0 || isFaCrew(crewName)) {
            return current;
          }

          const remoteIds = new Set(
            (data.members ?? []).map((member) =>
              member.user_id.toLowerCase(),
            ),
          );

          return current.filter((member) => {
            if (member.crew_name !== crewName) {
              return true;
            }

            return !remoteIds.has(member.user_id.toLowerCase());
          });
        });
      } catch (loadError) {
        if (!options?.silent) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "멤버 목록을 불러오지 못했습니다.",
          );
        }
      } finally {
        if (!options?.silent) {
          setIsLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void loadMembers(selectedCrew);
  }, [loadMembers, selectedCrew]);

  useEffect(() => {
    if (!selectedCrew) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void loadMembers(selectedCrew, { silent: true });
    }, 60_000);

    return () => window.clearInterval(intervalId);
  }, [loadMembers, selectedCrew]);

  const refreshUpdateStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/trigger-update");
      const data = (await response.json()) as {
        error?: string;
        running?: boolean;
      };

      if (!response.ok) {
        return;
      }

      setIsUpdateRunning(Boolean(data.running));
    } catch {
      // Ignore polling errors.
    }
  }, []);

  useEffect(() => {
    void refreshUpdateStatus();

    const intervalId = window.setInterval(() => {
      void refreshUpdateStatus();
    }, 15_000);

    return () => window.clearInterval(intervalId);
  }, [refreshUpdateStatus]);

  async function handleMemberConflict() {
    await loadMembers(selectedCrew);
    setError("다른 기기에서 목록이 변경되었습니다. 목록을 새로 불러왔습니다.");
  }

  async function handleSearchStreamers() {
    const query = searchQuery.trim();

    if (!query) {
      setError("SOOP ID 또는 닉네임을 입력해주세요.");
      return;
    }

    if (query.length < 2) {
      setError("검색어는 2글자 이상 입력해주세요.");
      return;
    }

    setIsSearching(true);
    setError("");
    setMessage("");
    setValidatedStreamer(null);
    setSearchCandidates([]);

    try {
      const response = await fetch(
        `/api/admin/streamers/search?q=${encodeURIComponent(query)}&crew=${encodeURIComponent(selectedCrew)}`,
      );
      const data = (await response.json()) as {
        error?: string;
        candidates?: SearchCandidate[];
      };

      if (!response.ok) {
        throw new Error(data.error ?? "스트리머 검색에 실패했습니다.");
      }

      const candidates = data.candidates ?? [];
      setSearchCandidates(candidates);

      if (candidates.length === 0) {
        setError("검색 결과가 없습니다. ID 또는 닉네임을 확인해주세요.");
      }
    } catch (searchError) {
      setError(
        searchError instanceof Error
          ? searchError.message
          : "스트리머 검색에 실패했습니다.",
      );
    } finally {
      setIsSearching(false);
    }
  }

  function handleSelectCandidate(candidate: SearchCandidate) {
    if (!candidate.selectable) {
      setError(
        candidate.already_registered
          ? `이미 ${displayCrewName(candidate.existing_crew_name ?? "다른")} 크루에 등록된 스트리머입니다.`
          : "선택할 수 없는 스트리머입니다.",
      );
      return;
    }

    setError("");
    setValidatedStreamer({
      user_id: candidate.user_id,
      nickname: candidate.nickname,
      from_fa: candidate.from_fa,
    });
    setMessage(
      candidate.from_fa
        ? "무소속입니다. 등록하면 이 크루로 이동합니다."
        : `${candidate.nickname} 님을 선택했습니다.`,
    );
  }

  async function handleAddMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!validatedStreamer) {
      return;
    }

    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/admin/members", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          crew_name: selectedCrew,
          user_id: validatedStreamer.user_id,
          expected_version: membersVersion,
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        version?: string;
      };

      if (response.status === 409) {
        await handleMemberConflict();
        return;
      }

      if (!response.ok) {
        throw new Error(data.error ?? "멤버 등록에 실패했습니다.");
      }

      if (data.version) {
        setMembersVersion(data.version);
      }

      setMessage(
        validatedStreamer.from_fa
          ? `${validatedStreamer.nickname} 님을 무소속에서 이 크루로 이동했습니다.`
          : selectingFaCrew
            ? `${validatedStreamer.nickname} 님을 무소속으로 등록했습니다.`
            : `${validatedStreamer.nickname} 님을 등록했습니다.`,
      );
      setSearchQuery("");
      setSearchCandidates([]);
      setValidatedStreamer(null);
      await loadMembers(selectedCrew);
    } catch (addError) {
      setError(
        addError instanceof Error
          ? addError.message
          : "멤버 등록에 실패했습니다.",
      );
    }
  }

  function handleAssignCrew(userId: string, targetCrew: string) {
    setPendingAssignments((current) => ({
      ...current,
      [userId]: targetCrew,
    }));
    setAssigningUserId(null);
    setAssignMenuPos(null);
    setError("");
    setMessage("");
  }

  async function handleApplyAssignments() {
    const assignments = Object.entries(pendingAssignments).map(
      ([userId, targetCrew]) => ({
        user_id: userId,
        target_crew: targetCrew,
      }),
    );

    if (assignments.length === 0) {
      return;
    }

    setIsAssigning(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/admin/members", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          assignments,
          expected_version: membersVersion,
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        version?: string;
        assigned?: number;
        members?: MemberRow[];
      };

      if (response.status === 409) {
        await handleMemberConflict();
        return;
      }

      if (!response.ok) {
        throw new Error(data.error ?? "크루 배정에 실패했습니다.");
      }

      const moved = data.members ?? [];
      setTransferredMembers((current) => {
        const next = new Map(
          current.map((member) => [member.user_id.toLowerCase(), member]),
        );

        for (const member of moved) {
          next.set(member.user_id.toLowerCase(), member);
        }

        return Array.from(next.values());
      });
      setPendingAssignments({});
      setAssigningUserId(null);
      setAssignMenuPos(null);
      setMessage(`${data.assigned ?? moved.length}명의 크루 배정을 적용했습니다.`);
      await loadMembers(selectedCrew);
    } catch (assignError) {
      setError(
        assignError instanceof Error
          ? assignError.message
          : "크루 배정에 실패했습니다.",
      );
    } finally {
      setIsAssigning(false);
    }
  }

  async function handleDeleteMember(userId: string) {
    if (
      !window.confirm(
        `${userId} 멤버를 시트에서 완전히 삭제할까요?\n이 작업은 되돌릴 수 없습니다.`,
      )
    ) {
      return;
    }

    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/admin/members", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          crew_name: selectedCrew,
          user_id: userId,
          expected_version: membersVersion,
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        version?: string;
      };

      if (response.status === 409) {
        await handleMemberConflict();
        return;
      }

      if (!response.ok) {
        throw new Error(data.error ?? "삭제에 실패했습니다.");
      }

      if (data.version) {
        setMembersVersion(data.version);
      }

      setPendingAssignments((current) => {
        const next = { ...current };
        delete next[userId];
        return next;
      });
      setMessage(`${userId} 멤버를 삭제했습니다.`);
      await loadMembers(selectedCrew);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "삭제에 실패했습니다.",
      );
    }
  }

  async function handleRetireMember(userId: string) {
    if (
      !window.confirm(
        `${userId} 멤버를 퇴사 처리할까요?\n크루명이 무소속(FA)으로 변경되며 시트에서 삭제되지 않습니다.`,
      )
    ) {
      return;
    }

    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/admin/members", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          crew_name: selectedCrew,
          user_id: userId,
          expected_version: membersVersion,
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        version?: string;
      };

      if (response.status === 409) {
        await handleMemberConflict();
        return;
      }

      if (!response.ok) {
        throw new Error(data.error ?? "퇴사 처리에 실패했습니다.");
      }

      if (data.version) {
        setMembersVersion(data.version);
      }

      setMessage(`${userId} 멤버를 무소속으로 이동했습니다.`);
      await loadMembers(selectedCrew);
    } catch (retireError) {
      setError(
        retireError instanceof Error
          ? retireError.message
          : "퇴사 처리에 실패했습니다.",
      );
    }
  }

  async function handleToggleLeave(member: MemberRow) {
    const nextNote = member.is_on_leave ? "" : "휴직";

    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/admin/members", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          crew_name: selectedCrew,
          user_id: member.user_id,
          note: nextNote,
          expected_version: membersVersion,
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        version?: string;
      };

      if (response.status === 409) {
        await handleMemberConflict();
        return;
      }

      if (!response.ok) {
        throw new Error(data.error ?? "휴직 상태 변경에 실패했습니다.");
      }

      if (data.version) {
        setMembersVersion(data.version);
      }

      setMessage(
        nextNote === "휴직"
          ? `${member.user_id} 멤버를 휴직 처리했습니다.`
          : `${member.user_id} 멤버를 복직 처리했습니다.`,
      );
      await loadMembers(selectedCrew);
    } catch (toggleError) {
      setError(
        toggleError instanceof Error
          ? toggleError.message
          : "휴직 상태 변경에 실패했습니다.",
      );
    }
  }

  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    onLogout();
  }

  async function handleTriggerUpdate() {
    if (isUpdateRunning) {
      setError("이미 데이터 갱신이 진행 중입니다.");
      return;
    }

    if (
      !window.confirm(
        "데이터 갱신을 요청할까요?\n크롤이 시작되며 5~15분 후 대시보드에 반영됩니다.",
      )
    ) {
      return;
    }

    setIsTriggeringUpdate(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/admin/trigger-update", {
        method: "POST",
      });
      const data = (await response.json()) as {
        error?: string;
        message?: string;
        running?: boolean;
      };

      if (response.status === 409) {
        setIsUpdateRunning(true);
        setError(data.error ?? "이미 데이터 갱신이 진행 중입니다.");
        return;
      }

      if (!response.ok) {
        throw new Error(data.error ?? "데이터 갱신 요청에 실패했습니다.");
      }

      setIsUpdateRunning(true);
      setMessage(data.message ?? "데이터 갱신을 요청했습니다.");
    } catch (triggerError) {
      setError(
        triggerError instanceof Error
          ? triggerError.message
          : "데이터 갱신 요청에 실패했습니다.",
      );
    } finally {
      setIsTriggeringUpdate(false);
      void refreshUpdateStatus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[#3a3548] bg-[#17151f] shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-panel-title"
      >
        <div className="flex items-center justify-between border-b border-[#3a3548] px-5 py-4">
          <div>
            <h2
              id="admin-panel-title"
              className="text-xl font-semibold text-[#e5e7eb]"
            >
              크루 관리
            </h2>
            <p className="mt-1 text-sm text-[#a8a2b8]">{session.login_id}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="rounded-lg border border-[#5b4bdb]/50 px-3 py-1.5 text-sm font-medium text-[#d8d4ff] hover:border-[#a99cff] disabled:opacity-60"
              onClick={() => void handleTriggerUpdate()}
              disabled={isTriggeringUpdate || isUpdateRunning}
            >
              {isTriggeringUpdate
                ? "요청 중..."
                : isUpdateRunning
                  ? "갱신 중..."
                  : "데이터 갱신"}
            </button>
            <button
              type="button"
              className="rounded-lg border border-[#3a3548] px-3 py-1.5 text-sm font-medium text-[#a8a2b8] hover:text-[#e5e7eb]"
              onClick={() => void handleLogout()}
            >
              로그아웃
            </button>
            <button
              type="button"
              className="rounded px-2 text-xl text-[#a8a2b8] hover:text-[#e5e7eb]"
              aria-label="닫기"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </div>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[#a8a2b8]">
              관리 크루
            </span>
            <select
              value={selectedCrew}
              onChange={(event) => {
                setSelectedCrew(event.target.value);
                setSearchQuery("");
                setSearchCandidates([]);
                setValidatedStreamer(null);
                setAssigningUserId(null);
                setAssignMenuPos(null);
                setPendingAssignments({});
                setMessage("");
                setError("");
              }}
              className="h-10 w-full rounded-lg border border-[#3a3548] bg-[#111018] px-3 text-[#e5e7eb] outline-none focus:border-[#a99cff]"
            >
              {managedCrews.map((crew) => (
                <option key={crew} value={crew}>
                  {displayCrewName(crew)}
                </option>
              ))}
            </select>
          </label>

          <section className="rounded-lg border border-[#3a3548] bg-[#111018] p-4">
            <h3 className="mb-3 text-sm font-semibold text-[#e5e7eb]">
              스트리머 추가
              {selectingFaCrew ? " · 무소속" : ` · ${selectedCrew}`}
            </h3>
            <form className="space-y-3" onSubmit={handleAddMember}>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setValidatedStreamer(null);
                    setSearchCandidates([]);
                  }}
                  placeholder="SOOP ID 또는 닉네임"
                  className="h-10 min-w-0 flex-1 rounded-lg border border-[#3a3548] bg-[#17151f] px-3 text-[#e5e7eb] outline-none focus:border-[#a99cff]"
                />
                <button
                  type="button"
                  onClick={() => void handleSearchStreamers()}
                  disabled={isSearching}
                  className="shrink-0 rounded-lg border border-[#3a3548] px-4 text-sm font-semibold text-[#d8d4ff] hover:border-[#a99cff] disabled:opacity-60"
                >
                  {isSearching ? "검색 중..." : "검색"}
                </button>
              </div>

              {searchCandidates.length > 0 ? (
                <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-[#3a3548] bg-[#17151f] p-2">
                  <p className="px-1 pb-1 text-xs font-medium text-[#a8a2b8]">
                    유사 스트리머를 선택하세요
                  </p>
                  {searchCandidates.map((candidate) => (
                    <button
                      key={candidate.user_id}
                      type="button"
                      disabled={!candidate.selectable}
                      onClick={() => handleSelectCandidate(candidate)}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition ${
                        validatedStreamer?.user_id === candidate.user_id
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
                            ? " · 무소속"
                            : candidate.already_registered
                              ? ` · ${displayCrewName(candidate.existing_crew_name ?? "")}`
                              : ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs font-semibold">
                        {validatedStreamer?.user_id === candidate.user_id
                          ? "선택됨"
                          : candidate.selectable
                            ? "선택"
                            : "등록됨"}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}

              {validatedStreamer ? (
                <div className="rounded-lg border border-[#5b4bdb]/40 bg-[#5b4bdb]/10 px-3 py-2 text-sm text-[#d8d4ff]">
                  {validatedStreamer.nickname} ({validatedStreamer.user_id})
                  {validatedStreamer.from_fa ? " · 무소속에서 이동" : ""}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={!validatedStreamer}
                className="h-10 w-full rounded-lg bg-[#5b4bdb] text-sm font-semibold text-white transition hover:bg-[#6d5ef0] disabled:opacity-50"
              >
                {selectingFaCrew ? "무소속으로 등록" : "등록"}
              </button>
            </form>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[#e5e7eb]">멤버 목록</h3>
              <div className="flex items-center gap-2">
                {selectingFaCrew ? (
                  <button
                    type="button"
                    className="rounded border border-[#5b4bdb]/50 px-2.5 py-1 text-xs font-semibold text-[#d8d4ff] hover:border-[#a99cff] disabled:opacity-50"
                    disabled={pendingCount === 0 || isAssigning}
                    onClick={() => void handleApplyAssignments()}
                  >
                    {isAssigning
                      ? "적용 중..."
                      : pendingCount > 0
                        ? `수정 (${pendingCount})`
                        : "수정"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="text-xs font-medium text-[#a8a2b8] hover:text-[#e5e7eb]"
                  onClick={() => void loadMembers(selectedCrew)}
                >
                  새로고침
                </button>
                <span className="text-xs text-[#a8a2b8]">
                  {displayMembers.length}명
                </span>
              </div>
            </div>

            {isLoading ? (
              <p className="text-sm text-[#a8a2b8]">불러오는 중...</p>
            ) : displayMembers.length > 0 ? (
              <div className="overflow-visible rounded-lg border border-[#3a3548]">
                <div className="grid grid-cols-[minmax(0,1fr)_120px_88px] gap-2 border-b border-[#3a3548] bg-[#111018] px-3 py-2 text-xs font-semibold text-[#a8a2b8]">
                  <p>닉네임 / ID</p>
                  <p>{selectingFaCrew ? "소속" : "상태"}</p>
                  <p className="text-right">액션</p>
                </div>
                {displayMembers.map((member) => {
                  const pendingCrew = pendingAssignments[member.user_id];

                  return (
                  <div
                    key={member.user_id}
                    className="relative grid grid-cols-[minmax(0,1fr)_120px_88px] items-center gap-2 border-b border-[#3a3548]/70 px-3 py-2 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-[#e5e7eb]">
                        {member.nickname || member.user_id}
                      </p>
                      <p className="truncate text-xs text-[#8d879c]">
                        {member.user_id}
                      </p>
                    </div>
                    {selectingFaCrew ? (
                      <div>
                        <button
                          type="button"
                          className={`max-w-full truncate rounded border px-2 py-1 text-xs font-semibold ${
                            pendingCrew
                              ? "border-[#a99cff]/60 text-[#d8d4ff]"
                              : "border-[#0F766E]/50 text-[#99f6e4] hover:border-[#2dd4bf]"
                          }`}
                          onClick={(event) => {
                            if (assigningUserId === member.user_id) {
                              setAssigningUserId(null);
                              setAssignMenuPos(null);
                              return;
                            }

                            const rect =
                              event.currentTarget.getBoundingClientRect();
                            setAssigningUserId(member.user_id);
                            setAssignMenuPos({
                              left: rect.left,
                              top: rect.top,
                            });
                          }}
                          disabled={isAssigning}
                          title={pendingCrew ?? "무소속"}
                        >
                          {pendingCrew ?? "무소속"}
                        </button>
                        {assigningUserId === member.user_id &&
                        assignMenuPos ? (
                          <div
                            className="fixed z-[80] max-h-48 w-44 -translate-y-full overflow-y-auto rounded-lg border border-[#3a3548] bg-[#17151f] py-1 shadow-xl"
                            style={{
                              left: assignMenuPos.left,
                              top: assignMenuPos.top - 6,
                            }}
                          >
                            <button
                              type="button"
                              className="block w-full px-3 py-1.5 text-left text-xs font-medium text-[#99f6e4] hover:bg-[#2b2836]"
                              disabled={isAssigning}
                              onClick={() => {
                                setPendingAssignments((current) => {
                                  const next = { ...current };
                                  delete next[member.user_id];
                                  return next;
                                });
                                setAssigningUserId(null);
                                setAssignMenuPos(null);
                              }}
                            >
                              무소속
                            </button>
                            {assignableCrews.length > 0 ? (
                              assignableCrews.map((crew) => (
                                <button
                                  key={crew}
                                  type="button"
                                  className="block w-full px-3 py-1.5 text-left text-xs font-medium text-[#e5e7eb] hover:bg-[#2b2836]"
                                  disabled={isAssigning}
                                  onClick={() =>
                                    handleAssignCrew(member.user_id, crew)
                                  }
                                >
                                  {crew}
                                </button>
                              ))
                            ) : (
                              <p className="px-3 py-2 text-xs text-[#8d879c]">
                                배정 가능한 크루가 없습니다.
                              </p>
                            )}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <p
                        className={`text-xs font-semibold ${
                          member.is_on_leave
                            ? "text-[#fbbf24]"
                            : "text-[#86efac]"
                        }`}
                      >
                        {member.is_on_leave ? "휴직" : "활동"}
                      </p>
                    )}
                    <div className="flex justify-end gap-1">
                      {selectingFaCrew ? (
                        <button
                          type="button"
                          className="rounded border border-[#dc2626]/40 px-2 py-1 text-xs font-semibold text-[#fca5a5] hover:border-[#dc2626]"
                          onClick={() => void handleDeleteMember(member.user_id)}
                        >
                          삭제
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="rounded border border-[#3a3548] px-2 py-1 text-xs font-semibold text-[#d8d4ff] hover:border-[#a99cff]"
                            onClick={() => void handleToggleLeave(member)}
                          >
                            {member.is_on_leave ? "복직" : "휴직"}
                          </button>
                          <button
                            type="button"
                            className="rounded border border-[#dc2626]/40 px-2 py-1 text-xs font-semibold text-[#fca5a5] hover:border-[#dc2626]"
                            onClick={() =>
                              void handleRetireMember(member.user_id)
                            }
                          >
                            퇴사
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            ) : (
              <p className="rounded-lg border border-[#3a3548] px-3 py-6 text-center text-sm text-[#a8a2b8]">
                등록된 멤버가 없습니다.
              </p>
            )}
          </section>

          {message ? (
            <p className="text-sm font-medium text-[#86efac]">{message}</p>
          ) : null}
          {error ? (
            <p className="text-sm font-medium text-[#fca5a5]">{error}</p>
          ) : null}

          <p className="text-xs leading-5 text-[#8d879c]">
            다른 기기·다른 관리자가 갱신 중이면 버튼이 비활성화됩니다. 시트
            변경 후 「데이터 갱신」을 눌러주세요.
          </p>
        </div>
      </div>
    </div>
  );
}
