import { createHash } from "crypto";
import { google, sheets_v4 } from "googleapis";

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

export class CrewVersionConflictError extends Error {
  constructor() {
    super("다른 기기에서 목록이 변경되었습니다. 새로고침 후 다시 시도해주세요.");
    this.name = "CrewVersionConflictError";
  }
}

const ADMINS_SHEET = "admins";
const DEFAULT_SHEET_ID = "1w-hCArIqriowgLawxlAwZ1xOmGvGw32ics0ZGRHmwQs";

type SheetTable = {
  sheetName: string;
  headers: string[];
  rows: string[][];
};

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
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.get({
    spreadsheetId: getSheetId(),
    fields: "sheets.properties.title",
  });

  return (
    response.data.sheets
      ?.map((entry) => entry.properties?.title)
      .filter((title): title is string => Boolean(title)) ?? []
  );
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

async function getSheetTable(sheetName: string): Promise<SheetTable> {
  const sheets = getSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSheetId(),
    range: `${sheetName}!A1:Z`,
  });

  const values = response.data.values ?? [];

  if (values.length === 0) {
    return { sheetName, headers: [], rows: [] };
  }

  const headers = values[0].map((cell) => normalizeHeader(String(cell ?? "")));
  const rows = values
    .slice(1)
    .map((row) => row.map((cell) => String(cell ?? "")));

  return { sheetName, headers, rows };
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

export async function listMembers(crewName?: string): Promise<SheetMember[]> {
  const sheetName = await resolveMembersSheetName();
  const table = await getSheetTable(sheetName);

  return table.rows
    .map((row, index) => parseMemberRow(table.headers, row, index + 2))
    .filter((member): member is SheetMember => member !== null)
    .filter((member) => !crewName || member.crew_name === crewName);
}

export async function findMember(
  crewName: string,
  userId: string,
): Promise<SheetMember | null> {
  const members = await listMembers(crewName);

  return (
    members.find(
      (member) =>
        member.crew_name === crewName &&
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

export async function addMember(
  crewName: string,
  userId: string,
  nickname: string,
  expectedVersion?: string,
) {
  await assertCrewVersion(crewName, expectedVersion);

  const existing = await findMemberByUserId(userId);

  if (existing) {
    if (existing.crew_name === crewName) {
      throw new Error("이미 이 크루에 등록된 스트리머입니다.");
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

  await dedupeMemberRowsByUserId(userId);
}

export async function deleteMember(
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
}
