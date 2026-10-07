import type { PermissionCode } from "../../shared/auth-types.ts";
import type { AdminMessages } from "../../shared/i18n/admin-messages.ts";

export interface NavItem {
  path: string;
  label: (t: AdminMessages) => string;
  permission: PermissionCode;
  /** Implemented pages; others render a "coming in a later phase" placeholder. */
  ready?: boolean;
}

export interface NavGroup {
  label: ((t: AdminMessages) => string) | null;
  items: NavItem[];
}

/** Admin sidebar (spec §35). Each item is shown only if the user holds its permission. */
export const ADMIN_NAV: NavGroup[] = [
  { label: null, items: [{ path: "", label: (t) => t.nav.dashboard, permission: "dashboard.view", ready: true }] },
  {
    label: (t) => t.nav.bookingsGroup,
    items: [
      { ready: true, path: "bookings", label: (t) => t.nav.bookings, permission: "bookings.view" },
      { path: "calendar", label: (t) => t.nav.calendar, permission: "calendar.view" },
    ],
  },
  {
    label: (t) => t.nav.accommodationGroup,
    items: [
      { ready: true, path: "houses", label: (t) => t.nav.houses, permission: "accommodation.view" },
      { ready: true, path: "vip-tents", label: (t) => t.nav.vipTents, permission: "accommodation.view" },
      { ready: true, path: "camping", label: (t) => t.nav.camping, permission: "camping.view" },
      { ready: true, path: "pricing", label: (t) => t.nav.pricing, permission: "accommodation.view" },
    ],
  },
  {
    label: (t) => t.nav.foodGroup,
    items: [
      { path: "food", label: (t) => t.nav.foodMenu, permission: "food.view" },
      { path: "food-orders", label: (t) => t.nav.foodOrders, permission: "food_orders.view" },
      { path: "kitchen", label: (t) => t.nav.kitchen, permission: "kitchen.view" },
    ],
  },
  {
    label: (t) => t.nav.financeGroup,
    items: [
      { path: "payments", label: (t) => t.nav.payments, permission: "payments.view" },
      { ready: true, path: "slips", label: (t) => t.nav.slips, permission: "slips.view" },
      { ready: true, path: "receiving-accounts", label: (t) => t.nav.receivingAccounts, permission: "receiving_accounts.view" },
    ],
  },
  { label: null, items: [{ path: "reports", label: (t) => t.nav.reports, permission: "reports.view" }] },
  {
    label: (t) => t.nav.websiteGroup,
    items: [
      { path: "content-home", label: (t) => t.nav.home, permission: "content.home" },
      { path: "content-gallery", label: (t) => t.nav.gallery, permission: "content.gallery" },
      { path: "content-history", label: (t) => t.nav.history, permission: "content.history" },
      { path: "seo", label: (t) => t.nav.seo, permission: "seo.edit" },
    ],
  },
  {
    label: (t) => t.nav.marketingGroup,
    items: [
      { path: "ga4", label: (t) => t.nav.ga4, permission: "marketing.view" },
      { path: "meta-pixel", label: (t) => t.nav.metaPixel, permission: "marketing.view" },
      { path: "capi", label: (t) => t.nav.capi, permission: "marketing.view" },
    ],
  },
  {
    label: (t) => t.nav.settingsGroup,
    items: [
      { path: "settings-website", label: (t) => t.nav.website, permission: "settings.website" },
      { path: "settings-branding", label: (t) => t.nav.branding, permission: "settings.branding" },
      { path: "settings-theme", label: (t) => t.nav.theme, permission: "settings.theme" },
      { path: "settings-booking-cta", label: (t) => t.nav.bookingCta, permission: "settings.booking_cta" },
      { path: "settings-line", label: (t) => t.nav.line, permission: "settings.line" },
      { path: "settings-privacy", label: (t) => t.nav.privacy, permission: "settings.privacy" },
    ],
  },
  {
    label: (t) => t.nav.adminGroup,
    items: [
      { path: "users", label: (t) => t.nav.users, permission: "users.view", ready: true },
      { path: "roles", label: (t) => t.nav.roles, permission: "roles.view", ready: true },
      { path: "permissions", label: (t) => t.nav.permissions, permission: "roles.view", ready: true },
      { path: "security-events", label: (t) => t.nav.securityEvents, permission: "security_events.view", ready: true },
    ],
  },
  { label: null, items: [{ path: "audit-logs", label: (t) => t.nav.auditLogs, permission: "audit_logs.view", ready: true }] },
];

export function findNavItem(path: string): NavItem | undefined {
  for (const group of ADMIN_NAV) for (const item of group.items) if (item.path === path) return item;
  return undefined;
}
