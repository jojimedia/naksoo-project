import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

import { listAdmins, listRegisteredCrewNames } from "./google-sheets";
import { withFaCrew, isFaCrew, resolveManagedCrews } from "./crews";

export type AdminSession = {
  loginId: string;
  crews: string[];
};

const COOKIE_NAME = "naksoo_admin_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

function getSessionSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET;

  if (!secret) {
    throw new Error("ADMIN_SESSION_SECRET is not set");
  }

  return new TextEncoder().encode(secret);
}

export async function createSessionToken(session: AdminSession) {
  const crews = withFaCrew(session.crews);

  return new SignJWT({
    loginId: session.loginId,
    crews,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(getSessionSecret());
}

export async function verifySessionToken(
  token: string,
): Promise<AdminSession | null> {
  try {
    const { payload } = await jwtVerify(token, getSessionSecret());
    const loginId = String(payload.loginId ?? "");
    const crews = Array.isArray(payload.crews)
      ? payload.crews.map((crew) => String(crew))
      : [];

    if (!loginId || crews.length === 0) {
      return null;
    }

    return { loginId, crews: withFaCrew(crews) };
  } catch {
    return null;
  }
}

/** JWT의 관리자 ID를 기준으로 시트에 현재 있는 크루만 다시 계산한다. */
export async function refreshSessionCrews(
  session: AdminSession,
): Promise<AdminSession> {
  const [admins, registeredCrews] = await Promise.all([
    listAdmins(),
    listRegisteredCrewNames(),
  ]);
  const admin = admins.find((entry) => entry.login_id === session.loginId);
  const sourceCrews = admin?.crews ?? session.crews;

  return {
    loginId: session.loginId,
    crews: resolveManagedCrews(sourceCrews, registeredCrews),
  };
}

export async function getSessionFromCookies(): Promise<AdminSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;

  if (!token) {
    return null;
  }

  // JWT만 검증한다. 매 요청마다 시트를 다시 읽으면 Read quota를 금방 소진한다.
  return verifySessionToken(token);
}

export function getSessionCookieOptions() {
  return {
    name: COOKIE_NAME,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export function getClearSessionCookieOptions() {
  return {
    name: COOKIE_NAME,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  };
}

export function assertCrewAccess(session: AdminSession, crewName: string) {
  const allowed = session.crews;
  const hasAccess = isFaCrew(crewName)
    ? allowed.some((crew) => isFaCrew(crew))
    : allowed.includes(crewName);

  if (!hasAccess) {
    throw new Error("해당 크루에 대한 권한이 없습니다.");
  }
}
