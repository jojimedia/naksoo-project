export const GUESTBOOK_COOKIE_NAME = "fa_guestbook";
export const GUESTBOOK_COOLDOWN_MS = 30_000;
export const GUESTBOOK_BODY_MAX = 80;
export const GUESTBOOK_PASSWORD_MIN = 4;
export const GUESTBOOK_PASSWORD_MAX = 20;
export const GUESTBOOK_TOP_LIMIT = 30;
export const GUESTBOOK_READ_STORAGE_KEY = "naksoo_fa_guestbook_read";

export type GuestbookPost = {
  id: string;
  streamer_id: string;
  parent_id: string;
  author: string;
  body: string;
  created_at: string;
  replies: GuestbookPost[];
};
