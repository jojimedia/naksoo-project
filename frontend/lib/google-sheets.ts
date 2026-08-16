import { createHash } from "crypto";
import { google, sheets_v4 } from "googleapis";

import { FA_CREW_NAME, isFaCrew, withFaCrew } from "./crews";
import { applyGuestbookVote, type GuestbookVote } from "./guestbook-shared";

export type SheetMember = {
  rowIndex: number;
  crew_name: string;
  user_id: string;
  nickname: string;
  note: string;
  is_on_leave: boolean;
};

export type SheetAdmin = {
  login_id: string;
  password: string;
  crews: string[];
};

export type MemberRequestAction = "add" | "leave" | "restore" | "retire";
export type MemberRequestStatus = "pending" | "approved" | "rejected";

export type SheetMemberRequest = {
  rowIndex: number;
  action: MemberRequestAction;
  crew_name: string;
  user_id: string;
  nickname: string;
  status: MemberRequestStatus;
  requested_at: string;
  processed_by: string;
  processed_at: string;
};

export type NewMemberRequestInput = {
  action: MemberRequestAction;
  crew_name: string;
  user_id: string;
  nickname: string;
};

export class CrewVersionConflictError extends Error {
  constructor() {
    super("다른 기기에서 목록이 변경되었습니다. 새로고침 후 다시 시도해주세요.");
    this.name = "CrewVersionConflictError";
  }
}

const ADMINS_SHEET = "admins";
const DEFAULT_SHEET_ID = "1w-hCArIqriowgLawxlAwZ1xOmGvGw32ics0ZGRHmwQs";
const MEMBERS_CACHE_TTL_MS = 45_000;
const META_CACHE_TTL_MS = 5 * 60_000;
const GUESTBOOK_CACHE_TTL_MS = 0;
const GUESTBOOK_SHEET = "guestbook";
const GUESTBOOK_HEADERS = [
  "id",
  "streamer_id",
  "parent_id",
  "author",
  "body",
  "created_at",
  "password",
  "likes",
  "dislikes",
  "like_voters",
  "dislike_voters",
] as const;

