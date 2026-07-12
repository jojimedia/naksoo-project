import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

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
  return new SignJWT({
    loginId: session.loginId,
    crews: session.crews,
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

    return { loginId, crews };
  } catch {
    return null;
  }
}

export async function getSessionFromCookies(): Promise<AdminSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;

  if (!token) {
    return null;
  }

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
  if (!session.crews.includes(crewName)) {
    throw new Error("해당 크루에 대한 권한이 없습니다.");
  }
}
