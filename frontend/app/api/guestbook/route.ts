import { headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

import { getSessionFromCookies } from "@/lib/admin-session";
import { jsonError, jsonNoStore, getRequestIp } from "@/lib/api-utils";
import { isFaCrew } from "@/lib/crews";
import {
  appendGuestbookEntry,
  deleteGuestbookEntries,
  findGuestbookEntry,
  findMemberByUserId,
  listGuestbookEntries,
  updateGuestbookVote,
} from "@/lib/google-sheets";
import {
  assertGuestbookBody,
  assertGuestbookCooldown,
  assertGuestbookPassword,
  createGuestbookCookieValue,
  createGuestbookId,
  getGuestbookCookieOptions,
  guestbookPasswordsMatch,
  guestbookVoteCookie,
  resolveGuestbookVoter,
  GUESTBOOK_COOKIE_NAME,
  GUESTBOOK_VOTE_COOKIE_NAME,
  markGuestbookPosted,
  maskIp,
  sanitizeGuestbookBody,
  threadGuestbookEntries,
  toPublicGuestbookPost,
  validateGuestbookPassword,
} from "@/lib/guestbook";

export const dynamic = "force-dynamic";
export const revalidate = 0;

async function assertFaStreamer(userId: string) {
  const member = await findMemberByUserId(userId);

  if (!member || !isFaCrew(member.crew_name)) {
    throw new Error("FA 스트리머만 방명록을 사용할 수 있습니다.");
  }

  return member;
}

export async function GET(request: NextRequest) {
  try {
    const userId = new URL(request.url).searchParams.get("user_id")?.trim() ?? "";

    if (!userId) {
      return jsonError("user_id가 필요합니다.");
    }

    await assertFaStreamer(userId);
    const voter = resolveGuestbookVoter(
      request.cookies.get(GUESTBOOK_VOTE_COOKIE_NAME)?.value,
      request.headers.get("user-agent"),
    );
    const entries = await listGuestbookEntries(userId);
    const response = jsonNoStore({
      posts: threadGuestbookEntries(entries, voter.voterKey),
    });
    response.cookies.set(guestbookVoteCookie(voter.cookieValue));
    return response;
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
    const ip = getRequestIp(request, await headers());

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
    const entry = {
      id: createGuestbookId(),
      streamer_id: userId,
      parent_id: parentId,
      author: maskIp(ip),
      body: text,
      created_at: new Date(now).toISOString(),
      password,
    };

    await appendGuestbookEntry(entry);
    markGuestbookPosted(memoryKey, now);

    const response = NextResponse.json({
      post: toPublicGuestbookPost(entry),
    });
    response.headers.set("Cache-Control", "no-store, max-age=0");
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
          entry.password,
          entry.password_salt,
        )
      ) {
        return jsonError("비밀번호가 일치하지 않습니다.", 403);
      }
    }

    await deleteGuestbookEntries(id);
    return jsonNoStore({ ok: true, streamer_id: entry.streamer_id });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "글 삭제에 실패했습니다.";
    return jsonError(message, 400);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      id?: string;
      vote?: string;
    };
    const id = body.id?.trim() ?? "";
    const vote = body.vote === "like" || body.vote === "dislike" ? body.vote : "";

    if (!id) {
      return jsonError("id가 필요합니다.");
    }

    if (!vote) {
      return jsonError("좋아요 또는 싫어요를 선택해주세요.");
    }

    const voter = resolveGuestbookVoter(
      request.cookies.get(GUESTBOOK_VOTE_COOKIE_NAME)?.value,
      request.headers.get("user-agent"),
    );
    const entry = await updateGuestbookVote(id, voter.voterKey, vote);
    const response = jsonNoStore({
      post: toPublicGuestbookPost(entry, [], voter.voterKey),
    });
    response.cookies.set(guestbookVoteCookie(voter.cookieValue));
    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "투표에 실패했습니다.";
    const status =
      error instanceof Error && error.name === "GuestbookAlreadyVotedError"
        ? 409
        : 400;
    return jsonError(message, status);
  }
}
