import type { PermissionCode } from "../../shared/auth-types.ts";
import type { CmsEntityName } from "../../shared/cms-schema.ts";

/**
 * Storage + permission configuration of every CMS entity (server only).
 * Table / column names are constants here — never taken from a request.
 */
export interface EntityConfig {
  table: string;
  /** Translation table: PRIMARY KEY (<transFk>, language_code). */
  trans?: { table: string; fk: string };
  module: string;
  view: PermissionCode;
  edit: PermissionCode;
  /** Publish / unpublish permission (publishable entities). */
  publish?: PermissionCode;
  deleteMode: "hard" | "soft" | "none";
  createdBy?: string;
  updatedBy?: string;
  hasUpdatedAt: boolean;
  /** Column set to "now" the first time a record is published. */
  publishedAt?: string;
  /** Status values for publish / unpublish. */
  publishStatus?: { published: string; unpublished: string };
  /** List filters accepted from the query string → column. */
  filters?: Record<string, string>;
  orderBy: string;
}

/** Tables a `ref` field may point to, and when a referenced row still counts as existing. */
export const REF_TABLES: Record<string, { table: string; alive: string }> = {
  foodCategory: { table: "food_categories", alive: "1 = 1" },
  foodOption: { table: "food_options", alive: "status <> 'DELETED'" },
  unit: { table: "accommodation_units", alive: "status <> 'DELETED'" },
  galleryCategory: { table: "gallery_categories", alive: "status <> 'DELETED'" },
};

export const ENTITY_CONFIG: Record<CmsEntityName, EntityConfig> = {
  foodCategory: {
    table: "food_categories", trans: { table: "food_category_translations", fk: "food_category_id" },
    module: "food", view: "food.view", edit: "food.edit", deleteMode: "none", hasUpdatedAt: false,
    orderBy: "t.sort_order, t.code",
  },
  foodOption: {
    table: "food_options", trans: { table: "food_option_translations", fk: "food_option_id" },
    module: "food", view: "food.view", edit: "food.edit", deleteMode: "soft", createdBy: "created_by", hasUpdatedAt: true,
    filters: { foodCategoryId: "food_category_id" },
    orderBy: "t.sort_order, t.code",
  },
  includedMeal: {
    table: "included_meals",
    module: "food", view: "food.view", edit: "food.edit", deleteMode: "none", hasUpdatedAt: true,
    orderBy: "t.created_at, t.id",
  },
  homeSlide: {
    table: "home_slides", trans: { table: "home_slide_translations", fk: "slide_id" },
    module: "home", view: "content.view", edit: "content.home", publish: "content.publish", deleteMode: "hard",
    createdBy: "created_by", hasUpdatedAt: true, publishStatus: { published: "PUBLISHED", unpublished: "INACTIVE" },
    orderBy: "t.sort_order, t.created_at",
  },
  homeSection: {
    table: "home_sections", trans: { table: "home_section_translations", fk: "section_id" },
    module: "home", view: "content.view", edit: "content.home", publish: "content.publish", deleteMode: "hard",
    updatedBy: "updated_by", hasUpdatedAt: true, publishStatus: { published: "PUBLISHED", unpublished: "UNPUBLISHED" },
    orderBy: "t.sort_order, t.created_at",
  },
  galleryCategory: {
    table: "gallery_categories", trans: { table: "gallery_category_translations", fk: "category_id" },
    module: "gallery", view: "content.view", edit: "content.gallery", publish: "content.publish", deleteMode: "soft",
    hasUpdatedAt: true, publishStatus: { published: "PUBLISHED", unpublished: "UNPUBLISHED" },
    orderBy: "t.sort_order, t.slug",
  },
  galleryImage: {
    table: "gallery_images", trans: { table: "gallery_image_translations", fk: "image_id" },
    module: "gallery", view: "content.view", edit: "content.gallery", publish: "content.publish", deleteMode: "soft",
    createdBy: "created_by", hasUpdatedAt: true, publishedAt: "published_at",
    publishStatus: { published: "PUBLISHED", unpublished: "UNPUBLISHED" },
    filters: { categoryId: "category_id" },
    orderBy: "t.sort_order, t.created_at",
  },
  historySection: {
    table: "history_sections", trans: { table: "history_translations", fk: "section_id" },
    module: "history", view: "content.view", edit: "content.history", publish: "content.publish", deleteMode: "soft",
    updatedBy: "updated_by", hasUpdatedAt: true, publishStatus: { published: "PUBLISHED", unpublished: "UNPUBLISHED" },
    orderBy: "t.sort_order, t.created_at",
  },
  historyTimeline: {
    table: "history_timeline", trans: { table: "history_timeline_translations", fk: "timeline_id" },
    module: "history", view: "content.view", edit: "content.history", publish: "content.publish", deleteMode: "soft",
    hasUpdatedAt: true, publishStatus: { published: "PUBLISHED", unpublished: "UNPUBLISHED" },
    orderBy: "t.sort_order, t.year",
  },
  seoRedirect: {
    table: "seo_redirects",
    module: "seo", view: "seo.edit", edit: "seo.edit", deleteMode: "hard", createdBy: "created_by", hasUpdatedAt: false,
    orderBy: "t.from_path",
  },
};

/** camelCase API key → snake_case column. */
export function column(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