type SheetTable = {
  sheetName: string;
  headers: string[];
  rows: string[][];
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const sheetCache = {
  titles: null as CacheEntry<string[]> | null,
  tables: new Map<string, CacheEntry<SheetTable>>(),
  members: null as CacheEntry<SheetMember[]> | null,
};

function readCache<T>(entry: CacheEntry<T> | null | undefined): T | null {
  if (!entry || entry.expiresAt <= Date.now()) {
    return null;
  }

  return entry.value;
}

function writeCache<T>(value: T, ttlMs: number): CacheEntry<T> {
  return {
    value,
    expiresAt: Date.now() + ttlMs,
  };
}

function invalidateSheetsCache() {
  sheetCache.titles = null;
  sheetCache.tables.clear();
  sheetCache.members = null;
}

function getSheetId() {
  return process.env.GOOGLE_SHEET_ID ?? DEFAULT_SHEET_ID;
}

function getPrivateKey() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

  if (!raw) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is not set");
  }

  return raw
    .trim()
    .replace(/^["']|["'],?$/g, "")
    .replace(/\\n/g, "\n");
}

function getSheetsClient(): sheets_v4.Sheets {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;

  if (!email) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL is not set");
  }

  const auth = new google.auth.JWT({
    email,
    key: getPrivateKey(),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

function normalizeHeader(value: string) {
  return value.trim().toLowerCase();
}

function getColumnIndex(headers: string[], name: string) {
  return headers.findIndex((header) => header === normalizeHeader(name));
}

function columnA1(index: number) {
  let n = index + 1;
  let label = "";

  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }

  return label;
}

function parseCount(value: string) {
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function getCell(row: string[], index: number) {
  if (index < 0) {
    return "";
  }

  return (row[index] ?? "").trim();
}

function parseMemberRow(
  headers: string[],
  row: string[],
  rowIndex: number,
): SheetMember | null {
  const crew_name = getCell(row, getColumnIndex(headers, "crew_name"));
  const user_id = getCell(row, getColumnIndex(headers, "user_id"));
  const nickname = getCell(row, getColumnIndex(headers, "nickname"));
  const note = getCell(row, getColumnIndex(headers, "note"));

  if (!crew_name || !user_id) {
    return null;
  }

  return {
    rowIndex,
    crew_name,
    user_id,
    nickname,
    note,
    is_on_leave: note.toLowerCase() === "휴직",
  };
}

function parseAdminRow(row: string[]): SheetAdmin | null {
  const login_id = (row[0] ?? "").trim();
  const password = (row[1] ?? "").trim();
  const crewsRaw = (row[2] ?? "").trim();

  if (!login_id || !password) {
    return null;
  }

  const crews = crewsRaw
    .split(",")
    .map((crew) => crew.trim())
    .filter(Boolean);

  return { login_id, password, crews };
}

async function listSheetTitles() {
  const cached = readCache(sheetCache.titles);

  if (cached) {
    return cached;
  }

  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.get({
    spreadsheetId: getSheetId(),
    fields: "sheets.properties.title",
  });

  const titles =
    response.data.sheets
      ?.map((entry) => entry.properties?.title)
      .filter((title): title is string => Boolean(title)) ?? [];

  sheetCache.titles = writeCache(titles, META_CACHE_TTL_MS);
  return titles;
}

async function resolveSheetName(
  configuredName: string | undefined,
  preferredNames: string[],
) {
  if (configuredName) {
    return configuredName;
  }

  const titles = await listSheetTitles();

  for (const preferredName of preferredNames) {
    if (titles.includes(preferredName)) {
      return preferredName;
    }
  }

  return titles[0] ?? preferredNames[0];
}

async function resolveMembersSheetName() {
  return resolveSheetName(process.env.GOOGLE_MEMBERS_SHEET_NAME, [
    "members",
    "시트1",
  ]);
}

async function resolveAdminsSheetName() {
  return resolveSheetName(process.env.GOOGLE_ADMINS_SHEET_NAME, ["admins"]);
}

async function resolveMemberAddSheetName() {
  return resolveSheetName(process.env.GOOGLE_MEMBER_ADD_SHEET_NAME, [
    "member_add",
  ]);
}

const MEMBER_REQUEST_ACTIONS = new Set<MemberRequestAction>([
  "add",
  "leave",
  "restore",
  "retire",
]);

const MEMBER_REQUEST_STATUSES = new Set<MemberRequestStatus>([
  "pending",
  "approved",
  "rejected",
]);

function parseMemberRequestAction(value: string): MemberRequestAction | null {
  const normalized = value.trim().toLowerCase() as MemberRequestAction;
  return MEMBER_REQUEST_ACTIONS.has(normalized) ? normalized : null;
}

function parseMemberRequestStatus(value: string): MemberRequestStatus {
  const normalized = value.trim().toLowerCase() as MemberRequestStatus;
  return MEMBER_REQUEST_STATUSES.has(normalized) ? normalized : "pending";
}

function parseMemberRequestRow(
  headers: string[],
  row: string[],
  rowIndex: number,
): SheetMemberRequest | null {
  const action = parseMemberRequestAction(
    getCell(row, getColumnIndex(headers, "action")),
  );
  const crew_name = getCell(row, getColumnIndex(headers, "crew_name"));
  const user_id = getCell(row, getColumnIndex(headers, "user_id"));
  const nickname = getCell(row, getColumnIndex(headers, "nickname"));
  const status = parseMemberRequestStatus(
    getCell(row, getColumnIndex(headers, "status")),
  );

  if (!action || !crew_name || !user_id) {
    return null;
  }

  return {
    rowIndex,
    action,
    crew_name,
    user_id,
    nickname,
    status,
    requested_at: getCell(row, getColumnIndex(headers, "requested_at")),
    processed_by: getCell(row, getColumnIndex(headers, "processed_by")),
    processed_at: getCell(row, getColumnIndex(headers, "processed_at")),
  };
}

const MEMBER_ADD_HEADERS = [
  "action",
  "crew_name",
  "user_id",
  "nickname",
  "status",
  "requested_at",
  "processed_by",
  "processed_at",
] as const;

async function ensureMemberAddHeaders(sheetName: string, headers: string[]) {
  if (headers.length > 0) {
    return;
  }

  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: getSheetId(),
    range: `${sheetName}!A1:H1`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [Array.from(MEMBER_ADD_HEADERS)],
    },
  });
  invalidateSheetsCache();
}

async function getSheetTable(
  sheetName: string,
  ttlMs = MEMBERS_CACHE_TTL_MS,
): Promise<SheetTable> {
  if (ttlMs > 0) {
    const cached = readCache(sheetCache.tables.get(sheetName));

    if (cached) {
      return cached;
    }
  }

  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSheetId(),
    range: `${sheetName}!A1:Z`,
  });

  const values = response.data.values ?? [];

  const table: SheetTable =
    values.length === 0
      ? { sheetName, headers: [], rows: [] }
      : {
          sheetName,
          headers: values[0].map((cell) =>
            normalizeHeader(String(cell ?? "")),
          ),
          rows: values
            .slice(1)
            .map((row) => row.map((cell) => String(cell ?? ""))),
        };

  if (ttlMs > 0) {
    sheetCache.tables.set(sheetName, writeCache(table, ttlMs));
  } else {
    sheetCache.tables.delete(sheetName);
  }

  return table;
}

