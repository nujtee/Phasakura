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

export async function listReleaseRuns(env: CenterEnv, fetchFn: FetchLike = fetch, limit = 10): Promise<GithubResult<ReleaseRun[]>> {
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

export async function startRelease(env: CenterEnv, sites: string, note: string, fetchFn: FetchLike = fetch): Promise<GithubResult<null>> {
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
