"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

import {
  GUESTBOOK_BODY_MAX,
  GUESTBOOK_PASSWORD_MAX,
  GUESTBOOK_PASSWORD_MIN,
  GUESTBOOK_PASSWORD_STORAGE_KEY,
  GUESTBOOK_READ_STORAGE_KEY,
  overlayGuestbookVotes,
  voteOnGuestbookPosts,
  type GuestbookPost,
  type GuestbookPreview,
  type GuestbookVote,
} from "@/lib/guestbook-shared";

const READ_STORAGE_KEY = GUESTBOOK_READ_STORAGE_KEY;
const PASSWORD_STORAGE_KEY = GUESTBOOK_PASSWORD_STORAGE_KEY;

export function loadGuestbookReads(): Record<string, string> {
  try {
    const raw = localStorage.getItem(READ_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveGuestbookRead(userId: string, readAt = new Date().toISOString()) {
  const next = {
    ...loadGuestbookReads(),
    [userId]: readAt,
  };
  localStorage.setItem(READ_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function loadGuestbookPassword() {
  try {
    return localStorage.getItem(PASSWORD_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function saveGuestbookPassword(password: string) {
  const value = password.trim();

  if (
    value.length < GUESTBOOK_PASSWORD_MIN ||
    value.length > GUESTBOOK_PASSWORD_MAX
  ) {
    return;
  }

  localStorage.setItem(PASSWORD_STORAGE_KEY, value);
}

export function getGuestbookPreview(
  userId: string,
  previewByUserId: Record<string, GuestbookPreview>,
) {
  return previewByUserId[userId] ?? previewByUserId[userId.toLowerCase()];
}

export function hasUnreadGuestbook(
  userId: string,
  previewByUserId: Record<string, GuestbookPreview>,
  readAtByUserId: Record<string, string>,
) {
  const latest = getGuestbookPreview(userId, previewByUserId)?.created_at;

  if (!latest) {
    return false;
  }

  const readAt =
    readAtByUserId[userId] ?? readAtByUserId[userId.toLowerCase()];
  return !readAt || latest > readAt;
}

function removeGuestbookPost(posts: GuestbookPost[], id: string) {
  return posts
    .filter((post) => post.id !== id)
    .map((post) => ({
      ...post,
      replies: post.replies.filter((reply) => reply.id !== id),
    }));
}

function replaceGuestbookPost(
  posts: GuestbookPost[],
  tempId: string,
  saved: GuestbookPost,
) {
  if (saved.parent_id) {
    return posts.map((post) =>
      post.id === saved.parent_id
        ? {
            ...post,
            replies: post.replies.map((reply) =>
              reply.id === tempId ? { ...saved, replies: [] } : reply,
            ),
          }
        : post,
    );
  }

  return posts.map((post) =>
    post.id === tempId ? { ...saved, replies: post.replies } : post,
  );
}

function VoteIcon({
  name,
  solid = false,
}: {
  name: "like" | "dislike";
  solid?: boolean;
}) {
  return (
    <span className="relative inline-block h-3.5 w-3.5 shrink-0">
      <span
        className={`absolute inset-0 flex items-center justify-center [&_box-icon]:block [&_box-icon]:leading-none ${
          solid ? "opacity-0" : ""
        }`}
        aria-hidden="true"
        dangerouslySetInnerHTML={{
          __html: `<box-icon name="${name}" color="currentColor" size="14px"></box-icon>`,
        }}
      />
      <span
        className={`absolute inset-0 flex items-center justify-center [&_box-icon]:block [&_box-icon]:leading-none ${
          solid ? "" : "opacity-0"
        }`}
        aria-hidden="true"
        dangerouslySetInnerHTML={{
          __html: `<box-icon name="${name}" type="solid" color="currentColor" size="14px"></box-icon>`,
        }}
      />
    </span>
  );
}

function formatRelativeTime(value: string) {
  const created = new Date(value).getTime();

  if (!Number.isFinite(created)) {
    return "";
  }

  const diff = Date.now() - created;
  const minutes = Math.floor(diff / 60_000);

  if (minutes < 1) {
    return "방금";
  }

  if (minutes < 60) {
    return `${minutes}분 전`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}시간 전`;
  }

  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}

function GuestbookComposer({
  submitting,
  error,
  onSubmit,
  placeholder,
}: {
  submitting: boolean;
  error: string;
  onSubmit: (body: string, password: string) => Promise<void>;
  placeholder: string;
}) {
  const [body, setBody] = useState("");
  const [password, setPassword] = useState(loadGuestbookPassword);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    try {
      await onSubmit(body, password);
      setBody("");
    } catch {
      // 에러는 부모 패널에서 표시한다.
    }
  }

  return (
    <form className="space-y-1.5" onSubmit={handleSubmit}>
      <textarea
        value={body}
        required
        maxLength={GUESTBOOK_BODY_MAX}
        placeholder={placeholder}
        className="h-16 w-full resize-none rounded border border-[#3a3548] bg-[#17151f] px-2 py-1.5 text-[13px] text-[#e5e7eb] outline-none placeholder:text-[#6f6a7c] focus:border-[#5eead4]"
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex items-center gap-1.5">
        <input
          type="password"
          value={password}
          required
          minLength={GUESTBOOK_PASSWORD_MIN}
          maxLength={GUESTBOOK_PASSWORD_MAX}
          placeholder="삭제용 비밀번호"
          autoComplete="new-password"
          className="min-w-0 flex-1 rounded border border-[#3a3548] bg-[#17151f] px-2 py-1 text-[12px] text-[#e5e7eb] outline-none placeholder:text-[#6f6a7c] focus:border-[#5eead4]"
          onChange={(event) => setPassword(event.target.value)}
        />
        <button
          type="submit"
          disabled={submitting}
          className="shrink-0 rounded bg-[#0F766E] px-2.5 py-1 text-[12px] font-bold text-white disabled:opacity-60"
        >
          {submitting ? "올리는 중" : "등록"}
        </button>
      </div>
      <p className="text-[10px] text-[#8d879c]">
        {body.length}/{GUESTBOOK_BODY_MAX} · 같은 비밀번호로 나중에 삭제할 수 있습니다.
      </p>
      {error ? <p className="text-[11px] font-semibold text-[#f87171]">{error}</p> : null}
    </form>
  );
}

function GuestbookItem({
  post,
  isAdmin,
  isReply = false,
  onReply,
  onDelete,
  onVote,
}: {
  post: GuestbookPost;
  isAdmin: boolean;
  isReply?: boolean;
  onReply?: (id: string) => void;
  onDelete: (id: string, password?: string) => void;
  onVote: (id: string, vote: GuestbookVote) => void;
}) {
  const [showDelete, setShowDelete] = useState(false);
  const [password, setPassword] = useState(loadGuestbookPassword);
  const [error, setError] = useState("");

  function handleDelete() {
    setError("");
    const secret = password.trim() || loadGuestbookPassword();

    if (!isAdmin && !secret) {
      setError("비밀번호를 입력해주세요.");
      return;
    }

    if (!isAdmin) {
      saveGuestbookPassword(secret);
    }

    onDelete(post.id, isAdmin ? undefined : secret);
    setShowDelete(false);
    setPassword("");
  }

  return (
    <div className={isReply ? "ml-4 border-l border-[#3a3548] pl-2" : ""}>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-all text-[12px] font-bold text-[#99f6e4]">
          {post.author}
          <span className="ml-1.5 font-semibold text-[#8d879c]">
            {formatRelativeTime(post.created_at)}
          </span>
        </p>
        <div className="flex shrink-0 gap-1">
          {!isReply && onReply ? (
            <button
              type="button"
              className="text-[11px] font-bold text-[#a8a2b8] hover:text-[#e5e7eb]"
              onClick={() => onReply(post.id)}
            >
              답글
            </button>
          ) : null}
          <button
            type="button"
            className="text-[11px] font-bold text-[#f87171] hover:text-[#fecaca]"
            onClick={() => {
              if (isAdmin) {
                if (window.confirm("이 글을 삭제할까요?")) {
                  handleDelete();
                }
                return;
              }

              setShowDelete((current) => !current);
            }}
          >
            삭제
          </button>
        </div>
      </div>
      <div className="mt-0.5 flex items-start gap-2">
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-snug text-[#e5e7eb]">
          {post.body}
        </p>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            disabled={post.id.startsWith("temp-")}
            className={`inline-flex items-center gap-0.5 rounded px-0.5 py-0.5 text-[11px] font-bold disabled:opacity-80 ${
              post.my_vote === "like"
                ? "text-[#5eead4]"
                : "text-[#8d879c] hover:text-[#c4bfce]"
            }`}
            aria-label="좋아요"
            aria-pressed={post.my_vote === "like"}
            onClick={() => onVote(post.id, "like")}
          >
            <VoteIcon name="like" solid={post.my_vote === "like"} />
            {post.likes}
          </button>
          <button
            type="button"
            disabled={post.id.startsWith("temp-")}
            className={`inline-flex items-center gap-0.5 rounded px-0.5 py-0.5 text-[11px] font-bold disabled:opacity-80 ${
              post.my_vote === "dislike"
                ? "text-[#f87171]"
                : "text-[#8d879c] hover:text-[#c4bfce]"
            }`}
            aria-label="싫어요"
            aria-pressed={post.my_vote === "dislike"}
            onClick={() => onVote(post.id, "dislike")}
          >
            <VoteIcon name="dislike" solid={post.my_vote === "dislike"} />
            {post.dislikes}
          </button>
        </div>
      </div>
      {showDelete && !isAdmin ? (
        <div className="mt-1 flex items-center gap-1.5">
          <input
            type="password"
            value={password}
            placeholder="작성 시 비밀번호"
            className="min-w-0 flex-1 rounded border border-[#3a3548] bg-[#17151f] px-2 py-1 text-[12px] text-[#e5e7eb] outline-none"
            onChange={(event) => setPassword(event.target.value)}
          />
          <button
            type="button"
            className="rounded border border-[#f87171]/50 px-2 py-1 text-[11px] font-bold text-[#f87171]"
            onClick={handleDelete}
          >
            확인
          </button>
        </div>
      ) : null}
      {error ? <p className="mt-1 text-[11px] font-semibold text-[#f87171]">{error}</p> : null}
    </div>
  );
}

export default function FaGuestbookPanel({
  userId,
  nickname,
  isAdmin,
  cachedPosts,
  prefetching = false,
  onPosted,
  onPostsChange,
}: {
  userId: string;
  nickname: string;
  isAdmin: boolean;
  cachedPosts?: GuestbookPost[];
  prefetching?: boolean;
  onPosted?: (body: string) => void;
  onPostsChange?: (posts: GuestbookPost[]) => void;
}) {
  const hasCache = cachedPosts !== undefined;
  const [posts, setPosts] = useState<GuestbookPost[]>(cachedPosts ?? []);
  const postsRef = useRef(posts);
  const voteQueueRef = useRef(new Map<string, Promise<void>>());
  const [loading, setLoading] = useState(!hasCache && prefetching);
  const [error, setError] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);

  function commitPosts(next: GuestbookPost[], syncParent = true) {
    postsRef.current = next;
    setPosts(next);
    if (syncParent) {
      onPostsChange?.(next);
    }
  }

  async function loadPosts() {
    const response = await fetch(
      `/api/guestbook?user_id=${encodeURIComponent(userId)}`,
      { cache: "no-store" },
    );
    const data = (await response.json()) as {
      posts?: GuestbookPost[];
      error?: string;
    };

    if (!response.ok) {
      throw new Error(data.error ?? "방명록을 불러오지 못했습니다.");
    }

    commitPosts(data.posts ?? []);
  }

  useEffect(() => {
    if (cachedPosts !== undefined) {
      const merged = overlayGuestbookVotes(cachedPosts, postsRef.current);
      postsRef.current = merged;
      setPosts(merged);
      setLoading(false);
      return;
    }

    if (prefetching) {
      setLoading(true);
      return;
    }

    let cancelled = false;

    async function start() {
      setLoading(true);
      setError("");

      try {
        await loadPosts();
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught instanceof Error ? caught.message : "방명록을 불러오지 못했습니다.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void start();
    return () => {
      cancelled = true;
    };
  }, [userId, cachedPosts, prefetching]);

  async function submitPost(body: string, password: string, parentId?: string) {
    const text = body.replace(/\s+/g, " ").trim();
    const secret = password.trim();

    if (!text) {
      throw new Error("내용을 입력해주세요.");
    }

    if (
      secret.length < GUESTBOOK_PASSWORD_MIN ||
      secret.length > GUESTBOOK_PASSWORD_MAX
    ) {
      throw new Error(
        `비밀번호는 ${GUESTBOOK_PASSWORD_MIN}~${GUESTBOOK_PASSWORD_MAX}자로 입력해주세요.`,
      );
    }

    saveGuestbookPassword(secret);
    setError("");
    const tempId = `temp-${Date.now()}`;
    const optimistic: GuestbookPost = {
      id: tempId,
      streamer_id: userId,
      parent_id: parentId ?? "",
      author: "나",
      body: text,
      created_at: new Date().toISOString(),
      likes: 0,
      dislikes: 0,
      my_vote: "",
      replies: [],
    };
    const previous = postsRef.current;
    const next = parentId
      ? previous.map((post) =>
          post.id === parentId
            ? { ...post, replies: [...post.replies, optimistic] }
            : post,
        )
      : [optimistic, ...previous];

    commitPosts(next);
    setReplyTo(null);
    onPosted?.(text);

    void (async () => {
      try {
        const response = await fetch("/api/guestbook", {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_id: userId,
            body: text,
            password: secret,
            parent_id: parentId,
          }),
        });
        const data = (await response.json()) as {
          post?: GuestbookPost;
          error?: string;
        };

        if (!response.ok || !data.post) {
          throw new Error(data.error ?? "글 작성에 실패했습니다.");
        }

        commitPosts(replaceGuestbookPost(postsRef.current, tempId, data.post));
      } catch (caught) {
        commitPosts(removeGuestbookPost(postsRef.current, tempId));
        setError(
          caught instanceof Error ? caught.message : "글 작성에 실패했습니다.",
        );
      }
    })();
  }

  function deletePost(id: string, password?: string) {
    const previous = postsRef.current;
    commitPosts(removeGuestbookPost(previous, id));

    void (async () => {
      try {
        const response = await fetch("/api/guestbook", {
          method: "DELETE",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, password }),
        });
        const data = (await response.json()) as { error?: string };

        if (!response.ok) {
          throw new Error(data.error ?? "삭제에 실패했습니다.");
        }
      } catch (caught) {
        commitPosts(previous);
        setError(
          caught instanceof Error ? caught.message : "삭제에 실패했습니다.",
        );
      }
    })();
  }

  function votePost(id: string, vote: GuestbookVote) {
    if (id.startsWith("temp-")) {
      return;
    }

    commitPosts(voteOnGuestbookPosts(postsRef.current, id, vote), false);

    const previous = voteQueueRef.current.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const response = await fetch("/api/guestbook", {
          method: "PATCH",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, vote }),
        });
        const data = (await response.json()) as { error?: string };

        if (!response.ok) {
          throw new Error(data.error ?? "투표에 실패했습니다.");
        }

        onPostsChange?.(postsRef.current);
      })
      .catch((caught: unknown) => {
        commitPosts(voteOnGuestbookPosts(postsRef.current, id, vote), false);
        setError(
          caught instanceof Error ? caught.message : "투표에 실패했습니다.",
        );
      });

    voteQueueRef.current.set(id, next);
  }

  return (
    <div className="mx-1 mb-3 rounded border border-[#3a3548] bg-[#211e2b] px-2 py-2">
      <div className="mb-2">
        <p className="text-sm font-extrabold text-[#e5e7eb]">크루 적합 의견</p>
        <p className="text-[11px] font-semibold text-[#a8a2b8]">
          {nickname}이(가) 어떤 크루에 어울리는지 짧게 남겨 주세요.
        </p>
      </div>

      {loading ? (
        <p className="rounded border border-[#3a3548] bg-[#17151f] px-3 py-3 text-center text-sm font-bold text-[#a8a2b8]">
          불러오는 중...
        </p>
      ) : (
        <>
          {posts.length > 0 ? (
            <div className="mb-2 space-y-2">
              {posts.map((post) => (
                <div key={post.id} className="rounded border border-[#3a3548]/80 bg-[#17151f] px-2 py-1.5">
                  <GuestbookItem
                    post={post}
                    isAdmin={isAdmin}
                    onReply={(id) => {
                      setReplyTo((current) => (current === id ? null : id));
                    }}
                    onDelete={deletePost}
                    onVote={votePost}
                  />
                  {post.replies.map((reply) => (
                    <div key={reply.id} className="mt-1.5">
                      <GuestbookItem
                        post={reply}
                        isAdmin={isAdmin}
                        isReply
                        onDelete={deletePost}
                        onVote={votePost}
                      />
                    </div>
                  ))}
                  {replyTo === post.id ? (
                    <div className="mt-2">
                      <GuestbookComposer
                        submitting={false}
                        error={error}
                        placeholder={`${post.author}에게 답글`}
                        onSubmit={async (body, password) => {
                          await submitPost(body, password, post.id);
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="mb-2 rounded border border-[#3a3548] bg-[#17151f] px-3 py-3 text-center text-sm font-bold text-[#a8a2b8]">
              아직 의견이 없습니다.
            </p>
          )}

          {replyTo ? null : (
            <GuestbookComposer
              submitting={false}
              error={error}
              placeholder="짧은 의견을 남겨 주세요"
              onSubmit={async (body, password) => {
                await submitPost(body, password);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