async function getSheetIdByTitle(title: string): Promise<number> {
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.get({
    spreadsheetId: getSheetId(),
    fields: "sheets.properties",
  });

  const sheet = response.data.sheets?.find(
    (entry) => entry.properties?.title === title,
  );

  if (!sheet?.properties?.sheetId && sheet?.properties?.sheetId !== 0) {
    throw new Error(`Sheet not found: ${title}`);
  }

  return sheet.properties.sheetId;
}

function noteColumnLetter(headers: string[]) {
  const noteIndex = getColumnIndex(headers, "note");

  if (noteIndex < 0) {
    return "D";
  }

  return String.fromCharCode("A".charCodeAt(0) + noteIndex);
}

function columnLetter(headers: string[], name: string, fallback: string) {
  const index = getColumnIndex(headers, name);

  if (index < 0) {
    return fallback;
  }

  return String.fromCharCode("A".charCodeAt(0) + index);
}

async function updateMemberCrewName(rowIndex: number, crewName: string) {
  const sheetName = await resolveMembersSheetName();
  const table = await getSheetTable(sheetName);
  const crewColumn = columnLetter(table.headers, "crew_name", "A");
  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: getSheetId(),
    range: `${sheetName}!${crewColumn}${rowIndex}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[crewName]],
    },
  });

  invalidateSheetsCache();
}

export function computeCrewVersion(members: SheetMember[]) {
  const payload = members
    .map(
      (member) =>
        `${member.crew_name}\t${member.user_id.toLowerCase()}\t${member.nickname}\t${member.note}`,
    )
    .sort()
    .join("\n");

  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export async function getCrewMembersState(crewName: string) {
  const members = await listMembers(crewName);

  return {
    members,
    version: computeCrewVersion(members),
  };
}

export async function assertCrewVersion(
  crewName: string,
  expectedVersion?: string,
) {
  if (!expectedVersion) {
    return;
  }

  const { version } = await getCrewMembersState(crewName);

  if (version !== expectedVersion) {
    throw new CrewVersionConflictError();
  }
}

async function deleteMemberRow(rowIndex: number) {
  const sheetName = await resolveMembersSheetName();
  const sheets = getSheetsClient();
  const sheetId = await getSheetIdByTitle(sheetName);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getSheetId(),
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowIndex - 1,
              endIndex: rowIndex,
            },
          },
        },
      ],
    },
  });

  invalidateSheetsCache();
}

function pickPreferredMember(matches: SheetMember[]) {
  return [...matches].sort((left, right) => {
    if (left.is_on_leave !== right.is_on_leave) {
      return left.is_on_leave ? 1 : -1;
    }

    return left.rowIndex - right.rowIndex;
  })[0];
}

async function dedupeMemberRowsByUserId(userId: string) {
  const members = await listMembers();
  const normalizedUserId = userId.toLowerCase();
  const matches = members.filter(
    (member) => member.user_id.toLowerCase() === normalizedUserId,
  );

  if (matches.length <= 1) {
    return;
  }

  const keep = pickPreferredMember(matches);
  const duplicates = matches
    .filter((member) => member.rowIndex !== keep.rowIndex)
    .sort((left, right) => right.rowIndex - left.rowIndex);

  for (const member of duplicates) {
    await deleteMemberRow(member.rowIndex);
  }
}

export async function listAdmins(): Promise<SheetAdmin[]> {
  const sheetName = await resolveAdminsSheetName();
  const table = await getSheetTable(sheetName);

  return table.rows
    .map((row) => parseAdminRow(row))
    .filter((admin): admin is SheetAdmin => admin !== null);
}

async function findOptionalSheetName(
  configuredName: string | undefined,
  preferredNames: string[],
) {
  const titles = await listSheetTitles();

  if (configuredName && titles.includes(configuredName)) {
    return configuredName;
  }

  for (const preferredName of preferredNames) {
    if (titles.includes(preferredName)) {
      return preferredName;
    }
  }

  return null;
}

/**
 * 시트에 존재하는 관리 대상 크루 목록.
 * `crews` 탭이 있으면 그 목록을 쓰고, 없으면 members의 crew_name 고윳값(FA 제외)을 쓴다.
 */
export async function listRegisteredCrewNames(): Promise<string[]> {
  const crewsSheetName = await findOptionalSheetName(
    process.env.GOOGLE_CREWS_SHEET_NAME,
    ["crews"],
  );

  if (crewsSheetName) {
    const table = await getSheetTable(crewsSheetName);
    const crewColumn = getColumnIndex(table.headers, "crew_name");
    const names = new Set<string>();

    for (const row of table.rows) {
      const raw =
        crewColumn >= 0 ? getCell(row, crewColumn) : (row[0] ?? "").trim();
      const crewName = raw.trim();

      if (crewName && !isFaCrew(crewName)) {
        names.add(crewName);
      }
    }

    return Array.from(names);
  }

  const members = await listMembers();
  const names = new Set<string>();

  for (const member of members) {
    if (member.crew_name && !isFaCrew(member.crew_name)) {
      names.add(member.crew_name);
    }
  }

  return Array.from(names);
}

/**
 * admins 탭 crews 열에서, 시트에 존재하지 않는 크루명을 제거해 다시 쓴다.
 */
export async function syncAdminsCrewColumns(registeredCrews?: string[]) {
  const registered = new Set(
    (registeredCrews ?? (await listRegisteredCrewNames()))
      .map((crew) => crew.trim())
      .filter((crew) => crew && !isFaCrew(crew)),
  );
  const sheetName = await resolveAdminsSheetName();
  const table = await getSheetTable(sheetName);
  const sheets = getSheetsClient();
  const updates: { range: string; values: string[][] }[] = [];

  for (let index = 0; index < table.rows.length; index += 1) {
    const admin = parseAdminRow(table.rows[index]);

    if (!admin) {
      continue;
    }

    const cleaned = admin.crews
      .map((crew) => crew.trim())
      .filter((crew) => crew && !isFaCrew(crew) && registered.has(crew));
    const nextValue = cleaned.join(",");
    const previousValue = admin.crews
      .map((crew) => crew.trim())
      .filter((crew) => crew && !isFaCrew(crew))
      .join(",");

    if (nextValue === previousValue) {
      continue;
    }

    const rowNumber = index + 2;
    updates.push({
      range: `${sheetName}!C${rowNumber}`,
      values: [[nextValue]],
    });
  }

  if (updates.length === 0) {
    return { updated: 0 };
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: getSheetId(),
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: updates,
    },
  });

  invalidateSheetsCache();
  return { updated: updates.length };
}

export async function listMembers(crewName?: string): Promise<SheetMember[]> {
  const cached = readCache(sheetCache.members);
  let members = cached;

  if (!members) {
    const sheetName = await resolveMembersSheetName();
    const table = await getSheetTable(sheetName);
    members = table.rows
      .map((row, index) => parseMemberRow(table.headers, row, index + 2))
      .filter((member): member is SheetMember => member !== null);
    sheetCache.members = writeCache(members, MEMBERS_CACHE_TTL_MS);
  }

  if (!crewName) {
    return members;
  }

  return members.filter((member) => {
    if (isFaCrew(crewName)) {
      return isFaCrew(member.crew_name);
    }

    return member.crew_name === crewName;
  });
}

export async function findMember(
  crewName: string,
  userId: string,
): Promise<SheetMember | null> {
  const members = await listMembers(crewName);

  return (
    members.find(
      (member) =>
        (isFaCrew(crewName)
          ? isFaCrew(member.crew_name)
          : member.crew_name === crewName) &&
        member.user_id.toLowerCase() === userId.toLowerCase(),
    ) ?? null
  );
}

export async function findMemberByUserId(
  userId: string,
): Promise<SheetMember | null> {
  const members = await listMembers();
  const normalizedUserId = userId.toLowerCase();

  return (
    members.find(
      (member) => member.user_id.toLowerCase() === normalizedUserId,
    ) ?? null
  );
}

export async function findMembersByUserIds(
  userIds: string[],
): Promise<Map<string, SheetMember>> {
  const members = await listMembers();
  const wanted = new Set(userIds.map((userId) => userId.toLowerCase()));
  const result = new Map<string, SheetMember>();

  for (const member of members) {
    const key = member.user_id.toLowerCase();

    if (wanted.has(key) && !result.has(key)) {
      result.set(key, member);
    }
  }

  return result;
}

export async function addMember(
  crewName: string,
  userId: string,
  nickname: string,
  expectedVersion?: string,
) {
  await assertCrewVersion(crewName, expectedVersion);

  const existing = await findMemberByUserId(userId);

  if (existing) {
    if (
      isFaCrew(crewName)
        ? isFaCrew(existing.crew_name)
        : existing.crew_name === crewName
    ) {
      throw new Error(
        isFaCrew(crewName)
          ? "이미 무소속으로 등록된 스트리머입니다."
          : "이미 이 크루에 등록된 스트리머입니다.",
      );
    }

    if (isFaCrew(existing.crew_name) && !isFaCrew(crewName)) {
      const sheetName = await resolveMembersSheetName();
      const table = await getSheetTable(sheetName);
      const crewColumn = columnLetter(table.headers, "crew_name", "A");
      const nicknameColumn = columnLetter(table.headers, "nickname", "C");
      const sheets = getSheetsClient();

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: getSheetId(),
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: [
            {
              range: `${sheetName}!${crewColumn}${existing.rowIndex}`,
              values: [[crewName]],
            },
            {
              range: `${sheetName}!${nicknameColumn}${existing.rowIndex}`,
              values: [[nickname]],
            },
          ],
        },
      });

      invalidateSheetsCache();
      await dedupeMemberRowsByUserId(userId);
      return;
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

  const sheetName = await resolveMembersSheetName();
  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.append({
    spreadsheetId: getSheetId(),
    range: `${sheetName}!A:D`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[crewName, userId, nickname, ""]],
    },
  });

  invalidateSheetsCache();
}

export async function moveMemberToFa(
  crewName: string,
  userId: string,
  expectedVersion?: string,
) {
  await assertCrewVersion(crewName, expectedVersion);

  if (isFaCrew(crewName)) {
    throw new Error("이미 FA 소속입니다.");
  }

  const member = await findMember(crewName, userId);

  if (!member) {
    throw new Error("멤버를 찾을 수 없습니다.");
  }

  await updateMemberCrewName(member.rowIndex, FA_CREW_NAME);
  await dedupeMemberRowsByUserId(userId);
}

/** 무소속(FA) 멤버를 여러 크루로 한 번에 배정한다. */
export async function assignMembersFromFa(
  assignments: Array<{ userId: string; targetCrew: string }>,
  expectedVersion?: string,
) {
  if (assignments.length === 0) {
    return [];
  }

  await assertCrewVersion(FA_CREW_NAME, expectedVersion);

  const allMembers = await listMembers();
  const byUserId = new Map(
    allMembers.map((member) => [member.user_id.toLowerCase(), member]),
  );
  const sheetName = await resolveMembersSheetName();
  const table = await getSheetTable(sheetName);
  const crewColumn = columnLetter(table.headers, "crew_name", "A");
  const data: { range: string; values: string[][] }[] = [];
  const moved: SheetMember[] = [];

  for (const assignment of assignments) {
    const userId = assignment.userId.trim();
    const targetCrew = assignment.targetCrew.trim();

    if (!userId || !targetCrew || isFaCrew(targetCrew)) {
      throw new Error("유효하지 않은 크루 배정입니다.");
    }

    const member = byUserId.get(userId.toLowerCase());

    if (!member || !isFaCrew(member.crew_name)) {
      throw new Error(`${userId} 멤버를 무소속 목록에서 찾을 수 없습니다.`);
    }

    data.push({
      range: `${sheetName}!${crewColumn}${member.rowIndex}`,
      values: [[targetCrew]],
    });
    moved.push({
      ...member,
      crew_name: targetCrew,
    });
  }

  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: getSheetId(),
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data,
    },
  });

  // Sheets는 write 직후 read가 옛값을 줄 수 있어, 캐시를 삭제하지 않고 낙관적으로 갱신한다.
  const movedById = new Map(
    moved.map((member) => [member.user_id.toLowerCase(), member.crew_name]),
  );
  const nextMembers = allMembers.map((member) => {
    const nextCrew = movedById.get(member.user_id.toLowerCase());
    return nextCrew ? { ...member, crew_name: nextCrew } : member;
  });
  sheetCache.tables.clear();
  sheetCache.members = writeCache(nextMembers, MEMBERS_CACHE_TTL_MS);

  return moved;
}

/** 시트에서 멤버 행을 완전히 삭제한다. */
export async function removeMemberPermanently(
  crewName: string,
  userId: string,
  expectedVersion?: string,
) {
  await assertCrewVersion(crewName, expectedVersion);

  const member = await findMember(crewName, userId);

  if (!member) {
    throw new Error("멤버를 찾을 수 없습니다.");
  }

  await deleteMemberRow(member.rowIndex);
}

/** @deprecated 퇴사 처리는 moveMemberToFa를 사용합니다. */
export async function deleteMember(
  crewName: string,
  userId: string,
  expectedVersion?: string,
) {
  return moveMemberToFa(crewName, userId, expectedVersion);
}

export async function updateMemberNote(
  crewName: string,
  userId: string,
  note: string,
  expectedVersion?: string,
) {
  await assertCrewVersion(crewName, expectedVersion);

  const member = await findMember(crewName, userId);

  if (!member) {
    throw new Error("멤버를 찾을 수 없습니다.");
  }

  if (member.note === note) {
    return;
  }

  const sheetName = await resolveMembersSheetName();
  const table = await getSheetTable(sheetName);
  const noteColumn = noteColumnLetter(table.headers);
  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.update({
    spreadsheetId: getSheetId(),
    range: `${sheetName}!${noteColumn}${member.rowIndex}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[note]],
    },
  });

  invalidateSheetsCache();
}

