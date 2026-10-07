import { useMemo, useState } from "react";
import type { PublicGalleryDto } from "../../shared/content-types.ts";
import { IMAGE_SIZES } from "../../shared/media-types.ts";
import { fill } from "../accommodation/UnitCard.tsx";
import { Lightbox } from "../content/Lightbox.tsx";
import { ResponsiveImage } from "../content/ResponsiveImage.tsx";
import { usePublicData } from "../content/usePublicData.ts";
import { useContentT } from "../content/useContentT.ts";
import { useI18n } from "../i18n/I18nProvider.tsx";

/**
 * Public gallery (spec §10): category filter, bento grid (the admin's "wide / tall / large"
 * spans), responsive + lazy images, skeleton while loading, empty state, lightbox.
 */
export function GalleryPage({ title }: { title: string }) {
  const { locale, t } = useI18n();
  const ct = useContentT();
  const { data, error, retry } = usePublicData<PublicGalleryDto>(`/api/public/gallery?lang=${locale.path}`);
  const [category, setCategory] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const images = useMemo(
    () => (data?.images ?? []).filter((i) => category === null || i.categorySlug === category),
    [data, category],
  );
  // Only categories that have photos are offered as filters.
  const categories = (data?.categories ?? []).filter((c) => data?.images.some((i) => i.categorySlug === c.slug));
  const items = images.map((g) => ({ id: g.id, image: g.image, title: g.title, caption: g.caption }));

  return (
    <section className="page container gallery-page" aria-labelledby="page-title">
      <h1 id="page-title" className="page__title">{title}</h1>

      {error && (
        <div className="empty-state" role="alert">
          <p>{t.common.loadError}</p>
          <button type="button" className="button button--primary" onClick={retry}>{t.common.retry}</button>
        </div>
      )}

      {!data && !error && (
        <div className="bento bento--skeleton" aria-busy="true" aria-label={ct.gallery.loading}>
          {Array.from({ length: 8 }, (_, i) => <div key={i} className={`bento__item skeleton${i % 5 === 0 ? " bento__item--wide" : ""}`} />)}
        </div>
      )}

      {data && categories.length > 0 && (
        <div className="gallery-filter" role="group" aria-label={ct.gallery.filter}>
          <button type="button" className="chip" aria-pressed={category === null} onClick={() => setCategory(null)}>{ct.gallery.all}</button>
          {categories.map((c) => (
            <button key={c.id} type="button" className="chip" aria-pressed={category === c.slug} onClick={() => setCategory(c.slug)}>{c.name}</button>
          ))}
        </div>
      )}

      {data && (
        images.length === 0 ? (
          <p className="empty-state">{category ? ct.gallery.emptyCategory : ct.gallery.empty}</p>
        ) : (
          <>
            {category && <p className="gallery-page__count" aria-live="polite">{fill(ct.gallery.count, { n: images.length })}</p>}
            <ul className="bento">
              {images.map((g, i) => {
                const span = g.span.toLowerCase();
                const label = g.title ?? g.image.alt ?? "";
                return (
                  <li key={g.id} className={`bento__item bento__item--${span}`}>
                    <button type="button" className="bento__button" onClick={() => setOpen(i)} aria-label={fill(ct.gallery.open, { title: label })}>
                      <ResponsiveImage image={g.image} sizes={span === "normal" || span === "tall" ? IMAGE_SIZES.gallery : IMAGE_SIZES.galleryWide}
                        priority={i < 2} className="bento__img" />
                    </button>
                    {g.title && <p className="bento__title" aria-hidden="true">{g.title}</p>}
                  </li>
                );
              })}
            </ul>
          </>
        )
      )}

      <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />
    </section>
  );
}
