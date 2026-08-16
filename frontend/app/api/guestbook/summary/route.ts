import { NextRequest } from "next/server";

import { jsonError, jsonNoStore } from "@/lib/api-utils";
import { listGuestbookEntries } from "@/lib/google-sheets";
import {
  bundleGuestbookByStreamer,
  guestbookVoteCookie,
  resolveGuestbookVoter,
  GUESTBOOK_VOTE_COOKIE_NAME,
} from "@/lib/guestbook";
import { previewsFromPosts } from "@/lib/guestbook-shared";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  try {
    const voter = resolveGuestbookVoter(
      request.cookies.get(GUESTBOOK_VOTE_COOKIE_NAME)?.value,
      request.headers.get("user-agent"),
    );
    const posts = bundleGuestbookByStreamer(
      await listGuestbookEntries(),
      voter.voterKey,
    );
    const response = jsonNoStore({
      latest: previewsFromPosts(posts),
      posts,
    });
    response.cookies.set(guestbookVoteCookie(voter.cookieValue));
    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "방명록 요약을 불러오지 못했습니다.";
    return jsonError(message, 500);
  }
}
