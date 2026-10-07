import { useEffect, useState } from "react";
import { format } from "../../../shared/i18n/admin-messages.ts";
import { LOCALES } from "../../../shared/i18n/locales.ts";
import type { SearchAnalyticsDto } from "../../../shared/search-types.ts";
import type { TranslationCoverageDto } from "../../../shared/seo-types.ts";
import { apiGet, apiRequest } from "../../api/client.ts";
import { useAdmin } from "../AdminContext.tsx";
import { Alert, Button, detailMessage, useDateFormatter } from "../ui.tsx";

/** Sitemap / robots.txt links and the live robots.txt, so admins can see what crawlers get. */
export function SearchEnginesCard() {
  const { c } = useAdmin();
  const [robots, setRobots] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/robots.txt", { signal: controller.signal, credentials: "omit" })
      .then((r) => (r.ok ? r.text() : null))
      .then((t) => setRobots(t))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const origin = window.location.origin;
  return (
    <div className="adm-card">
      <h2 className="adm-h2">{c.seo.engines}</h2>
      <p className="adm-field__hint">{c.seo.enginesNote}</p>
      <ul className="seo-links">
        <li><a href="/sitemap.xml" target="_blank" rel="noopener">{`${origin}/sitemap.xml`}</a></li>
        <li><a href="/robots.txt" target="_blank" rel="noopener">{`${origin}/robots.txt`}</a></li>
      </ul>
      <p>{c.seo.gscSteps}</p>
      {robots !== null && (
        <details className="seo-robots">
          <summary>{c.seo.robotsLive}</summary>
          <pre className="adm-mono">{robots}</pre>
        </details>
      )}
    </div>
  );
}

/** Visible content that has Thai text but no English / Chinese yet (visitors would see Thai). */
export function TranslationCoverageCard() {
  const { t, c } = useAdmin();
  const [data, setData] = useState<TranslationCoverageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    apiGet<TranslationCoverageDto>("/api/admin/i18n/coverage", controller.signal)
      .then(setData)
      .catch((err: unknown) => { if (!controller.signal.aborted) setError(detailMessage(t, err)); });
    return () => controller.abort();
  }, [t]);
  const kinds = data?.kinds.filter((k) => k.total > 0) ?? [];
  const gaps = kinds.filter((k) => k.missing.en || k.missing["zh-CN"]);
  return (
    <div className="adm-card">
      <h2 className="adm-h2">{c.seo.translations}</h2>
      <p className="adm-field__hint">{c.seo.translationsNote}</p>
      {error && <Alert kind="error">{error}</Alert>}
      {!data && !error && <p role="status">{t.common.loading}</p>}
      {data && gaps.length === 0 && <p className="i18n-ok">{c.seo.allTranslated}</p>}
      {data && kinds.length > 0 && (
        <div className="adm-tablewrap">
          <table className="adm-table i18n-table">
            <thead>
              <tr>
                <th scope="col">{c.seo.content}</th>
                <th scope="col" className="adm-num">{c.seo.total}</th>
                <th scope="col" className="adm-num">{c.seo.missingEn}</th>
                <th scope="col" className="adm-num">{c.seo.missingZh}</th>
              </tr>
            </thead>
            <tbody>
              {kinds.map((k) => (
                <tr key={k.kind}>
                  <th scope="row">
                    {c.seo.kinds[k.kind]}
                    {k.items.length > 0 && (
                      <details className="i18n-items">
                        <summary>{c.seo.showMissing}</summary>
                        <ul>
                          {k.items.map((i) => (
                            <li key={i.id}>{i.label} <span className="adm-muted adm-small">({i.missing.map((l) => (l === "en" ? "EN" : "中文")).join(", ")})</span></li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </th>
                  <td className="adm-num">{k.total}</td>
                  <td className={`adm-num${k.missing.en ? " i18n-gap" : ""}`}>{k.missing.en}</td>
                  <td className={`adm-num${k.missing["zh-CN"] ? " i18n-gap" : ""}`}>{k.missing["zh-CN"]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** What visitors search for (no personal data) and the search index status / rebuild. */
export function SiteSearchCard() {
  const { t, c, can } = useAdmin();
  const dateTime = useDateFormatter();
  const [data, setData] = useState<SearchAnalyticsDto | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    apiGet<SearchAnalyticsDto>("/api/admin/search/analytics?days=30", controller.signal)
      .then(setData)
      .catch((err: unknown) => { if (!controller.signal.aborted) setMessage({ kind: "error", text: detailMessage(t, err) }); });
    return () => controller.abort();
  }, [t, reload]);
  const rebuild = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await apiRequest<{ rows: number }>("POST", "/api/admin/search/reindex");
      setMessage({ kind: "success", text: format(c.seo.rebuilt, { n: r.rows }) });
      setReload((n) => n + 1);
    } catch (err) {
      setMessage({ kind: "error", text: detailMessage(t, err) });
    } finally {
      setBusy(false);
    }
  };
  const langLabel = (l: string) => LOCALES.find((x) => x.code === l)?.shortLabel ?? l;
  return (
    <div className="adm-card">
      <h2 className="adm-h2">{c.seo.search}</h2>
      <p className="adm-field__hint">{c.seo.searchNote}</p>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
      {data && (
        <>
          <div className="adm-row adm-row--wrap">
            <span>{data.index.rebuiltAt ? format(c.seo.indexInfo, { n: data.index.rows, time: dateTime(data.index.rebuiltAt) }) : c.seo.indexNever}</span>
            {can("seo.edit") && <Button variant="secondary" busy={busy} onClick={() => void rebuild()}>{c.seo.rebuild}</Button>}
          </div>
          <div className="search-stats">
            <section aria-labelledby="ss-top">
              <h3 id="ss-top" className="adm-h3">{c.seo.topSearches}</h3>
              {data.top.length === 0 ? <p className="adm-muted">{c.seo.noSearches}</p> : (
                <div className="adm-tablewrap">
                  <table className="adm-table">
                    <thead><tr><th scope="col">{c.seo.query}</th><th scope="col">{c.seo.language}</th><th scope="col" className="adm-num">{c.seo.searches}</th><th scope="col" className="adm-num">{c.seo.clicks}</th></tr></thead>
                    <tbody>
                      {data.top.map((r) => (
                        <tr key={`${r.query}|${r.language}`}><td>{r.query}</td><td>{langLabel(r.language)}</td><td className="adm-num">{r.searches}</td><td className="adm-num">{r.clicks}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section aria-labelledby="ss-zero">
              <h3 id="ss-zero" className="adm-h3">{c.seo.zeroSearches}</h3>
              {data.zeroResults.length === 0 ? <p className="adm-muted">{data.top.length ? c.seo.noZeroResults : c.seo.noSearches}</p> : (
                <ul className="search-zero">
                  {data.zeroResults.map((r) => <li key={`${r.query}|${r.language}`}><strong>{r.query}</strong> <span className="adm-muted adm-small">{langLabel(r.language)} · {r.searches}</span></li>)}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
