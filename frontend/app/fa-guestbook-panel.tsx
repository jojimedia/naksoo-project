"use client";

import { FormEvent, useEffect, useState } from "react";

import {
  GUESTBOOK_BODY_MAX,
  GUESTBOOK_PASSWORD_MAX,
  GUESTBOOK_PASSWORD_MIN,
  GUESTBOOK_READ_STORAGE_KEY,
  type GuestbookPost,
} from "@/lib/guestbook-shared";

const READ_STORAGE_KEY = GUESTBOOK_READ_STORAGE_KEY;

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

export function hasUnreadGuestbook(
  userId: string,
  latestByUserId: Record<string, string>,
  readAtByUserId: Record<string, string>,
) {
  const latest =
    latestByUserId[userId] ?? latestByUserId[userId.toLowerCase()];

  if (!latest) {
    return false;
  }

  const readAt =
    readAtByUserId[userId] ?? readAtByUserId[userId.toLowerCase()];
  return !readAt || latest > readAt;
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
  const [password, setPassword] = useState("");

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
        maxLength={GUESTBOOK_BODY_MAX}
        placeholder={placeholder}
        className="h-16 w-full resize-none rounded border border-[#3a3548] bg-[#17151f] px-2 py-1.5 text-[13px] text-[#e5e7eb] outline-none placeholder:text-[#6f6a7c] focus:border-[#5eead4]"
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex items-center gap-1.5">
        <input
          type="password"
          value={password}
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
}: {
  post: GuestbookPost;
  isAdmin: boolean;
  isReply?: boolean;
  onReply?: (id: string) => void;
  onDelete: (id: string, password?: string) => Promise<void>;
}) {
  const [showDelete, setShowDelete] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setError("");
    setDeleting(true);

    try {
      await onDelete(post.id, isAdmin ? undefined : password);
      setShowDelete(false);
      setPassword("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "삭제에 실패했습니다.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className={isReply ? "ml-4 border-l border-[#3a3548] pl-2" : ""}>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-[12px] font-bold text-[#99f6e4]">
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
                  void handleDelete();
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
      <p className="mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-snug text-[#e5e7eb]">
        {post.body}
      </p>
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
            disabled={deleting}
            className="rounded border border-[#f87171]/50 px-2 py-1 text-[11px] font-bold text-[#f87171] disabled:opacity-60"
            onClick={() => void handleDelete()}
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
  onPosted,
}: {
  userId: string;
  nickname: string;
  isAdmin: boolean;
  onPosted?: () => void;
}) {
  const [posts, setPosts] = useState<GuestbookPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);

  async function loadPosts() {
    const response = await fetch(
      `/api/guestbook?user_id=${encodeURIComponent(userId)}`,
    );
    const data = (await response.json()) as {
      posts?: GuestbookPost[];
      error?: string;
    };

    if (!response.ok) {
      throw new Error(data.error ?? "방명록을 불러오지 못했습니다.");
    }

    setPosts(data.posts ?? []);
  }

  useEffect(() => {
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
  }, [userId]);

  async function submitPost(body: string, password: string, parentId?: string) {
    setError("");
    setSubmitting(true);

    try {
      const response = await fetch("/api/guestbook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          body,
          password,
          parent_id: parentId,
        }),
      });
      const data = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(data.error ?? "글 작성에 실패했습니다.");
      }

      setReplyTo(null);
      onPosted?.();
      await loadPosts();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "글 작성에 실패했습니다.");
      throw caught;
    } finally {
      setSubmitting(false);
    }
  }

  async function deletePost(id: string, password?: string) {
    const response = await fetch("/api/guestbook", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, password }),
    });
    const data = (await response.json()) as { error?: string };

    if (!response.ok) {
      throw new Error(data.error ?? "삭제에 실패했습니다.");
    }

    await loadPosts();
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
      ) : posts.length > 0 ? (
        <div className="mb-2 space-y-2">
          {posts.map((post) => (
            <div key={post.id} className="rounded border border-[#3a3548]/80 bg-[#17151f] px-2 py-1.5">
              <GuestbookItem
                post={post}
                isAdmin={isAdmin}
                onReply={setReplyTo}
                onDelete={deletePost}
              />
              {post.replies.map((reply) => (
                <div key={reply.id} className="mt-1.5">
                  <GuestbookItem
                    post={reply}
                    isAdmin={isAdmin}
                    isReply
                    onDelete={deletePost}
                  />
                </div>
              ))}
              {replyTo === post.id ? (
                <div className="mt-2">
                  <GuestbookComposer
                    submitting={submitting}
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
          submitting={submitting}
          error={error}
          placeholder="짧은 의견을 남겨 주세요"
          onSubmit={async (body, password) => {
            await submitPost(body, password);
          }}
        />
      )}
    </div>
  );
}
