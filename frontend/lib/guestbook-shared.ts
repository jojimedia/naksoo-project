export const GUESTBOOK_COOKIE_NAME = "fa_guestbook";
export const GUESTBOOK_VOTE_COOKIE_NAME = "fa_guestbook_vote";
export const GUESTBOOK_COOLDOWN_MS = 30_000;
export const GUESTBOOK_BODY_MAX = 80;
export const GUESTBOOK_PASSWORD_MIN = 4;
export const GUESTBOOK_PASSWORD_MAX = 20;
export const GUESTBOOK_TOP_LIMIT = 30;
export const GUESTBOOK_READ_STORAGE_KEY = "naksoo_fa_guestbook_read";
export const GUESTBOOK_PASSWORD_STORAGE_KEY = "naksoo_fa_guestbook_password";

export type GuestbookPreview = {
  created_at: string;
  body: string;
};

export type GuestbookVote = "like" | "dislike";

export type GuestbookPost = {
  id: string;
  streamer_id: string;
  parent_id: string;
  author: string;
  body: string;
  created_at: string;
  likes: number;
  dislikes: number;
  my_vote: GuestbookVote | "";
  replies: GuestbookPost[];
};

export function getGuestbookPosts(
  userId: string,
  postsByUserId: Record<string, GuestbookPost[]>,
) {
  return postsByUserId[userId] ?? postsByUserId[userId.toLowerCase()];
}

export function getLatestPreview(
  posts: GuestbookPost[],
): GuestbookPreview | undefined {
  const latest = posts.reduce<GuestbookPost | undefined>((current, post) => {
    if (!current || post.created_at > current.created_at) {
      return post;
    }

    return current;
  }, undefined);

  return latest
    ? { created_at: latest.created_at, body: latest.body }
    : undefined;
}

export function previewsFromPosts(
  postsByUserId: Record<string, GuestbookPost[]>,
) {
  const latest: Record<string, GuestbookPreview> = {};

  for (const [userId, posts] of Object.entries(postsByUserId)) {
    const preview = getLatestPreview(posts);

    if (preview) {
      latest[userId] = preview;
    }
  }

  return latest;
}

export function parseVoterList(value?: string) {
  return new Set(
    (value ?? "")
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function serializeVoterList(voters: Set<string>) {
  return [...voters].join(",");
}

export function applyGuestbookVote(
  entry: {
    like_voters?: string;
    dislike_voters?: string;
  },
  voterKey: string,
  vote: GuestbookVote,
) {
  const likeVoters = parseVoterList(entry.like_voters);
  const dislikeVoters = parseVoterList(entry.dislike_voters);

  if (vote === "like") {
    if (likeVoters.has(voterKey)) {
      likeVoters.delete(voterKey);
    } else {
      likeVoters.add(voterKey);
      dislikeVoters.delete(voterKey);
    }
  } else if (dislikeVoters.has(voterKey)) {
    dislikeVoters.delete(voterKey);
  } else {
    dislikeVoters.add(voterKey);
    likeVoters.delete(voterKey);
  }

  return {
    likes: likeVoters.size,
    dislikes: dislikeVoters.size,
    like_voters: serializeVoterList(likeVoters),
    dislike_voters: serializeVoterList(dislikeVoters),
    my_vote: (likeVoters.has(voterKey)
      ? "like"
      : dislikeVoters.has(voterKey)
        ? "dislike"
        : "") as GuestbookVote | "",
  };
}

export function voteOnGuestbookPost(
  post: GuestbookPost,
  vote: GuestbookVote,
): GuestbookPost {
  let likes = post.likes ?? 0;
  let dislikes = post.dislikes ?? 0;
  let myVote = post.my_vote ?? "";

  if (myVote === vote) {
    if (vote === "like") {
      likes = Math.max(0, likes - 1);
    } else {
      dislikes = Math.max(0, dislikes - 1);
    }

    myVote = "";
  } else {
    if (myVote === "like") {
      likes = Math.max(0, likes - 1);
    }

    if (myVote === "dislike") {
      dislikes = Math.max(0, dislikes - 1);
    }

    if (vote === "like") {
      likes += 1;
    } else {
      dislikes += 1;
    }

    myVote = vote;
  }

  return { ...post, likes, dislikes, my_vote: myVote };
}

export function voteOnGuestbookPosts(
  posts: GuestbookPost[],
  id: string,
  vote: GuestbookVote,
) {
  return posts.map((post) => {
    if (post.id === id) {
      return voteOnGuestbookPost(post, vote);
    }

    return {
      ...post,
      replies: post.replies.map((reply) =>
        reply.id === id ? voteOnGuestbookPost(reply, vote) : reply,
      ),
    };
  });
}

export function overlayGuestbookVotes(
  incoming: GuestbookPost[],
  local: GuestbookPost[],
) {
  if (local.length === 0) {
    return incoming;
  }

  const byId = new Map<string, GuestbookPost>();

  function collect(items: GuestbookPost[]) {
    for (const item of items) {
      byId.set(item.id, item);
      collect(item.replies);
    }
  }

  collect(local);

  function apply(item: GuestbookPost): GuestbookPost {
    const current = byId.get(item.id);

    return {
      ...(current
        ? {
            ...item,
            likes: current.likes,
            dislikes: current.dislikes,
            my_vote: current.my_vote,
          }
        : item),
      replies: item.replies.map(apply),
    };
  }

  return incoming.map(apply);
}
