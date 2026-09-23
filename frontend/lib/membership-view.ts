type Member = {
  user_id: string;
  crew_name: string;
  nickname: string;
  note: string;
  is_on_leave: boolean;
};

/** Apply authoritative membership while reusing collected stats by SOOP ID. */
export function alignMembership<T extends { user_id?: string }>(
  items: T[],
  members: Member[],
) {
  const byId = new Map(
    items.map((item) => [String(item.user_id).toLowerCase(), item]),
  );

  return members.map((member) => ({
    ...byId.get(member.user_id.toLowerCase()),
    ...member,
    success: true,
  }));
}
