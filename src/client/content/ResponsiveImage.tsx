import type { CSSProperties } from "react";

export interface ImageLike {
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
  srcset?: string | null;
}

/**
 * <img> with responsive renditions (srcset/sizes), reserved space (width/height) and lazy loading.
 * `priority` = the image people see first (hero / main photo): eager + high fetch priority.
 */
export function ResponsiveImage({ image, sizes, priority = false, className, alt, style }: {
  image: ImageLike;
  sizes: string;
  priority?: boolean;
  className?: string;
  /** Override (e.g. "" for decorative thumbnails next to a text label). */
  alt?: string;
  style?: CSSProperties;
}) {
  return (
    <img
      src={image.url}
      srcSet={image.srcset ?? undefined}
      sizes={image.srcset ? sizes : undefined}
      alt={alt ?? image.alt}
      width={image.width ?? undefined}
      height={image.height ?? undefined}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      fetchPriority={priority ? "high" : undefined}
      className={className}
      style={style}
    />
  );
}
