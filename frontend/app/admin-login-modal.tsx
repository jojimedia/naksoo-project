"use client";

import { FormEvent, useEffect, useState } from "react";

type AdminLoginModalProps = {
  onClose: () => void;
  onSuccess: (session: { login_id: string; crews: string[] }) => void;
};

const SAVED_LOGIN_KEY = "naksoo_admin_saved_login";

function loadSavedLogin() {
  try {
    const raw = localStorage.getItem(SAVED_LOGIN_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as {
      login_id?: string;
      password?: string;
    };

    if (!parsed.login_id || !parsed.password) {
      localStorage.removeItem(SAVED_LOGIN_KEY);
      return null;
    }

    return {
      login_id: parsed.login_id,
      password: parsed.password,
    };
  } catch {
    localStorage.removeItem(SAVED_LOGIN_KEY);
    return null;
  }
}

function saveLogin(loginId: string, password: string) {
  localStorage.setItem(
    SAVED_LOGIN_KEY,
    JSON.stringify({ login_id: loginId, password }),
  );
}

function clearSavedLogin() {
  localStorage.removeItem(SAVED_LOGIN_KEY);
}

export default function AdminLoginModal({
  onClose,
  onSuccess,
}: AdminLoginModalProps) {
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [rememberLogin, setRememberLogin] = useState(false);
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const saved = loadSavedLogin();

    if (!saved) {
      return;
    }

    setLoginId(saved.login_id);
    setPassword(saved.password);
    setRememberLogin(true);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/admin/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          login_id: loginId,
          password,
        }),
      });

      const data = (await response.json()) as {
        error?: string;
        login_id?: string;
        crews?: string[];
      };

      if (!response.ok) {
        throw new Error(data.error ?? "로그인에 실패했습니다.");
      }

      if (rememberLogin) {
        saveLogin(loginId, password);
      } else {
        clearSavedLogin();
      }

      onSuccess({
        login_id: data.login_id ?? loginId,
        crews: data.crews ?? [],
      });
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "로그인에 실패했습니다.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        className="w-full max-w-md rounded-xl border border-[#3a3548] bg-[#17151f] p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-login-title"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2
            id="admin-login-title"
            className="text-xl font-semibold text-[#e5e7eb]"
          >
            관리자 로그인
          </h2>
          <button
            type="button"
            className="rounded px-2 text-xl text-[#a8a2b8] hover:text-[#e5e7eb]"
            aria-label="닫기"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <form className="space-y-3" onSubmit={handleSubmit}>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[#a8a2b8]">
              아이디
            </span>
            <input
              type="text"
              value={loginId}
              onChange={(event) => setLoginId(event.target.value)}
              className="h-10 w-full rounded-lg border border-[#3a3548] bg-[#111018] px-3 text-[#e5e7eb] outline-none focus:border-[#a99cff] focus:ring-2 focus:ring-[#a99cff]/20"
              autoComplete="username"
              required
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[#a8a2b8]">
              비밀번호
            </span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-10 w-full rounded-lg border border-[#3a3548] bg-[#111018] px-3 text-[#e5e7eb] outline-none focus:border-[#a99cff] focus:ring-2 focus:ring-[#a99cff]/20"
              autoComplete="current-password"
              required
            />
          </label>

          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-[#3a3548] bg-[#111018] px-3 py-2.5 text-sm text-[#d8d4ff]">
            <input
              type="checkbox"
              checked={rememberLogin}
              onChange={(event) => setRememberLogin(event.target.checked)}
              className="h-4 w-4 shrink-0 cursor-pointer rounded border-2 border-[#8b83ff] bg-[#17151f] accent-[#5b4bdb]"
            />
            아이디·비밀번호 저장
          </label>

          {error ? (
            <p className="text-sm font-medium text-[#fca5a5]">{error}</p>
          ) : null}

          <button
            type="submit"
            disabled={isSubmitting}
            className="h-10 w-full rounded-lg bg-[#5b4bdb] text-sm font-semibold text-white transition hover:bg-[#6d5ef0] disabled:opacity-60"
          >
            {isSubmitting ? "로그인 중..." : "로그인"}
          </button>
        </form>
      </div>
    </div>
  );
}