/** FA + 등록 크루 목록 (공개 신청 UI용). */
export async function listPublicCrewNames(): Promise<string[]> {
  const registered = await listRegisteredCrewNames();
  return withFaCrew(registered);
}

export async function listMemberRequests(
  status?: MemberRequestStatus,
): Promise<SheetMemberRequest[]> {
  const sheetName = await resolveMemberAddSheetName();
  const table = await getSheetTable(sheetName);
  await ensureMemberAddHeaders(sheetName, table.headers);

  const fresh =
    table.headers.length === 0 ? await getSheetTable(sheetName) : table;

  const requests = fresh.rows
    .map((row, index) => parseMemberRequestRow(fresh.headers, row, index + 2))
    .filter((entry): entry is SheetMemberRequest => entry !== null);

  if (!status) {
    return requests;
  }

  return requests.filter((entry) => entry.status === status);
}

export async function listPendingMemberRequests(): Promise<SheetMemberRequest[]> {
  return listMemberRequests("pending");
}

export async function appendMemberRequests(
  requests: NewMemberRequestInput[],
): Promise<SheetMemberRequest[]> {
  if (requests.length === 0) {
    return [];
  }

  const sheetName = await resolveMemberAddSheetName();
  let table = await getSheetTable(sheetName);
  await ensureMemberAddHeaders(sheetName, table.headers);

  if (table.headers.length === 0) {
    table = await getSheetTable(sheetName);
  }

  const pending = await listPendingMemberRequests();
  const pendingKeys = new Set(
    pending.map(
      (entry) =>
        `${entry.action}:${entry.crew_name.toLowerCase()}:${entry.user_id.toLowerCase()}`,
    ),
  );

  const now = new Date().toISOString();
  const rowsToAppend: string[][] = [];
  const created: SheetMemberRequest[] = [];

  for (const request of requests) {
    const action = parseMemberRequestAction(request.action);
    const crewName = request.crew_name.trim();
    const userId = request.user_id.trim();
    const nickname = request.nickname.trim();

    if (!action || !crewName || !userId) {
      throw new Error("신청 항목이 올바르지 않습니다.");
    }

    const key = `${action}:${crewName.toLowerCase()}:${userId.toLowerCase()}`;

    if (pendingKeys.has(key)) {
      const label = nickname || userId;
      throw new Error(`${label}은 신청이 이미 대기중입니다`);
    }

    pendingKeys.add(key);
    rowsToAppend.push([
      action,
      isFaCrew(crewName) ? FA_CREW_NAME : crewName,
      userId,
      nickname,
      "pending",
      now,
      "",
      "",
    ]);
    created.push({
      rowIndex: -1,
      action,
      crew_name: isFaCrew(crewName) ? FA_CREW_NAME : crewName,
      user_id: userId,
      nickname,
      status: "pending",
      requested_at: now,
      processed_by: "",
      processed_at: "",
    });
  }

  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: getSheetId(),
    range: `${sheetName}!A:H`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: rowsToAppend,
    },
  });

  invalidateSheetsCache();
  return created;
}

