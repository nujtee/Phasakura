import type { FetchLike } from "../worker/line/line-api.ts";
import type { CenterEnv, CenterSite } from "./env.ts";

/**
 * Release from Center (phase C8): Center asks GitHub to run Actions → Release (.github/workflows/release.yml) and
 * shows its latest runs. Releasing itself stays in GitHub Actions — preflight, Time Travel bookmark, migrations,
 * deploy, smoke test — Center only presses the button. Needs:
 *   CENTER_GITHUB_REPO   "owner/repo" (var, generated from sites/sites.json "center.githubRepo")
 *   CENTER_GITHUB_TOKEN  secret: a fine-grained GitHub token for that one repository, "Actions: Read and write" only
 */
export const RELEASE_WORKFLOW = "release.yml";
/** The runtime's fetch, always called unbound (Workers reject it called as a method). */
const globalFetch: FetchLike = (input, init) => fetch(input, init);

const API = "https://api.github.com";
const REPO = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;

export interface ReleaseRun {
  number: number;
  title: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  url: string;
  sha: string;
  actor: string | null;
}

export type GithubResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function config(env: CenterEnv): GithubResult<{ repo: string; token: string }> {
  const repo = env.CENTER_GITHUB_REPO?.trim() ?? "";
  const token = env.CENTER_GITHUB_TOKEN?.trim() ?? "";
  if (!REPO.test(repo)) return { ok: false, reason: "ยังไม่ได้ตั้ง CENTER_GITHUB_REPO" };
  if (!token) return { ok: false, reason: "ยังไม่ได้ตั้ง secret CENTER_GITHUB_TOKEN ใน Worker center" };
  return { ok: true, value: { repo, token } };
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "phasakura-center/1",
  };
}

function failure(status: number): string {
  if (status === 401) return "GitHub ไม่รับ token (หมดอายุหรือผิด) — สร้าง token ใหม่";
  if (status === 403 || status === 404) return "token ไม่มีสิทธิ์ Actions ของ repo นี้";
  if (status === 422) return "GitHub ไม่รับค่าที่ส่งไป (ชื่อเว็บหรือ branch)";
  return `GitHub ตอบ HTTP ${status}`;
}

export async function listReleaseRuns(env: CenterEnv, fetchFn: FetchLike = globalFetch, limit = 10): Promise<GithubResult<ReleaseRun[]>> {
  const c = config(env);
  if (!c.ok) return c;
  try {
    const res = await fetchFn(`${API}/repos/${c.value.repo}/actions/workflows/${RELEASE_WORKFLOW}/runs?per_page=${limit}`, { headers: headers(c.value.token) });
    if (!res.ok) return { ok: false, reason: failure(res.status) };
    const body = (await res.json()) as { workflow_runs?: Record<string, unknown>[] };
    return {
      ok: true,
      value: (body.workflow_runs ?? []).map((r) => ({
        number: Number(r.run_number), title: String(r.display_title ?? r.name ?? ""), status: String(r.status ?? ""),
        conclusion: r.conclusion == null ? null : String(r.conclusion), createdAt: String(r.created_at ?? ""),
        url: /^https:\/\/github\.com\//.test(String(r.html_url)) ? String(r.html_url) : "",
        sha: String(r.head_sha ?? "").slice(0, 7), actor: (r.triggering_actor as { login?: string } | undefined)?.login ?? null,
      })),
    };
  } catch (error) {
    return { ok: false, reason: `ติดต่อ GitHub ไม่ได้: ${String(error).slice(0, 120)}` };
  }
}

/** "all", or the chosen slugs ("center" = the Center console), validated against the registry. */
export function releaseSelection(chosen: string[], sites: CenterSite[]): string | null {
  const known = new Set([...sites.map((s) => s.slug), "center"]);
  if (chosen.includes("all")) return "all";
  const picked = [...new Set(chosen)].filter((s) => known.has(s));
  if (!picked.length || picked.length !== new Set(chosen).size) return null;
  return [...sites.map((s) => s.slug), "center"].filter((s) => picked.includes(s)).join(" ");
}

