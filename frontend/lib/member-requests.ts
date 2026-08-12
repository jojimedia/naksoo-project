import { validateSoopUser } from "@/lib/admin-auth";
import { isFaCrew } from "@/lib/crews";
import {
  findMember,
  findMemberByUserId,
  listPublicCrewNames,
  type MemberRequestAction,
  type NewMemberRequestInput,
} from "@/lib/google-sheets";

export type PublicMemberRequestDraft = NewMemberRequestInput;

function normalizeAction(value: unknown): MemberRequestAction | null {
  if (typeof value !== "string") {
    return null;
  }

  const action = value.trim().toLowerCase();

  if (
    action === "add" ||
    action === "leave" ||
    action === "restore" ||
    action === "retire"
  ) {
    return action;
  }

  return null;
}

export async function assertValidPublicCrew(crewName: string) {
  const crews = await listPublicCrewNames();
  const allowed = crews.some((crew) =>
    isFaCrew(crewName) ? isFaCrew(crew) : crew === crewName,
  );

  if (!allowed) {
    throw new Error("선택할 수 없는 크루입니다.");
  }
}

export async function validateMemberRequestDraft(
  draft: PublicMemberRequestDraft,
): Promise<PublicMemberRequestDraft> {
  const action = normalizeAction(draft.action);
  const crewName = draft.crew_name.trim();
  const userId = draft.user_id.trim();
  let nickname = draft.nickname.trim();

  if (!action) {
    throw new Error("지원하지 않는 신청 유형입니다.");
  }

  if (!crewName || !userId) {
    throw new Error("크루와 스트리머 정보가 필요합니다.");
  }

  await assertValidPublicCrew(crewName);

  if (action === "add") {
    const validated = await validateSoopUser(userId);

    if (!validated) {
      throw new Error("존재하지 않는 SOOP ID입니다.");
    }

    nickname = validated.nickname || nickname || userId;

    const existing = await findMemberByUserId(validated.user_id);

    if (existing) {
      const sameCrew = isFaCrew(crewName)
        ? isFaCrew(existing.crew_name)
        : existing.crew_name === crewName;

      if (sameCrew) {
        throw new Error(
          isFaCrew(crewName)
            ? "이미 무소속으로 등록된 스트리머입니다."
            : "이미 이 크루에 등록된 스트리머입니다.",
        );
      }

      if (isFaCrew(existing.crew_name) && !isFaCrew(crewName)) {
        return {
          action,
          crew_name: crewName,
          user_id: validated.user_id,
          nickname,
        };
      }

      if (isFaCrew(crewName)) {
        throw new Error(
          `이미 ${existing.crew_name} 크루에 등록된 스트리머입니다. 해당 크루에서 퇴사 처리해주세요.`,
        );
      }

      throw new Error(
        `이미 ${existing.crew_name} 크루에 등록된 스트리머입니다.`,
      );
    }

    return {
      action,
      crew_name: isFaCrew(crewName) ? "FA" : crewName,
      user_id: validated.user_id,
      nickname,
    };
  }

  if (isFaCrew(crewName) && action === "retire") {
    throw new Error("무소속 멤버는 퇴사 신청할 수 없습니다.");
  }

  const member = await findMember(crewName, userId);

  if (!member) {
    throw new Error("해당 크루에서 멤버를 찾을 수 없습니다.");
  }

  if (action === "leave" && member.is_on_leave) {
    throw new Error("이미 휴직 상태입니다.");
  }

  if (action === "restore" && !member.is_on_leave) {
    throw new Error("휴직 상태가 아닙니다.");
  }

  return {
    action,
    crew_name: isFaCrew(member.crew_name) ? "FA" : member.crew_name,
    user_id: member.user_id,
    nickname: member.nickname || nickname || member.user_id,
  };
}

export async function validateMemberRequestDrafts(
  drafts: PublicMemberRequestDraft[],
) {
  if (!Array.isArray(drafts) || drafts.length === 0) {
    throw new Error("신청할 항목이 없습니다.");
  }

  if (drafts.length > 50) {
    throw new Error("한 번에 최대 50건까지 신청할 수 있습니다.");
  }

  const validated: PublicMemberRequestDraft[] = [];
  const seen = new Set<string>();

  for (const draft of drafts) {
    const next = await validateMemberRequestDraft(draft);
    const key = `${next.action}:${next.crew_name.toLowerCase()}:${next.user_id.toLowerCase()}`;

    if (seen.has(key)) {
      throw new Error(`${next.user_id} 신청이 중복되었습니다.`);
    }

    seen.add(key);
    validated.push(next);
  }

  return validated;
}
