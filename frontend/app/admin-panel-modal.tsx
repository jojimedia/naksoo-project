"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

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
  const [selectedCrew, setSelectedCrew] = useState(session.crews[0] ?? "");
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [membersVersion, setMembersVersion] = useState("");
  const [searchUserId, setSearchUserId] = useState("");
  const [validatedStreamer, setValidatedStreamer] =
    useState<ValidatedStreamer | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isTriggeringUpdate, setIsTriggeringUpdate] = useState(false);
  const [isUpdateRunning, setIsUpdateRunning] = useState(false);

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
    }, 30_000);

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

  async function handleValidate() {
    const userId = searchUserId.trim();

    if (!userId) {
      setError("SOOP ID를 입력해주세요.");
      return;
    }

    setIsValidating(true);
    setError("");
    setMessage("");
    setValidatedStreamer(null);

    try {
      const response = await fetch(
        `/api/admin/streamers/validate?user_id=${encodeURIComponent(userId)}&crew=${encodeURIComponent(selectedCrew)}`,
      );
      const data = (await response.json()) as {
        error?: string;
        valid?: boolean;
        already_registered?: boolean;
        existing_crew_name?: string;
        user_id?: string;
        nickname?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "스트리머 검증에 실패했습니다.");
      }

      if (data.already_registered) {
        setError(
          data.error ??
            `이미 ${data.existing_crew_name ?? "다른"} 크루에 등록된 스트리머입니다.`,
        );
        return;
      }

      if (!data.valid || !data.user_id || !data.nickname) {
        setError("유효하지 않은 SOOP ID입니다.");
        return;
      }

      setValidatedStreamer({
        user_id: data.user_id,
        nickname: data.nickname,
      });
    } catch (validateError) {
      setError(
        validateError instanceof Error
          ? validateError.message
          : "스트리머 검증에 실패했습니다.",
      );
    } finally {
      setIsValidating(false);
    }
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

      setMessage(`${validatedStreamer.nickname} 님을 등록했습니다.`);
      setSearchUserId("");
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

  async function handleDeleteMember(userId: string) {
    if (!window.confirm(`${userId} 멤버를 삭제할까요?`)) {
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
        throw new Error(data.error ?? "멤버 삭제에 실패했습니다.");
      }

      if (data.version) {
        setMembersVersion(data.version);
      }

      setMessage(`${userId} 멤버를 삭제했습니다.`);
      await loadMembers(selectedCrew);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "멤버 삭제에 실패했습니다.",
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
              onChange={(event) => setSelectedCrew(event.target.value)}
              className="h-10 w-full rounded-lg border border-[#3a3548] bg-[#111018] px-3 text-[#e5e7eb] outline-none focus:border-[#a99cff]"
            >
              {session.crews.map((crew) => (
                <option key={crew} value={crew}>
                  {crew}
                </option>
              ))}
            </select>
          </label>

          <section className="rounded-lg border border-[#3a3548] bg-[#111018] p-4">
            <h3 className="mb-3 text-sm font-semibold text-[#e5e7eb]">
              스트리머 추가
            </h3>
            <form className="space-y-3" onSubmit={handleAddMember}>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={searchUserId}
                  onChange={(event) => {
                    setSearchUserId(event.target.value);
                    setValidatedStreamer(null);
                  }}
                  placeholder="SOOP ID"
                  className="h-10 min-w-0 flex-1 rounded-lg border border-[#3a3548] bg-[#17151f] px-3 text-[#e5e7eb] outline-none focus:border-[#a99cff]"
                />
                <button
                  type="button"
                  onClick={() => void handleValidate()}
                  disabled={isValidating}
                  className="shrink-0 rounded-lg border border-[#3a3548] px-4 text-sm font-semibold text-[#d8d4ff] hover:border-[#a99cff] disabled:opacity-60"
                >
                  {isValidating ? "검색 중..." : "검색"}
                </button>
              </div>

              {validatedStreamer ? (
                <div className="rounded-lg border border-[#5b4bdb]/40 bg-[#5b4bdb]/10 px-3 py-2 text-sm text-[#d8d4ff]">
                  {validatedStreamer.nickname} ({validatedStreamer.user_id})
                </div>
              ) : null}

              <button
                type="submit"
                disabled={!validatedStreamer}
                className="h-10 w-full rounded-lg bg-[#5b4bdb] text-sm font-semibold text-white transition hover:bg-[#6d5ef0] disabled:opacity-50"
              >
                등록
              </button>
            </form>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[#e5e7eb]">멤버 목록</h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="text-xs font-medium text-[#a8a2b8] hover:text-[#e5e7eb]"
                  onClick={() => void loadMembers(selectedCrew)}
                >
                  새로고침
                </button>
                <span className="text-xs text-[#a8a2b8]">{members.length}명</span>
              </div>
            </div>

            {isLoading ? (
              <p className="text-sm text-[#a8a2b8]">불러오는 중...</p>
            ) : members.length > 0 ? (
              <div className="overflow-hidden rounded-lg border border-[#3a3548]">
                <div className="grid grid-cols-[minmax(0,1fr)_72px_148px] gap-2 border-b border-[#3a3548] bg-[#111018] px-3 py-2 text-xs font-semibold text-[#a8a2b8]">
                  <p>닉네임 / ID</p>
                  <p>상태</p>
                  <p className="text-right">액션</p>
                </div>
                {members.map((member) => (
                  <div
                    key={member.user_id}
                    className="grid grid-cols-[minmax(0,1fr)_72px_148px] items-center gap-2 border-b border-[#3a3548]/70 px-3 py-2 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-[#e5e7eb]">
                        {member.nickname || member.user_id}
                      </p>
                      <p className="truncate text-xs text-[#8d879c]">
                        {member.user_id}
                      </p>
                    </div>
                    <p
                      className={`text-xs font-semibold ${
                        member.is_on_leave ? "text-[#fbbf24]" : "text-[#86efac]"
                      }`}
                    >
                      {member.is_on_leave ? "휴직" : "활동"}
                    </p>
                    <div className="flex justify-end gap-1">
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
                        onClick={() => void handleDeleteMember(member.user_id)}
                      >
                        삭제
                      </button>
                    </div>
                  </div>
                ))}
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
