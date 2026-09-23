import { FA_CREW_NAME, isFaCrew } from "./crews";
import { getTrimmedAverage } from "./stats";

type Member = {
  user_id: string;
  crew_name: string;
  nickname: string;
  note: string;
  is_on_leave: boolean;
};

type CardMember = {
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
  current_daily_balloons?: unknown[];
  previous_daily_balloons?: unknown[];
  monthly_fans: unknown[];
  monthly_top_fans: unknown[];
  is_on_leave?: boolean;
};

type CardCrew<TMember extends CardMember = CardMember> = {
  rank: number;
  crew_name: string;
  member_count: number;
  current_total_balloons: number;
  average_current_balloons: number;
  members: TMember[];
  naksoo_gods: unknown[];
  crew_kings: unknown[];
};

/** Apply authoritative membership while reusing collected stats by SOOP ID. */
export function alignMembership<T extends { user_id?: string }>(items: T[], members: Member[]) {
  const byId = new Map(items.map((item) => [String(item.user_id).toLowerCase(), item]));
  return members.map((member) => ({
    ...byId.get(member.user_id.toLowerCase()),
    ...member,
    success: true,
  }));
}

export function canonicalCrewName(name: string, registeredCrews: string[] = []) {
  const trimmed = name.trim();
  if (!trimmed || isFaCrew(trimmed)) {
    return FA_CREW_NAME;
  }

  const match = registeredCrews.find(
    (crew) => crew.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  return match?.trim() || trimmed;
}

function profileImageUrl(userId: string, existing?: string) {
  if (existing) {
    return existing;
  }

  const prefix = userId.slice(0, 2);
  return `https://stimg.sooplive.com/LOGO/${prefix}/${userId}/m/${userId}.webp`;
}

function placeholderMember(member: Member): CardMember {
  return {
    rank: 0,
    user_id: member.user_id,
    nickname: member.nickname || member.user_id,
    profile_image_url: profileImageUrl(member.user_id),
    broadcast_start: null,
    is_live: false,
    current_balloons: 0,
    previous_balloons: 0,
    change_balloons: 0,
    change_rate: 0,
    display_day_balloons: 0,
    current_daily_balloons: [],
    previous_daily_balloons: [],
    monthly_fans: [],
    monthly_top_fans: [],
    is_on_leave: member.is_on_leave,
  };
}

function crewKey(name: string) {
  return isFaCrew(name) ? "fa" : name.trim().toLowerCase();
}

/**
 * Rebuild crew cards from the members table, keeping collected stats by SOOP ID.
 * Admin roster is the source of truth, including uncollected IDs and GD/gd aliases.
 */
export function applyMembershipToDashboard<T extends CardCrew>(
  crews: T[],
  faCrew: T | null,
  members: Member[],
  registeredCrews: string[] = [],
): { crews: T[]; fa_crew: T | null } {
  const statsById = new Map<string, T["members"][number]>();
  const previousByKey = new Map<string, T>();

  for (const crew of [...crews, faCrew].filter((crew): crew is T => Boolean(crew))) {
    previousByKey.set(crewKey(crew.crew_name), crew);
    for (const member of crew.members) {
      statsById.set(member.user_id.toLowerCase(), member);
    }
  }

  const grouped = new Map<string, T["members"]>();
  const displayNames = new Map<string, string>();

  for (const member of members) {
    const crewName = canonicalCrewName(member.crew_name, registeredCrews);
    const key = crewKey(crewName);
    displayNames.set(key, isFaCrew(crewName) ? FA_CREW_NAME : crewName);
    const stats = statsById.get(member.user_id.toLowerCase());
    const row = {
      ...(stats ?? placeholderMember(member)),
      user_id: member.user_id,
      nickname: member.nickname || stats?.nickname || member.user_id,
      profile_image_url: profileImageUrl(
        member.user_id,
        stats?.profile_image_url,
      ),
      is_on_leave: member.is_on_leave,
    } as T["members"][number];
    const list: T["members"] = grouped.get(key) ?? ([] as T["members"]);
    list.push(row);
    grouped.set(key, list);
  }

  function buildCrew(key: string, rows: T["members"]): T {
    const previous = previousByKey.get(key);
    const active = rows.filter((member) => !member.is_on_leave);
    const ranked = active
      .slice()
      .sort((a, b) => b.current_balloons - a.current_balloons)
      .map((member, index) => ({ ...member, rank: index + 1 }));
    const leaves = rows
      .filter((member) => member.is_on_leave)
      .slice()
      .sort((a, b) => a.nickname.localeCompare(b.nickname, "ko"))
      .map((member) => ({ ...member, rank: 0 }));

    return {
      ...(previous ?? { naksoo_gods: [], crew_kings: [] }),
      rank: previous?.rank ?? 0,
      crew_name: displayNames.get(key) ?? previous?.crew_name ?? key,
      member_count: active.length,
      current_total_balloons: active.reduce(
        (sum, member) => sum + member.current_balloons,
        0,
      ),
      average_current_balloons: getTrimmedAverage(
        active.map((member) => member.current_balloons),
      ),
      members: [...ranked, ...leaves],
    } as T;
  }

  const faMembers = grouped.get("fa") ?? [];
  grouped.delete("fa");
  const nextFa = faMembers.length > 0 ? buildCrew("fa", faMembers) : null;
  const nextCrews = Array.from(grouped.entries())
    .map(([key, rows]) => buildCrew(key, rows))
    .sort((a, b) => b.average_current_balloons - a.average_current_balloons)
    .map((crew, index) => ({ ...crew, rank: index + 1 }));

  return { crews: nextCrews, fa_crew: nextFa };
}