export async function updateMemberRequestStatuses(
  rowIndexes: number[],
  status: Exclude<MemberRequestStatus, "pending">,
  processedBy: string,
) {
  if (rowIndexes.length === 0) {
    return;
  }

  const sheetName = await resolveMemberAddSheetName();
  const table = await getSheetTable(sheetName);
  const statusColumn = columnLetter(table.headers, "status", "E");
  const processedByColumn = columnLetter(table.headers, "processed_by", "G");
  const processedAtColumn = columnLetter(table.headers, "processed_at", "H");
  const now = new Date().toISOString();
  const uniqueRows = Array.from(new Set(rowIndexes));

  const data = uniqueRows.flatMap((rowIndex) => [
    {
      range: `${sheetName}!${statusColumn}${rowIndex}`,
      values: [[status]],
    },
    {
      range: `${sheetName}!${processedByColumn}${rowIndex}`,
      values: [[processedBy]],
    },
    {
      range: `${sheetName}!${processedAtColumn}${rowIndex}`,
      values: [[now]],
    },
  ]);

  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: getSheetId(),
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data,
    },
  });

  invalidateSheetsCache();
}

export async function getMemberRequestsByRowIndexes(
  rowIndexes: number[],
): Promise<SheetMemberRequest[]> {
  const wanted = new Set(rowIndexes);
  const all = await listMemberRequests();
  return all.filter((entry) => wanted.has(entry.rowIndex));
}

