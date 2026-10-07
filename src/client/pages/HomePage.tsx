import type { PublicAccommodationsDto } from "../../shared/accommodation-types.ts";
import { formatBaht } from "../../shared/booking-rules.ts";
import type { FoodMenuDto } from "../../shared/booking-types.ts";
import type { PublicGalleryDto, PublicHistoryDto, PublicHomeDto, PublicSectionDto } from "../../shared/content-types.ts";
import { IMAGE_SIZES } from "../../shared/media-types.ts";
import { accommodationPath, pagePath } from "../../shared/routes.ts";
import { fill } from "../accommodation/UnitCard.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { HeroSlideshow } from "../content/HeroSlideshow.tsx";
import { ResponsiveImage } from "../content/ResponsiveImage.tsx";
import { SmartLink } from "../content/SmartLink.tsx";
import { usePublicData } from "../content/usePublicData.ts";
import { useContentT } from "../content/useContentT.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";
import { Link } from "../router/Router.tsx";
import { useSite } from "../site/SiteProvider.tsx";
import { useYearLabel } from "./HistoryPage.tsx";

/** Heading row: section title on the left, "see all" on the right (when there is a page to go to). */
function SectionHead({ id, title, more }: { id: string; title: string; more?: { to: string; label: string } }) {
  return (
    <div className="home-section__head">
      <h2 id={id} className="home-section__title">{title}</h2>
      {more && <Link to={more.to} className="home-section__more">{more.label}</Link>}
    </div>
  );
}

function Text({ s }: { s: PublicSectionDto }) {
  return (
    <>
      {s.subtitle && <p className="home-section__subtitle">{s.subtitle}</p>}
      {s.body && <p className="home-section__body">{s.body}</p>}
    </>
  );
}

function Accommodations({ s }: { s: PublicSectionDto }) {
  const { locale } = useI18n();
  const ct = useContentT();
  const { data } = usePublicData<PublicAccommodationsDto>(`/api/public/accommodations?lang=${locale.path}`);
  const units = data ? [...data.houses, ...data.vipTents] : [];
  const id = `home-${s.id}`;
  return (
    <section className="home-section container" aria-labelledby={id}>
      <SectionHead id={id} title={s.title ?? ct.home.accommodations} more={{ to: pagePath(locale, "booking"), label: ct.home.viewAll }} />
      <Text s={s} />
      <ul className="postcards" aria-busy={!data || undefined}>
        {!data && Array.from({ length: 3 }, (_, i) => <li key={i} className="postcard skeleton" />)}
        {units.slice(0, 8).map((u) => (
          <li key={u.id} className="postcard">
            <Link to={accommodationPath(locale, u.slug)} className="postcard__link">
              {u.cover ? <ResponsiveImage image={u.cover} sizes={IMAGE_SIZES.card} className="postcard__img" alt="" /> : <span className="postcard__img postcard__img--empty" />}
              <span className="postcard__text">
                <span className="postcard__name">{u.name}</span>
                <span className="postcard__price">{fill(ct.home.fromPrice, { price: formatBaht(u.priceSatang, locale.code) })}</span>
              </span>
            </Link>
          </li>
        ))}
        {data?.camping.enabled && (
          <li className="postcard">
            <Link to={pagePath(locale, "booking")} className="postcard__link">
              {data.camping.cover ? <ResponsiveImage image={data.camping.cover} sizes={IMAGE_SIZES.card} className="postcard__img" alt="" /> : <span className="postcard__img postcard__img--empty" />}
              <span className="postcard__text">
                <span className="postcard__name">{data.camping.name ?? ct.home.accommodations}</span>
                <span className="postcard__price">{fill(ct.home.campingPrice, { price: formatBaht(data.camping.pricePerAdultNightSatang, locale.code) })}</span>
              </span>
            </Link>
          </li>
        )}
      </ul>
    </section>
  );
}

