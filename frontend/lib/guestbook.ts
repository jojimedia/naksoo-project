import { createHash, randomBytes, timingSafeEqual } from "crypto";

import {
  GUESTBOOK_BODY_MAX,
  GUESTBOOK_COOKIE_NAME,
  GUESTBOOK_VOTE_COOKIE_NAME,
  GUESTBOOK_COOLDOWN_MS,
  GUESTBOOK_PASSWORD_MAX,
  GUESTBOOK_PASSWORD_MIN,
  GUESTBOOK_TOP_LIMIT,
  parseVoterList,
  type GuestbookPost,
} from "./guestbook-shared";

export {
  GUESTBOOK_BODY_MAX,
  GUESTBOOK_COOKIE_NAME,
  GUESTBOOK_VOTE_COOKIE_NAME,
  GUESTBOOK_COOLDOWN_MS,
  GUESTBOOK_PASSWORD_MAX,
  GUESTBOOK_PASSWORD_MIN,
  GUESTBOOK_TOP_LIMIT,
  type GuestbookPost,
} from "./guestbook-shared";

const postCooldowns = new Map<string, number>();

function getGuestbookSecret() {
  return process.env.ADMIN_SESSION_SECRET ?? "naksoo-guestbook-dev";
}

export function hashUserAgent(userAgent: string | null) {
  return createHash("sha256")
    .update(userAgent?.trim() || "unknown")
    .digest("hex")
    .slice(0, 16);
}

export function maskIp(ip: string | null) {
  const raw = normalizeClientIp(ip);

  if (!raw || raw === "::1" || raw === "::") {
    return "0.0";
  }

  const v4Mapped = raw.match(/(?:^|:)(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/i);

  if (v4Mapped) {
    return maskIpv4(v4Mapped[1]);
  }

  if (raw.includes(":")) {
    return maskIpv6(raw);
  }

  return maskIpv4(raw);
}

function normalizeClientIp(ip: string | null) {
  let raw = (ip ?? "").trim();

  if (!raw) {
    return "";
  }

  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    raw = end >= 0 ? raw.slice(1, end) : raw.replace(/^\[|\]$/g, "");
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(raw)) {
    raw = raw.slice(0, raw.lastIndexOf(":"));
  }

  return raw.split("%")[0]?.trim() ?? "";
}

function maskIpv4(ip: string) {
  const parts = ip.split(".");
  return `${parts[0] || "0"}.${parts[1] || "0"}`;
}

function maskIpv6(ip: string) {
  const [head, tail] = ip.split("::");
  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail ? tail.split(":").filter(Boolean) : [];
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  const parts = [
    ...headParts,
    ...Array.from({ length: missing }, () => "0"),
    ...tailParts,
  ];

  return `${parts[0] || "0"}:${parts[1] || "0"}`;
}

function formatGuestbookAuthor(author: string) {
  const value = author.trim();

  if (!value) {
    return "0.0";
  }

  return value.replace(/\.\*\.\*$/, "").replace(/:\*:\*$/, "") || "0.0";
}

export function createGuestbookId() {
  return randomBytes(6).toString("hex");
}

export function guestbookPasswordsMatch(
  password: string,
  stored: string,
  salt = "",
) {
  if (!stored) {
    return false;
  }

  if (salt) {
    const hashed = createHash("sha256")
      .update(`${salt}:${password}`)
      .digest("hex");
    const left = Buffer.from(hashed);
    const right = Buffer.from(stored);

    if (left.length === right.length && timingSafeEqual(left, right)) {
      return true;
    }
  }

  const left = Buffer.from(password);
  const right = Buffer.from(stored);

  if (left.length !== right.length) {
    return false;
  }

  return timingSafeEqual(left, right);
}

export function sanitizeGuestbookBody(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, GUESTBOOK_BODY_MAX);
}

