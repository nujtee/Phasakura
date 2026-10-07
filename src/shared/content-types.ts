/** Public content API (spec §59): home, gallery, history. Only published, in-window records. */
import type { LocaleCode } from "./i18n/locales.ts";

export interface PublicImageDto {
  url: string;
  width: number | null;
  height: number | null;
  alt: string;
  /** Responsive renditions "url 480w, …" (Phase 12); null when only the original exists. */
  srcset?: string | null;
}

export interface PublicSlideDto {
  id: string;
  desktop: PublicImageDto;
  mobile: PublicImageDto | null;
  overlay: { enabled: boolean; color: string; opacity: number };
  position: string;
  title: string | null;
  subtitle: string | null;
  description: string | null;
  button1: { label: string; url: string } | null;
  button2: { label: string; url: string } | null;
}

export interface PublicSectionDto {
  id: string;
  type: string;
  image: PublicImageDto | null;
  layout: string | null;
  title: string | null;
  subtitle: string | null;
  body: string | null;
  quoteAuthor?: string | null;
  button: { label: string; url: string } | null;
}

export interface PublicHomeDto {
  language: LocaleCode;
  slides: PublicSlideDto[];
  sections: PublicSectionDto[];
}

export interface PublicGalleryCategoryDto {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

export interface PublicGalleryImageDto {
  id: string;
  categorySlug: string | null;
  span: string;
  image: PublicImageDto;
  title: string | null;
  caption: string | null;
}

export interface PublicGalleryDto {
  language: LocaleCode;
  categories: PublicGalleryCategoryDto[];
  images: PublicGalleryImageDto[];
}

export interface PublicTimelineItemDto {
  id: string;
  year: number;
  title: string;
  description: string | null;
  image: PublicImageDto | null;
}

export interface PublicHistoryDto {
  language: LocaleCode;
  sections: PublicSectionDto[];
  timeline: PublicTimelineItemDto[];
}