function GalleryPreview({ s }: { s: PublicSectionDto }) {
  const { locale } = useI18n();
  const ct = useContentT();
  const { data } = usePublicData<PublicGalleryDto>(`/api/public/gallery?lang=${locale.path}`);
  const images = (data?.images ?? []).slice(0, 5);
  const id = `home-${s.id}`;
  if (data && !images.length) return null;
  return (
    <section className="home-section container" aria-labelledby={id}>
      <SectionHead id={id} title={s.title ?? ct.home.gallery} more={{ to: pagePath(locale, "gallery"), label: ct.home.viewAll }} />
      <Text s={s} />
      <ul className={`mosaic mosaic--n${data ? images.length : 5}`} aria-busy={!data || undefined}>
        {!data && Array.from({ length: 5 }, (_, i) => <li key={i} className="mosaic__item skeleton" />)}
        {images.map((g, i) => (
          <li key={g.id} className="mosaic__item">
            <Link to={pagePath(locale, "gallery")} className="mosaic__link" aria-label={fill(ct.gallery.open, { title: g.title ?? g.image.alt })}>
              <ResponsiveImage image={g.image} sizes={i === 0 ? IMAGE_SIZES.galleryWide : IMAGE_SIZES.gallery} className="mosaic__img" alt="" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HistoryPreview({ s }: { s: PublicSectionDto }) {
  const { locale } = useI18n();
  const ct = useContentT();
  const year = useYearLabel();
  const { data } = usePublicData<PublicHistoryDto>(`/api/public/history?lang=${locale.path}`);
  const id = `home-${s.id}`;
  const items = (data?.timeline ?? []).slice(0, 3);
  return (
    <section className={`home-section container home-story${s.image ? " home-story--image" : ""}`} aria-labelledby={id}>
      {s.image && <ResponsiveImage image={s.image} sizes={IMAGE_SIZES.half} className="home-story__img" />}
      <div className="home-story__text">
        <SectionHead id={id} title={s.title ?? ct.home.history} />
        <Text s={s} />
        {items.length > 0 && (
          <ol className="mini-timeline">
            {items.map((it) => (
              <li key={it.id}><span className="mini-timeline__year">{year(it.year)}</span> <span>{it.title}</span></li>
            ))}
          </ol>
        )}
        <Link to={pagePath(locale, "history")} className="button button--secondary">{s.button?.label ?? ct.home.readMore}</Link>
      </div>
    </section>
  );
}

function FoodPreview({ s }: { s: PublicSectionDto }) {
  const { locale } = useI18n();
  const ct = useContentT();
  const { data } = usePublicData<FoodMenuDto>(`/api/public/food-menu?lang=${locale.path}`);
  const id = `home-${s.id}`;
  const unit = { PER_PERSON: ct.food.perPerson, PER_SET: ct.food.perSet, PER_ITEM: ct.food.perItem, PER_NIGHT: ct.food.perNight };
  if (data && !data.categories.length) return null;
  return (
    <section className="home-section container" aria-labelledby={id}>
      <SectionHead id={id} title={s.title ?? ct.home.food} more={{ to: pagePath(locale, "booking"), label: s.button?.label ?? ct.home.bookNow }} />
      <Text s={s} />
      <div className="menu" aria-busy={!data || undefined}>
        {data?.categories.map((c) => (
          <section key={c.id} className="menu__group" aria-labelledby={`menu-${c.id}`}>
            <h3 id={`menu-${c.id}`} className="menu__category">{c.name}{c.serviceTime && <span className="menu__time"> {c.serviceTime}</span>}</h3>
            <ul className="menu__list">
              {c.options.slice(0, 6).map((o) => (
                <li key={o.id} className={`menu__item${o.image ? " menu__item--image" : ""}`}>
                  {o.image && <ResponsiveImage image={o.image} sizes={IMAGE_SIZES.thumb} className="menu__img" alt="" />}
                  <div className="menu__text">
                    <p className="menu__line">
                      <span className="menu__name">{o.name}</span>
                      <span className="menu__leader" aria-hidden="true" />
                      <span className="menu__price">{formatBaht(o.priceSatang, locale.code)} <span className="menu__unit">{unit[o.pricingType]}</span></span>
                    </p>
                    {o.description && <p className="menu__desc">{o.description}</p>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}

function Location({ s }: { s: PublicSectionDto }) {
  const { site } = useSite();
  const ct = useContentT();
  const id = `home-${s.id}`;
  const c = site?.contact;
  return (
    <section className={`home-section container home-story${s.image ? " home-story--image" : ""}`} aria-labelledby={id}>
      {s.image && <ResponsiveImage image={s.image} sizes={IMAGE_SIZES.half} className="home-story__img" />}
      <div className="home-story__text">
        <SectionHead id={id} title={s.title ?? ct.home.location} />
        <Text s={s} />
        {c?.address && <p className="home-address">{c.address}</p>}
        {c?.mapUrl && <a href={c.mapUrl} className="button button--secondary" target="_blank" rel="noopener noreferrer">{ct.home.openMap}</a>}
      </div>
    </section>
  );
}

function Contact({ s }: { s: PublicSectionDto }) {
  const { site } = useSite();
  const ct = useContentT();
  const id = `home-${s.id}`;
  const c = site?.contact;
  return (
    <section className="home-section container" aria-labelledby={id}>
      <SectionHead id={id} title={s.title ?? ct.home.contact} />
      <Text s={s} />
      <dl className="contact-list">
        {c?.phone && <><dt>{ct.home.phone}</dt><dd><a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`}>{c.phone}</a></dd></>}
        {c?.email && <><dt>{ct.home.email}</dt><dd><a href={`mailto:${c.email}`}>{c.email}</a></dd></>}
        {c?.lineOaUrl && <><dt>{ct.home.line}</dt><dd><a href={c.lineOaUrl} target="_blank" rel="noopener noreferrer">{c.lineOaUrl.replace(/^https:\/\//, "")}</a></dd></>}
        {c?.address && <><dt>{ct.home.address}</dt><dd>{c.address}</dd></>}
      </dl>
    </section>
  );
}

function BookingBand({ s }: { s: PublicSectionDto }) {
  const { locale } = useI18n();
  const ct = useContentT();
  const id = `home-${s.id}`;
  return (
    <section className="booking-band" aria-labelledby={id}>
      <div className="container booking-band__inner">
        <div>
          <h2 id={id} className="booking-band__title">{s.title ?? ct.home.bookNow}</h2>
          {s.body && <p className="booking-band__body">{s.body}</p>}
        </div>
        <SmartLink href={s.button?.url ?? pagePath(locale, "booking")} className="button booking-band__button">{s.button?.label ?? ct.home.bookNow}</SmartLink>
      </div>
    </section>
  );
}

/** INTRODUCTION / CUSTOM: words first, picture beside them when there is one. */
function Story({ s }: { s: PublicSectionDto }) {
  const id = `home-${s.id}`;
  return (
    <section className={`home-section container home-story${s.image ? " home-story--image" : ""}`} aria-labelledby={s.title ? id : undefined}>
      {s.image && <ResponsiveImage image={s.image} sizes={IMAGE_SIZES.half} className="home-story__img" />}
      <div className="home-story__text">
        {s.title && <h2 id={id} className="home-section__title">{s.title}</h2>}
        <Text s={s} />
        {s.button && <SmartLink href={s.button.url} className="button button--secondary">{s.button.label}</SmartLink>}
      </div>
    </section>
  );
}

function HomeSection({ s }: { s: PublicSectionDto }) {
  switch (s.type) {
    case "ACCOMMODATION_HIGHLIGHTS": return <Accommodations s={s} />;
    case "GALLERY_PREVIEW": return <GalleryPreview s={s} />;
    case "HISTORY_PREVIEW": return <HistoryPreview s={s} />;
    case "FOOD_PREVIEW": return <FoodPreview s={s} />;
    case "BOOKING_CTA": return <BookingBand s={s} />;
    case "LOCATION": return <Location s={s} />;
    case "CONTACT": return <Contact s={s} />;
    default: return <Story s={s} />;
  }
}

/** Home (spec §8): hero slideshow + the sections the admin published, in their order. All from D1 / R2. */
export function HomePage() {
  const { t, locale } = useI18n();
  const { site } = useSite();
  const { data, error, retry } = usePublicData<PublicHomeDto>(`/api/public/home?lang=${locale.path}`);
  const title = site?.siteName ?? t.pages.home.title;

  if (error) {
    return (
      <section className="page container" aria-labelledby="page-title">
        <h1 id="page-title" className="page__title">{title}</h1>
        <div className="empty-state" role="alert"><p>{t.common.loadError}</p><button type="button" className="button button--primary" onClick={retry}>{t.common.retry}</button></div>
      </section>
    );
  }
  if (!data) return <div className="hero hero--loading skeleton" aria-busy="true"><h1 className="visually-hidden">{title}</h1></div>;

  const hasSlides = data.slides.length > 0;
  return (
    <div className="home">
      {hasSlides ? <HeroSlideshow slides={data.slides} title={title} /> : (
        <section className="page container home-intro" aria-labelledby="page-title">
          <h1 id="page-title" className="page__title">{title}</h1>
          {site?.tagline && <p className="page__lead">{site.tagline}</p>}
          {!data.sections.length && <EmptyState />}
        </section>
      )}
      {data.sections.map((s) => <HomeSection key={s.id} s={s} />)}
    </div>
  );
}
