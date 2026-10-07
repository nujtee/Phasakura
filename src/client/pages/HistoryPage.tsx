import type { PublicHistoryDto, PublicSectionDto, PublicTimelineItemDto } from "../../shared/content-types.ts";
import { IMAGE_SIZES } from "../../shared/media-types.ts";
import { pagePath } from "../../shared/routes.ts";
import { fill } from "../accommodation/UnitCard.tsx";
import { ResponsiveImage } from "../content/ResponsiveImage.tsx";
import { SmartLink } from "../content/SmartLink.tsx";
import { usePublicData } from "../content/usePublicData.ts";
import { useContentT } from "../content/useContentT.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";

/** Year label: Buddhist Era in Thai (2510), Common Era otherwise (1967). */
export function useYearLabel() {
  const { locale } = useI18n();
  const ct = useContentT();
  return (year: number) => fill(ct.history.era, { year: locale.code === "th" ? year + 543 : year });
}

export function Timeline({ items, headingId }: { items: PublicTimelineItemDto[]; headingId?: string }) {
  const year = useYearLabel();
  return (
    <ol className="timeline" aria-labelledby={headingId}>
      {items.map((it) => (
        <li key={it.id} className="timeline__item">
          <p className="timeline__year"><time dateTime={String(it.year)}>{year(it.year)}</time></p>
          <div className="timeline__body">
            <h3 className="timeline__title">{it.title}</h3>
            {it.description && <p className="timeline__text">{it.description}</p>}
            {it.image && <ResponsiveImage image={it.image} sizes={IMAGE_SIZES.half} className="timeline__img" />}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Section({ s, timeline, first }: { s: PublicSectionDto; timeline: PublicTimelineItemDto[]; first: boolean }) {
  const { locale } = useI18n();
  const ct = useContentT();
  const hid = `hs-${s.id}`;
  const heading = (level: "h1" | "h2") => (s.title ? (level === "h1" ? <h1 id={hid} className="story__title">{s.title}</h1> : <h2 id={hid} className="story__title">{s.title}</h2>) : null);
  switch (s.type) {
    case "HERO":
      return (
        <header className={`story-hero${s.image ? " story-hero--image" : ""}`}>
          {s.image && <ResponsiveImage image={s.image} sizes={IMAGE_SIZES.hero} priority={first} className="story-hero__img" />}
          <div className="story-hero__text container">
            {heading(first ? "h1" : "h2")}
            {s.subtitle && <p className="story-hero__subtitle">{s.subtitle}</p>}
          </div>
        </header>
      );
    case "QUOTE":
      return (
        <figure className="story-quote container">
          <blockquote>{s.body ?? s.title}</blockquote>
          {s.quoteAuthor && <figcaption>{s.quoteAuthor}</figcaption>}
        </figure>
      );
    case "TIMELINE":
      return (
        <section className="story container" aria-labelledby={hid}>
          {s.title ? <h2 id={hid} className="story__title">{s.title}</h2> : <h2 id={hid} className="story__title">{ct.history.timeline}</h2>}
          {s.body && <p className="story__body">{s.body}</p>}
          <Timeline items={timeline} headingId={hid} />
        </section>
      );
    case "GALLERY":
      return (
        <section className="story story--media container" aria-labelledby={s.title ? hid : undefined}>
          {heading("h2")}
          {s.body && <p className="story__body">{s.body}</p>}
          {s.image && <ResponsiveImage image={s.image} sizes={IMAGE_SIZES.hero} className="story__wide-img" />}
          <p><Link to={pagePath(locale, "gallery")} className="button button--secondary">{ct.home.viewAll}</Link></p>
        </section>
      );
    case "CTA":
      return (
        <section className="story-cta" aria-labelledby={s.title ? hid : undefined}>
          <div className="container story-cta__inner">
            {heading("h2")}
            {s.body && <p>{s.body}</p>}
            <SmartLink href={s.button?.url ?? pagePath(locale, "booking")} className="button button--primary">{s.button?.label ?? ct.home.bookNow}</SmartLink>
          </div>
        </section>
      );
    default: {
      // INTRODUCTION, STORY, IMAGE_TEXT: text with an optional picture beside or above it.
      const layout = (s.layout ?? "DEFAULT").toLowerCase();
      return (
        <section className={`story container story--${layout}${s.image ? " story--has-image" : ""}`} aria-labelledby={s.title ? hid : undefined}>
          {s.image && <ResponsiveImage image={s.image} sizes={layout === "full_width" ? IMAGE_SIZES.hero : IMAGE_SIZES.half} priority={first} className="story__img" />}
          <div className="story__text">
            {heading("h2")}
            {s.subtitle && <p className="story__subtitle">{s.subtitle}</p>}
            {s.body && <p className="story__body">{s.body}</p>}
            {s.button && <SmartLink href={s.button.url} className="button button--secondary">{s.button.label}</SmartLink>}
          </div>
        </section>
      );
    }
  }
}

/** History page (spec §11): sections in the admin's order; the timeline where a Timeline section is (or at the end). */
export function HistoryPage({ title }: { title: string }) {
  const { locale, t } = useI18n();
  const ct = useContentT();
  const { data, error, retry } = usePublicData<PublicHistoryDto>(`/api/public/history?lang=${locale.path}`);
  if (error) {
    return (
      <section className="page container" aria-labelledby="page-title">
        <h1 id="page-title" className="page__title">{title}</h1>
        <div className="empty-state" role="alert"><p>{t.common.loadError}</p><button type="button" className="button button--primary" onClick={retry}>{t.common.retry}</button></div>
      </section>
    );
  }
  if (!data) return <section className="page container" aria-busy="true"><h1 className="page__title">{title}</h1><div className="skeleton skeleton--text" /></section>;

  const hasHero = data.sections[0]?.type === "HERO" && !!data.sections[0].title;
  const hasTimelineSection = data.sections.some((s) => s.type === "TIMELINE");
  const empty = !data.sections.length && !data.timeline.length;
  return (
    <article className="history-page">
      {!hasHero && (
        <div className="container page history-page__head">
          <h1 className="page__title">{title}</h1>
        </div>
      )}
      {empty && <p className="container empty-state">{ct.history.empty}</p>}
      {data.sections.map((s, i) => <Section key={s.id} s={s} timeline={data.timeline} first={i === 0} />)}
      {!hasTimelineSection && data.timeline.length > 0 && (
        <section className="story container" aria-labelledby="history-timeline">
          <h2 id="history-timeline" className="story__title">{ct.history.timeline}</h2>
          <Timeline items={data.timeline} headingId="history-timeline" />
        </section>
      )}
    </article>
  );
}
