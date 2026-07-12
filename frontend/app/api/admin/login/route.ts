import { NextResponse } from "next/server";

import { authenticateAdmin, checkLoginRateLimit } from "@/lib/admin-auth";
import {
  createSessionToken,
  getSessionCookieOptions,
} from "@/lib/admin-session";
import { getRequestIp, jsonError } from "@/lib/api-utils";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    checkLoginRateLimit(getRequestIp(request));

    const body = (await request.json()) as {
      login_id?: string;
      password?: string;
    };

    const loginId = body.login_id?.trim() ?? "";
    const password = body.password ?? "";

    if (!loginId || !password) {
      return jsonError("아이디와 비밀번호를 입력해주세요.");
    }

    const session = await authenticateAdmin(loginId, password);

    if (!session) {
      return jsonError("아이디 또는 비밀번호가 올바르지 않습니다.", 401);
    }

    const token = await createSessionToken(session);
    const response = NextResponse.json({
      login_id: session.loginId,
      crews: session.crews,
    });

    response.cookies.set({
      ...getSessionCookieOptions(),
      value: token,
    });

    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "로그인에 실패했습니다.";
    return jsonError(message, message.includes("너무 많습니다") ? 429 : 500);
  }
}