export function validateGuestbookPassword(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

export function assertGuestbookPassword(password: string) {
  if (
    password.length < GUESTBOOK_PASSWORD_MIN ||
    password.length > GUESTBOOK_PASSWORD_MAX
  ) {
    throw new Error(
      `비밀번호는 ${GUESTBOOK_PASSWORD_MIN}~${GUESTBOOK_PASSWORD_MAX}자로 입력해주세요.`,
    );
  }
}

export function assertGuestbookBody(body: string) {
  if (!body) {
    throw new Error("내용을 입력해주세요.");
  }
}

export function toPublicGuestbookPost(
  entry: {
    id: string;
    streamer_id: string;
    parent_id: string;
    author: string;
    body: string;
    created_at: string;
    likes?: number;
    dislikes?: number;
    like_voters?: string;
    dislike_voters?: string;
  },
  replies: GuestbookPost[] = [],
  voterKey = "",
): GuestbookPost {
  const likeVoters = parseVoterList(entry.like_voters);
  const dislikeVoters = parseVoterList(entry.dislike_voters);
  const likes = likeVoters.size || Math.max(0, entry.likes ?? 0);
  const dislikes = dislikeVoters.size || Math.max(0, entry.dislikes ?? 0);

  return {
    id: entry.id,
    streamer_id: entry.streamer_id,
    parent_id: entry.parent_id,
    author: formatGuestbookAuthor(entry.author),
    body: entry.body,
    created_at: entry.created_at,
    likes,
    dislikes,
    my_vote: likeVoters.has(voterKey)
      ? "like"
      : dislikeVoters.has(voterKey)
        ? "dislike"
        : "",
    replies,
  };
}

export function resolveGuestbookVoter(
  _cookieValue: string | undefined,
  userAgent: string | null,
) {
  const uaHash = hashUserAgent(userAgent);
  const voterKey = createHash("sha256")
    .update(`${getGuestbookSecret()}:vote-ua:${uaHash}`)
    .digest("hex")
    .slice(0, 16);
  const cookieValue = `${uaHash}.${voterKey}.${signVote(uaHash, voterKey)}`;

  return {
    voterKey,
    cookieValue,
    isNew: false,
  };
}

function signVote(uaHash: string, voterId: string) {
  return createHash("sha256")
    .update(`${getGuestbookSecret()}:vote:${uaHash}:${voterId}`)
    .digest("hex")
    .slice(0, 24);
}

export function getGuestbookVoteCookieOptions() {
  return {
    name: GUESTBOOK_VOTE_COOKIE_NAME,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  };
}

export function guestbookVoteCookie(cookieValue: string) {
  return {
    ...getGuestbookVoteCookieOptions(),
    value: cookieValue,
  };
}

function signCooldown(uaHash: string, postedAt: number) {
  return createHash("sha256")
    .update(`${getGuestbookSecret()}:${uaHash}:${postedAt}`)
    .digest("hex")
    .slice(0, 24);
}

export function parseGuestbookCookie(value: string | undefined) {
  if (!value) {
    return null;
  }

  const [uaHash, postedAtRaw, signature] = value.split(".");
  const postedAt = Number(postedAtRaw);

  if (!uaHash || !signature || !Number.isFinite(postedAt)) {
    return null;
  }

  const expected = signCooldown(uaHash, postedAt);

  if (
    expected.length !== signature.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return null;
  }

  return { uaHash, postedAt };
}

export function createGuestbookCookieValue(userAgent: string | null) {
  const uaHash = hashUserAgent(userAgent);
  const postedAt = Date.now();
  return `${uaHash}.${postedAt}.${signCooldown(uaHash, postedAt)}`;
}

export function remainingCooldownMs(postedAt: number) {
  return postedAt + GUESTBOOK_COOLDOWN_MS - Date.now();
}

export function getGuestbookCookieOptions() {
  return {
    name: GUESTBOOK_COOKIE_NAME,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  };
}

export function assertGuestbookCooldown(
  cookieValue: string | undefined,
  ip: string | null,
  userAgent: string | null,
) {
  const uaHash = hashUserAgent(userAgent);
  const parsed = parseGuestbookCookie(cookieValue);
  const memoryKey = `${ip ?? "unknown"}:${uaHash}`;
  const now = Date.now();
  const memoryPostedAt = postCooldowns.get(memoryKey) ?? 0;

  if (parsed && parsed.uaHash === uaHash) {
    const remaining = remainingCooldownMs(parsed.postedAt);

    if (remaining > 0) {
      throw cooldownError(remaining);
    }
  }

  if (memoryPostedAt) {
    const remaining = remainingCooldownMs(memoryPostedAt);

    if (remaining > 0) {
      throw cooldownError(remaining);
    }
  }

  return { memoryKey, now };
}

export function markGuestbookPosted(memoryKey: string, postedAt: number) {
  postCooldowns.set(memoryKey, postedAt);

  for (const [key, value] of postCooldowns) {
    if (value + GUESTBOOK_COOLDOWN_MS <= postedAt) {
      postCooldowns.delete(key);
    }
  }
}

function cooldownError(remainingMs: number) {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const error = new Error(`${seconds}초 후에 다시 작성할 수 있습니다.`);
  error.name = "GuestbookCooldownError";
  return error;
}

export function threadGuestbookEntries(
  entries: Array<{
    id: string;
    streamer_id: string;
    parent_id: string;
    author: string;
    body: string;
    created_at: string;
    likes?: number;
    dislikes?: number;
    like_voters?: string;
    dislike_voters?: string;
  }>,
  voterKey = "",
) {
  const topLevel = entries
    .filter((entry) => !entry.parent_id)
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .slice(0, GUESTBOOK_TOP_LIMIT);
  const visibleIds = new Set(topLevel.map((entry) => entry.id));
  const repliesByParent = new Map<string, GuestbookPost[]>();

  for (const entry of entries) {
    if (!entry.parent_id || !visibleIds.has(entry.parent_id)) {
      continue;
    }

    const replies = repliesByParent.get(entry.parent_id) ?? [];
    replies.push(toPublicGuestbookPost(entry, [], voterKey));
    repliesByParent.set(entry.parent_id, replies);
  }

  for (const replies of repliesByParent.values()) {
    replies.sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  return topLevel.map((entry) =>
    toPublicGuestbookPost(
      entry,
      repliesByParent.get(entry.id) ?? [],
      voterKey,
    ),
  );
}

export function bundleGuestbookByStreamer(
  entries: Array<{
    id: string;
    streamer_id: string;
    parent_id: string;
    author: string;
    body: string;
    created_at: string;
    likes?: number;
    dislikes?: number;
    like_voters?: string;
    dislike_voters?: string;
  }>,
  voterKey = "",
) {
  const grouped = new Map<string, typeof entries>();

  for (const entry of entries) {
    const key = entry.streamer_id.toLowerCase();
    const list = grouped.get(key) ?? [];
    list.push(entry);
    grouped.set(key, list);
  }

  const posts: Record<string, GuestbookPost[]> = {};

  for (const [key, group] of grouped) {
    posts[key] = threadGuestbookEntries(group, voterKey);
  }

  return posts;
}