export async function startRelease(env: CenterEnv, sites: string, note: string, fetchFn: FetchLike = globalFetch): Promise<GithubResult<null>> {
  const c = config(env);
  if (!c.ok) return c;
  try {
    const res = await fetchFn(`${API}/repos/${c.value.repo}/actions/workflows/${RELEASE_WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { ...headers(c.value.token), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: { ref: "main", sites, note: note.slice(0, 120) } }),
    });
    return res.status === 204 || res.ok ? { ok: true, value: null } : { ok: false, reason: failure(res.status) };
  } catch (error) {
    return { ok: false, reason: `ติดต่อ GitHub ไม่ได้: ${String(error).slice(0, 120)}` };
  }
}

// ---------------------------------------------------------------- pull requests (merge from Center)
// Needs two more permissions on the same fine-grained token: "Pull requests: Read and write" and
// "Contents: Read and write" (GitHub requires both to merge).

export type CiState = "success" | "failure" | "pending" | "none";

export interface OpenPull {
  number: number;
  title: string;
  author: string | null;
  url: string;
  sha: string;
  draft: boolean;
  createdAt: string;
  ci: CiState;
  ciUrl: string | null;
}

/** CI of one commit from its GitHub Actions runs (only "Actions: Read" needed): every run must have succeeded. */
export function ciFromRuns(runs: { status?: string; conclusion?: string | null; html_url?: string }[]): { ci: CiState; url: string | null } {
  if (!runs.length) return { ci: "none", url: null };
  const bad = runs.find((r) => r.status === "completed" && !["success", "skipped", "neutral"].includes(String(r.conclusion)));
  if (bad) return { ci: "failure", url: safeGithubUrl(bad.html_url) };
  const open = runs.find((r) => r.status !== "completed");
  if (open) return { ci: "pending", url: safeGithubUrl(open.html_url) };
  return { ci: "success", url: safeGithubUrl(runs[0]!.html_url) };
}

function safeGithubUrl(u: unknown): string | null {
  return typeof u === "string" && /^https:\/\/github\.com\//.test(u) ? u : null;
}

export async function listOpenPulls(env: CenterEnv, fetchFn: FetchLike = globalFetch): Promise<GithubResult<OpenPull[]>> {
  const c = config(env);
  if (!c.ok) return c;
  try {
    const res = await fetchFn(`${API}/repos/${c.value.repo}/pulls?state=open&base=main&per_page=20`, { headers: headers(c.value.token) });
    if (!res.ok) return { ok: false, reason: res.status === 403 || res.status === 404 ? "token ยังไม่มีสิทธิ์ Pull requests ของ repo นี้" : failure(res.status) };
    const pulls = (await res.json()) as Record<string, unknown>[];
    const out = await Promise.all(pulls.map(async (p): Promise<OpenPull> => {
      const sha = String((p.head as { sha?: string } | undefined)?.sha ?? "");
      let ci: { ci: CiState; url: string | null } = { ci: "none", url: null };
      if (/^[0-9a-f]{40}$/.test(sha)) {
        const r = await fetchFn(`${API}/repos/${c.value.repo}/actions/runs?head_sha=${sha}&per_page=20`, { headers: headers(c.value.token) }).catch(() => null);
        if (r?.ok) ci = ciFromRuns(((await r.json()) as { workflow_runs?: { status?: string; conclusion?: string | null; html_url?: string }[] }).workflow_runs ?? []);
      }
      return {
        number: Number(p.number), title: String(p.title ?? ""), author: (p.user as { login?: string } | undefined)?.login ?? null,
        url: safeGithubUrl(p.html_url) ?? "", sha, draft: p.draft === true, createdAt: String(p.created_at ?? ""), ci: ci.ci, ciUrl: ci.url,
      };
    }));
    return { ok: true, value: out };
  } catch (error) {
    return { ok: false, reason: `ติดต่อ GitHub ไม่ได้: ${String(error).slice(0, 120)}` };
  }
}

/**
 * Merges exactly the commit that was on screen (`sha`): if the PR changed since, GitHub refuses (409) and nothing
 * is merged. A merge commit, like the "Merge pull request" button.
 */
export async function mergePull(env: CenterEnv, number: number, sha: string, message: string, fetchFn: FetchLike = globalFetch): Promise<GithubResult<{ sha: string }>> {
  const c = config(env);
  if (!c.ok) return c;
  if (!Number.isInteger(number) || number < 1 || !/^[0-9a-f]{40}$/.test(sha)) return { ok: false, reason: "PR ไม่ถูกต้อง" };
  try {
    const res = await fetchFn(`${API}/repos/${c.value.repo}/pulls/${number}/merge`, {
      method: "PUT",
      headers: { ...headers(c.value.token), "Content-Type": "application/json" },
      body: JSON.stringify({ merge_method: "merge", sha, commit_message: message.slice(0, 500) }),
    });
    const body = (await res.json().catch(() => ({}))) as { merged?: boolean; sha?: string; message?: string };
    if (res.ok && body.merged) return { ok: true, value: { sha: String(body.sha ?? "") } };
    if (res.status === 409) return { ok: false, reason: "PR มีการเปลี่ยนแปลงหลังจากที่เปิดหน้านี้ — รีเฟรชแล้วตรวจอีกครั้ง" };
    if (res.status === 405) return { ok: false, reason: `GitHub ยัง merge ไม่ได้: ${String(body.message ?? "มี conflict หรือติดกฎของ branch").slice(0, 150)}` };
    if (res.status === 403 || res.status === 404) return { ok: false, reason: "token ยังไม่มีสิทธิ์ Contents / Pull requests แบบ Read and write" };
    return { ok: false, reason: failure(res.status) };
  } catch (error) {
    return { ok: false, reason: `ติดต่อ GitHub ไม่ได้: ${String(error).slice(0, 120)}` };
  }
}

/** Actions → Create site for a new site (D1, R2, registry PR) — its pull request then shows on the Release page. */
export async function startCreateSite(env: CenterEnv, input: { slug: string; name: string; domain: string }, fetchFn: FetchLike = globalFetch): Promise<GithubResult<null>> {
  const c = config(env);
  if (!c.ok) return c;
  try {
    const res = await fetchFn(`${API}/repos/${c.value.repo}/actions/workflows/site-create.yml/dispatches`, {
      method: "POST",
      headers: { ...headers(c.value.token), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs: input }),
    });
    return res.status === 204 || res.ok ? { ok: true, value: null } : { ok: false, reason: failure(res.status) };
  } catch (error) {
    return { ok: false, reason: `ติดต่อ GitHub ไม่ได้: ${String(error).slice(0, 120)}` };
  }
}

/** Latest runs of Actions → Create site (status of the step after "สร้างเว็บ"). */
export async function listCreateSiteRuns(env: CenterEnv, fetchFn: FetchLike = globalFetch): Promise<GithubResult<ReleaseRun[]>> {
  const c = config(env);
  if (!c.ok) return c;
  try {
    const res = await fetchFn(`${API}/repos/${c.value.repo}/actions/workflows/site-create.yml/runs?per_page=5`, { headers: headers(c.value.token) });
    if (!res.ok) return { ok: false, reason: failure(res.status) };
    const body = (await res.json()) as { workflow_runs?: Record<string, unknown>[] };
    return {
      ok: true,
      value: (body.workflow_runs ?? []).map((r) => ({
        number: Number(r.run_number), title: String(r.display_title ?? r.name ?? ""), status: String(r.status ?? ""),
        conclusion: r.conclusion == null ? null : String(r.conclusion), createdAt: String(r.created_at ?? ""),
        url: /^https:\/\/github\.com\//.test(String(r.html_url)) ? String(r.html_url) : "",
        sha: String(r.head_sha ?? "").slice(0, 7), actor: (r.triggering_actor as { login?: string } | undefined)?.login ?? null,
      })),
    };
  } catch (error) {
    return { ok: false, reason: `ติดต่อ GitHub ไม่ได้: ${String(error).slice(0, 120)}` };
  }
}