type SheetGuestbookRow = {
  rowIndex: number;
  id: string;
  streamer_id: string;
  parent_id: string;
  author: string;
  body: string;
  created_at: string;
  password: string;
  password_salt: string;
  likes: number;
  dislikes: number;
  like_voters: string;
  dislike_voters: string;
};

async function addSheetTab(title: string) {
  const sheets = getSheetsClient();

  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: getSheetId(),
      requestBody: {
        requests: [
          {
            addSheet: {
              properties: { title },
            },
          },
        ],
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    if (!message.toLowerCase().includes("already")) {
      throw error;
    }
  }

  invalidateSheetsCache();
}

async function resolveGuestbookSheetName() {
  return process.env.GOOGLE_GUESTBOOK_SHEET_NAME?.trim() || GUESTBOOK_SHEET;
}

async function ensureGuestbookSheet() {
  const sheetName = await resolveGuestbookSheetName();
  const titles = await listSheetTitles();

  if (!titles.includes(sheetName)) {
    await addSheetTab(sheetName);
  }

  const table = await getSheetTable(sheetName, GUESTBOOK_CACHE_TTL_MS);
  const sheets = getSheetsClient();

  if (table.headers.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: getSheetId(),
      range: `${sheetName}!A1:${columnA1(GUESTBOOK_HEADERS.length - 1)}1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [Array.from(GUESTBOOK_HEADERS)],
      },
    });
    invalidateSheetsCache();
    return sheetName;
  }

  const headers = [...table.headers];
  const hashIndex = getColumnIndex(headers, "password_hash");

  if (hashIndex >= 0 && getColumnIndex(headers, "password") < 0) {
    headers[hashIndex] = "password";
  }

  const missing = [
    "likes",
    "dislikes",
    "like_voters",
    "dislike_voters",
  ].filter((name) => getColumnIndex(headers, name) < 0);

  if (missing.length > 0) {
    headers.push(...missing);
  }

  if (headers.join("\n") !== table.headers.join("\n")) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: getSheetId(),
      range: `${sheetName}!A1:${columnA1(headers.length - 1)}1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [headers],
      },
    });
    invalidateSheetsCache();
  }

  return sheetName;
}

