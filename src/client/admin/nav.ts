import type { PermissionCode } from "../../shared/auth-types.ts";
import type { AdminMessages } from "../../shared/i18n/admin-messages.ts";

export interface NavItem {
  path: string;
  label: (t: AdminMessages) => string;
  permission: PermissionCode;
  /** Implemented pages; others render a "coming in a later phase" placeholder. */
  ready?: boolean;
  /** Picture shown before the label (an emoji: no image files to load, works in every theme). */
  icon: string;
}

export interface NavGroup {
  /** Stable key: the collapsed / expanded state of a group is remembered by it. */
  id: string;
  /** Groups with a label collapse under it; groups without one are top-level entries. */
  label: ((t: AdminMessages) => string) | null;
  /** Picture before the group's label. */
  icon?: string;
  items: NavItem[];
}

/** Admin sidebar (spec §35). Each item is shown only if the user holds its permission. */
export const ADMIN_NAV: NavGroup[] = [
  { id: "dashboard", label: null, items: [{ path: "", icon: "📊", label: (t) => t.nav.dashboard, permission: "dashboard.view", ready: true }] },
  {
    id: "bookings",
    icon: "🗓️",
    label: (t) => t.nav.bookingsGroup,
    items: [
      { ready: true, path: "bookings", icon: "📋", label: (t) => t.nav.bookings, permission: "bookings.view" },
      { ready: true, path: "calendar", icon: "📅", label: (t) => t.nav.calendar, permission: "calendar.view" },
    ],
  },
  {
    id: "accommodation",
    icon: "🏡",
    label: (t) => t.nav.accommodationGroup,
    items: [
      { ready: true, path: "houses", icon: "🏠", label: (t) => t.nav.houses, permission: "accommodation.view" },
      { ready: true, path: "vip-tents", icon: "⛺", label: (t) => t.nav.vipTents, permission: "accommodation.view" },
      { ready: true, path: "camping", icon: "🏕️", label: (t) => t.nav.camping, permission: "camping.view" },
      { ready: true, path: "pricing", icon: "🏷️", label: (t) => t.nav.pricing, permission: "accommodation.view" },
      { ready: true, path: "channels", icon: "🔗", label: (t) => t.nav.channels, permission: "channels.view" },
      { ready: true, path: "landscape", icon: "🗺️", label: (t) => t.nav.landscape, permission: "landscape.view" },
    ],
  },
  {
    id: "food",
    icon: "🍽️",
    label: (t) => t.nav.foodGroup,
    items: [
      { ready: true, path: "food", icon: "🍱", label: (t) => t.nav.foodMenu, permission: "food.view" },
      { ready: true, path: "food-orders", icon: "🧾", label: (t) => t.nav.foodOrders, permission: "food_orders.view" },
      { ready: true, path: "kitchen", icon: "👨‍🍳", label: (t) => t.nav.kitchen, permission: "kitchen.view" },
    ],
  },
  {
    id: "finance",
    icon: "💰",
    label: (t) => t.nav.financeGroup,
    items: [
      { ready: true, path: "payments", icon: "💳", label: (t) => t.nav.payments, permission: "payments.view" },
      { ready: true, path: "slips", icon: "📄", label: (t) => t.nav.slips, permission: "slips.view" },
      { ready: true, path: "receiving-accounts", icon: "🏦", label: (t) => t.nav.receivingAccounts, permission: "receiving_accounts.view" },
      { ready: true, path: "payment-settings", icon: "🔧", label: (t) => t.nav.paymentSettings, permission: "receiving_accounts.view" },
      // App-usage credits (migration 0027): every back-office user tops up; Super Admin alone manages.
      { ready: true, path: "credit-topup", icon: "🪙", label: (t) => t.nav.creditTopup, permission: "credits.topup" },
      { ready: true, path: "credit-admin", icon: "🗂️", label: (t) => t.nav.creditAdmin, permission: "credits.manage" },
    ],
  },
  { id: "reports", label: null, items: [{ ready: true, path: "reports", icon: "📑", label: (t) => t.nav.reports, permission: "reports.view" }] },
  {
    id: "website",
    icon: "🌐",
    label: (t) => t.nav.websiteGroup,
    items: [
      { ready: true, path: "content-home", icon: "📰", label: (t) => t.nav.home, permission: "content.home" },
      { ready: true, path: "content-gallery", icon: "🖼️", label: (t) => t.nav.gallery, permission: "content.gallery" },
      { ready: true, path: "content-history", icon: "📖", label: (t) => t.nav.history, permission: "content.history" },
      { ready: true, path: "seo", icon: "🔍", label: (t) => t.nav.seo, permission: "seo.edit" },
    ],
  },
  {
    id: "marketing",
    icon: "📣",
    label: (t) => t.nav.marketingGroup,
    items: [
      { ready: true, path: "ga4", icon: "📈", label: (t) => t.nav.ga4, permission: "marketing.view" },
      { ready: true, path: "meta-pixel", icon: "🎯", label: (t) => t.nav.metaPixel, permission: "marketing.view" },
      { ready: true, path: "capi", icon: "🔌", label: (t) => t.nav.capi, permission: "marketing.view" },
      { ready: true, path: "ai-marketing", icon: "🤖", label: (t) => t.nav.aiMarketing, permission: "reports.view" },
    ],
  },
  {
    id: "settings",
    icon: "⚙️",
    label: (t) => t.nav.settingsGroup,
    items: [
      { ready: true, path: "settings-website", icon: "🧭", label: (t) => t.nav.website, permission: "settings.website" },
      { ready: true, path: "settings-branding", icon: "🎨", label: (t) => t.nav.branding, permission: "settings.branding" },
      { ready: true, path: "settings-theme", icon: "🖌️", label: (t) => t.nav.theme, permission: "settings.theme" },
      { ready: true, path: "settings-booking-cta", icon: "🔘", label: (t) => t.nav.bookingCta, permission: "settings.booking_cta" },
      { ready: true, path: "settings-line", icon: "💬", label: (t) => t.nav.line, permission: "settings.line" },
      { ready: true, path: "settings-email", icon: "✉️", label: (t) => t.nav.email, permission: "settings.line" },
      { ready: true, path: "settings-privacy", icon: "🔒", label: (t) => t.nav.privacy, permission: "settings.privacy" },
    ],
  },
  {
    id: "administration",
    icon: "👥",
    label: (t) => t.nav.adminGroup,
    items: [
      { path: "users", icon: "👤", label: (t) => t.nav.users, permission: "users.view", ready: true },
      { path: "roles", icon: "🎭", label: (t) => t.nav.roles, permission: "roles.view", ready: true },
      { path: "permissions", icon: "🔑", label: (t) => t.nav.permissions, permission: "roles.view", ready: true },
      { path: "security-events", icon: "🛡️", label: (t) => t.nav.securityEvents, permission: "security_events.view", ready: true },
      { path: "admin-menu", icon: "🧩", label: (t) => t.nav.adminMenu, permission: "settings.admin_menu", ready: true },
    ],
  },
  {
    id: "system",
    label: null,
    items: [
      { path: "audit-logs", icon: "📜", label: (t) => t.nav.auditLogs, permission: "audit_logs.view", ready: true },
      { path: "system", icon: "🖥️", label: (t) => t.nav.system, permission: "system.view", ready: true },
    ],
  },
];

export function findNavItem(path: string): NavItem | undefined {
  for (const group of ADMIN_NAV) for (const item of group.items) if (item.path === path) return item;
  return undefined;
}
