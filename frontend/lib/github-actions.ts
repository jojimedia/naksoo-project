const GITHUB_REPO = process.env.GITHUB_REPO ?? "jojimedia/naksoo-project";
const GITHUB_DATA_REF = process.env.GITHUB_DATA_REF ?? "main";
const WORKFLOW_FILE = "run.yml";
const ACTIVE_RUN_STATUSES = new Set([
  "queued",
  "in_progress",
  "pending",
  "waiting",
  "requested",
]);

export class WorkflowAlreadyRunningError extends Error {
  runUrl?: string;

  constructor(runUrl?: string) {
    super("이미 데이터 갱신이 진행 중입니다. 완료 후 다시 시도해주세요.");
    this.name = "WorkflowAlreadyRunningError";
    this.runUrl = runUrl;
  }
}

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

function getGithubToken() {
  const token = process.env.GITHUB_ACTIONS_TOKEN?.trim();

  if (!token) {
    throw new Error(
      "GITHUB_ACTIONS_TOKEN이 설정되지 않았습니다. Vercel 환경변수를 확인해주세요.",
    );
  }

  return token;
}

type GithubWorkflowRun = {
  status?: string;
  html_url?: string;
  created_at?: string;
};

export async function getWorkflowUpdateStatus() {
  const token = getGithubToken();
  const { owner, repo } = getGithubRepoParts();
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=10`,
    {
      headers: getGithubHeaders(token),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      message?: string;
    };

    throw new Error(
      data.message ??
        `GitHub Actions 상태 조회에 실패했습니다. (${response.status})`,
    );
  }

  const data = (await response.json()) as {
    workflow_runs?: GithubWorkflowRun[];
  };
  const activeRun = (data.workflow_runs ?? []).find((run) =>
    ACTIVE_RUN_STATUSES.has(run.status ?? ""),
  );

  return {
    running: Boolean(activeRun),
    status: activeRun?.status ?? null,
    run_url: activeRun?.html_url ?? null,
    started_at: activeRun?.created_at ?? null,
  };
}

export async function triggerNaksooUpdate() {
  const status = await getWorkflowUpdateStatus();

  if (status.running) {
    throw new WorkflowAlreadyRunningError(status.run_url ?? undefined);
  }

  const token = getGithubToken();
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