function parseGuestbookRow(
  headers: string[],
  row: string[],
  rowIndex: number,
): SheetGuestbookRow | null {
  const id = getCell(row, getColumnIndex(headers, "id"));
  const streamer_id = getCell(row, getColumnIndex(headers, "streamer_id"));
  const body = getCell(row, getColumnIndex(headers, "body"));

  if (!id || !streamer_id || !body) {
    return null;
  }

  return {
    rowIndex,
    id,
    streamer_id,
    parent_id: getCell(row, getColumnIndex(headers, "parent_id")),
    author: getCell(row, getColumnIndex(headers, "author")) || "0.0",
    body,
    created_at: getCell(row, getColumnIndex(headers, "created_at")),
    password:
      getCell(row, getColumnIndex(headers, "password")) ||
      getCell(row, getColumnIndex(headers, "password_hash")),
    password_salt: getCell(row, getColumnIndex(headers, "password_salt")),
    likes: parseCount(getCell(row, getColumnIndex(headers, "likes"))),
    dislikes: parseCount(getCell(row, getColumnIndex(headers, "dislikes"))),
    like_voters: getCell(row, getColumnIndex(headers, "like_voters")),
    dislike_voters: getCell(row, getColumnIndex(headers, "dislike_voters")),
  };
}

async function listGuestbookRows(): Promise<SheetGuestbookRow[]> {
  const sheetName = await ensureGuestbookSheet();
  const table = await getSheetTable(sheetName, GUESTBOOK_CACHE_TTL_MS);

  return table.rows
    .map((row, index) => parseGuestbookRow(table.headers, row, index + 2))
    .filter((entry): entry is SheetGuestbookRow => entry !== null);
}

