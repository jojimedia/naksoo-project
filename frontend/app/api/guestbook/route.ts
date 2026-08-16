import { NextRequest, NextResponse } from "next/server";

import { getSessionFromCookies } from "@/lib/admin-session";
import { jsonError, getRequestIp } from "@/lib/api-utils";
import { isFaCrew } from "@/lib/crews";
import {
  appendGuestbookEntry,
  deleteGuestbookEntries,
  findGuestbookEntry,
  findMemberByUserId,
  listGuestbookEntries,
} from "@/lib/google-sheets";
import {
  assertGuestbookBody,
  assertGuestbookCooldown,
  assertGuestbookPassword,
  createGuestbookCookieValue,
  createGuestbookId,
  createPasswordSalt,
  getGuestbookCookieOptions,
  guestbookPasswordsMatch,
  GUESTBOOK_COOKIE_NAME,
  hashGuestbookPassword,
  markGuestbookPosted,
  maskIp,
  sanitizeGuestbookBody,
  threadGuestbookEntries,
  toPublicGuestbookPost,
  validateGuestbookPassword,
} from "@/lib/guestbook";

export const dynamic = "force-dynamic";

async function assertFaStreamer(userId: string) {
  const member = await findMemberByUserId(userId);

  if (!member || !isFaCrew(member.crew_name)) {
    throw new Error("FA 스트리머만 방명록을 사용할 수 있습니다.");
  }

  return member;
}

export async function GET(request: Request) {
  try {
    const userId = new URL(request.url).searchParams.get("user_id")?.trim() ?? "";

    if (!userId) {
      return jsonError("user_id가 필요합니다.");
    }

    await assertFaStreamer(userId);
    const entries = await listGuestbookEntries(userId);

    return NextResponse.json({
      posts: threadGuestbookEntries(entries),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "방명록을 불러오지 못했습니다.";
    return jsonError(message, 400);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      user_id?: string;
      body?: string;
      password?: string;
      parent_id?: string;
    };
    const userId = body.user_id?.trim() ?? "";
    const text = sanitizeGuestbookBody(body.body);
    const password = validateGuestbookPassword(body.password);
    const parentId = body.parent_id?.trim() ?? "";
    const userAgent = request.headers.get("user-agent");
    const ip = getRequestIp(request);

    if (!userId) {
      return jsonError("user_id가 필요합니다.");
    }

    await assertFaStreamer(userId);
    assertGuestbookBody(text);
    assertGuestbookPassword(password);

    const { memoryKey } = assertGuestbookCooldown(
      request.cookies.get(GUESTBOOK_COOKIE_NAME)?.value,
      ip,
      userAgent,
    );

    if (parentId) {
      const parent = await findGuestbookEntry(parentId);

      if (
        !parent ||
        parent.streamer_id.toLowerCase() !== userId.toLowerCase() ||
        parent.parent_id
      ) {
        return jsonError("답글을 달 수 없는 글입니다.");
      }
    }

    const now = Date.now();
    const salt = createPasswordSalt();
    const entry = {
      id: createGuestbookId(),
      streamer_id: userId,
      parent_id: parentId,
      author: maskIp(ip),
      body: text,
      created_at: new Date(now).toISOString(),
      password_salt: salt,
      password_hash: hashGuestbookPassword(password, salt),
    };

    await appendGuestbookEntry(entry);
    markGuestbookPosted(memoryKey, now);

    const response = NextResponse.json({
      post: toPublicGuestbookPost(entry),
    });
    response.cookies.set({
      ...getGuestbookCookieOptions(),
      value: createGuestbookCookieValue(userAgent),
    });
    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "글 작성에 실패했습니다.";
    const status =
      error instanceof Error && error.name === "GuestbookCooldownError"
        ? 429
        : 400;
    return jsonError(message, status);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      id?: string;
      password?: string;
    };
    const id = body.id?.trim() ?? "";
    const password = validateGuestbookPassword(body.password);

    if (!id) {
      return jsonError("id가 필요합니다.");
    }

    const session = await getSessionFromCookies();
    const entry = await findGuestbookEntry(id);

    if (!entry) {
      return jsonError("글을 찾을 수 없습니다.", 404);
    }

    if (!session) {
      if (!password) {
        return jsonError("비밀번호를 입력해주세요.");
      }

      if (
        !guestbookPasswordsMatch(
          password,
          entry.password_salt,
          entry.password_hash,
        )
      ) {
        return jsonError("비밀번호가 일치하지 않습니다.", 403);
      }
    }

    await deleteGuestbookEntries(id);
    return NextResponse.json({ ok: true, streamer_id: entry.streamer_id });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "글 삭제에 실패했습니다.";
    return jsonError(message, 400);
  }
}
