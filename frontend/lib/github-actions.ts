const GITHUB_REPO = process.env.GITHUB_REPO ?? "jojimedia/naksoo-project";
const GITHUB_DATA_REF = process.env.GITHUB_DATA_REF ?? "main";
const WORKFLOW_FILE = "run.yml";

function getGithubRepoParts() {
  const [owner, repo] = GITHUB_REPO.split("/");

  if (!owner || !repo) {
    throw new Error("GITHUB_REPO 설정이 올바르지 않습니다.");
  }

  return { owner, repo };
}

function getGithubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

export async function triggerNaksooUpdate() {
  const token = process.env.GITHUB_ACTIONS_TOKEN?.trim();

  if (!token) {
    throw new Error(
      "GITHUB_ACTIONS_TOKEN이 설정되지 않았습니다. Vercel 환경변수를 확인해주세요.",
    );
  }

  const { owner, repo } = getGithubRepoParts();
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: getGithubHeaders(token),
      body: JSON.stringify({ ref: GITHUB_DATA_REF }),
      cache: "no-store",
    },
  );

  if (response.status === 204) {
    return { ok: true as const };
  }

  const data = (await response.json().catch(() => ({}))) as {
    message?: string;
  };

  throw new Error(
    data.message ?? `GitHub Actions 요청에 실패했습니다. (${response.status})`,
  );
}
