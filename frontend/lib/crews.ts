export const FA_CREW_NAME = "FA";

export function isFaCrew(crewName: string) {
  return crewName.trim().toUpperCase() === FA_CREW_NAME;
}

/** 관리 UI에서 FA를 FA(무소속)으로 표시한다. */
export function displayCrewName(crewName: string) {
  return isFaCrew(crewName) ? "FA(무소속)" : crewName.trim();
}

/** 모든 관리자 세션에 FA(무소속) 관리 권한을 붙인다. FA를 맨 앞에 둔다. */
export function withFaCrew(crews: string[]) {
  const normalized = crews.map((crew) => crew.trim()).filter(Boolean);
  const withoutFa = normalized.filter((crew) => !isFaCrew(crew));

  return [FA_CREW_NAME, ...withoutFa];
}

/**
 * admins.crews 권한을 시트에 현재 존재하는 크루만으로 좁힌 뒤 FA를 붙인다.
 * 삭제된 크루가 JWT·admins 행에 남아 있어도 관리 목록에 나오지 않게 한다.
 */
export function resolveManagedCrews(
  adminCrews: string[],
  registeredCrews: string[],
) {
  const registered = new Set(
    registeredCrews
      .map((crew) => crew.trim())
      .filter((crew) => crew && !isFaCrew(crew)),
  );
  const allowed = adminCrews
    .map((crew) => crew.trim())
    .filter((crew) => crew && !isFaCrew(crew) && registered.has(crew));

  return withFaCrew(allowed);
}