export async function listGuestbookEntries(streamerId?: string) {
  const normalized = streamerId?.trim().toLowerCase() ?? "";
  const rows = await listGuestbookRows();

  if (!normalized) {
    return rows;
  }

  return rows.filter(
    (entry) => entry.streamer_id.toLowerCase() === normalized,
  );
}

export async function listGuestbookSummary() {
  const latest = new Map<string, { created_at: string; body: string }>();

  for (const entry of await listGuestbookRows()) {
    if (entry.parent_id) {
      continue;
    }

    const key = entry.streamer_id.toLowerCase();
    const current = latest.get(key);

    if (!current || entry.created_at > current.created_at) {
      latest.set(key, {
        created_at: entry.created_at,
        body: entry.body,
      });
    }
  }

  return Object.fromEntries(latest);
}

export async function findGuestbookEntry(id: string) {
  const wanted = id.trim();

  if (!wanted) {
    return null;
  }

  return (
    (await listGuestbookRows()).find((entry) => entry.id === wanted) ?? null
  );
}

export async function appendGuestbookEntry(input: {
  id: string;
  streamer_id: string;
  parent_id: string;
  author: string;
  body: string;
  created_at: string;
  password: string;
}) {
  const sheetName = await ensureGuestbookSheet();
  const table = await getSheetTable(sheetName, GUESTBOOK_CACHE_TTL_MS);
  const headers =
    table.headers.length > 0 ? table.headers : Array.from(GUESTBOOK_HEADERS);
  const sheets = getSheetsClient();
  const values = headers.map((header) => {
    if (header === "id") return input.id;
    if (header === "streamer_id") return input.streamer_id;
    if (header === "parent_id") return input.parent_id;
    if (header === "author") return input.author;
    if (header === "body") return input.body;
    if (header === "created_at") return input.created_at;
    if (header === "password" || header === "password_hash") return input.password;
    if (header === "likes" || header === "dislikes") return "0";
    return "";
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: getSheetId(),
    range: `${sheetName}!A:L`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [values],
    },
  });

  invalidateSheetsCache();
}

export async function updateGuestbookVote(
  id: string,
  voterKey: string,
  vote: GuestbookVote,
) {
  const sheetName = await ensureGuestbookSheet();
  const table = await getSheetTable(sheetName, GUESTBOOK_CACHE_TTL_MS);
  const rows = await listGuestbookRows();
  const target = rows.find((entry) => entry.id === id);

  if (!target) {
    throw new Error("글을 찾을 수 없습니다.");
  }

  const next = applyGuestbookVote(target, voterKey, vote);
  const sheets = getSheetsClient();
  const data = [
    ["likes", String(next.likes)],
    ["dislikes", String(next.dislikes)],
    ["like_voters", next.like_voters],
    ["dislike_voters", next.dislike_voters],
  ]
    .map(([header, value]) => {
      const column = getColumnIndex(table.headers, header);

      if (column < 0) {
        return null;
      }

      return {
        range: `${sheetName}!${columnA1(column)}${target.rowIndex}`,
        values: [[value]],
      };
    })
    .filter((item): item is { range: string; values: string[][] } => item !== null);

  if (data.length === 0) {
    throw new Error("좋아요 열을 찾을 수 없습니다.");
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: getSheetId(),
    requestBody: {
      valueInputOption: "RAW",
      data,
    },
  });

  invalidateSheetsCache();
  return {
    ...target,
    ...next,
  };
}

export async function deleteGuestbookEntries(id: string) {
  const rows = await listGuestbookRows();
  const target = rows.find((entry) => entry.id === id);

  if (!target) {
    throw new Error("글을 찾을 수 없습니다.");
  }

  const rowIndexes = rows
    .filter(
      (entry) =>
        entry.id === target.id ||
        (!target.parent_id && entry.parent_id === target.id),
    )
    .map((entry) => entry.rowIndex)
    .sort((left, right) => right - left);

  const sheetName = await ensureGuestbookSheet();
  const sheets = getSheetsClient();
  const sheetId = await getSheetIdByTitle(sheetName);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getSheetId(),
    requestBody: {
      requests: rowIndexes.map((rowIndex) => ({
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: rowIndex - 1,
            endIndex: rowIndex,
          },
        },
      })),
    },
  });

  invalidateSheetsCache();
  return target;
}
