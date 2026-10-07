import type { Env } from "./env.ts";
import { D1HealthRepository } from "./repositories/health.repository.ts";
import { LogRepository } from "./repositories/log.repository.ts";
import { PasswordResetRepository } from "./repositories/password-reset.repository.ts";
import { RbacRepository } from "./repositories/rbac.repository.ts";
import { SessionRepository } from "./repositories/session.repository.ts";
import { D1SiteSettingsRepository } from "./repositories/site-settings.repository.ts";
import { UserRepository } from "./repositories/user.repository.ts";
import { AccommodationRepository } from "./repositories/accommodation.repository.ts";
import { InventoryRepository } from "./repositories/inventory.repository.ts";
import { MediaRepository } from "./repositories/media.repository.ts";
import { BookingRepository } from "./repositories/booking.repository.ts";
import { PricingRepository } from "./repositories/pricing.repository.ts";
import { PaymentRepository } from "./repositories/payment.repository.ts";
import { PaymentService } from "./services/payment.service.ts";
import { SlipService } from "./services/slip.service.ts";
import { createSlipVerifier, type SlipVerifier } from "./slip/slip-verifier.ts";
import { BookingService } from "./services/booking.service.ts";
import { PricingRuleService } from "./services/pricing-rule.service.ts";
import { QuoteService } from "./services/quote.service.ts";
import { AccommodationService } from "./services/accommodation.service.ts";
import { AdminLogService } from "./services/admin-log.service.ts";
import { AvailabilityService } from "./services/availability.service.ts";
import { MediaService } from "./services/media.service.ts";
import { AuthService } from "./services/auth.service.ts";
import { systemClock, type Clock } from "./services/auth-context.ts";
import { AuthorizationService } from "./services/authorization.service.ts";
import { HealthService } from "./services/health.service.ts";
import { ConsoleOrNoopDelivery, PasswordLinkService, type PasswordResetDelivery } from "./services/password-link.service.ts";
import { SecurityLogService } from "./services/security-log.service.ts";
import { SessionService } from "./services/session.service.ts";
import { SiteService } from "./services/site.service.ts";
import { UserManagementService } from "./services/user-management.service.ts";
import { CmsService } from "./cms/cms.service.ts";
import { DashboardRepository } from "./repositories/dashboard.repository.ts";
import { FoodAdminRepository } from "./repositories/food-admin.repository.ts";
import { SettingsRepository } from "./repositories/settings.repository.ts";
import { DashboardService } from "./services/dashboard.service.ts";
import { FoodAdminService } from "./services/food-admin.service.ts";
import { PublicContentService } from "./services/public-content.service.ts";
import { SettingsService } from "./services/settings.service.ts";
import { ReportRepository } from "./repositories/report.repository.ts";
import { ReportService } from "./services/report.service.ts";
import { LineRepository } from "./repositories/line.repository.ts";
import { LineService } from "./services/line.service.ts";
import { NotificationService, Outbox } from "./services/notification.service.ts";
import { LINE_WEBHOOK_PATH, type FetchLike } from "./line/line-api.ts";
import { getLocale, parseLocale } from "../shared/i18n/locales.ts";
import { ImageResolver } from "./media/image-resolver.ts";
import { FontRepository } from "./repositories/font.repository.ts";
import { FontService } from "./services/font.service.ts";

/**
 * Composition root: wires repositories into services per request.
 * Tests replace pieces via `createApp({ services, clock, delivery })`.
 */
export interface Services {
  site: SiteService;
  health: HealthService;
  sessions: SessionService;
  auth: AuthService;
  authorization: AuthorizationService;
  users: UserManagementService;
  logs: AdminLogService;
  media: MediaService;
  accommodation: AccommodationService;
  availability: AvailabilityService;
  quotes: QuoteService;
  bookings: BookingService;
  pricingRules: PricingRuleService;
  payments: PaymentService;
  slips: SlipService;
  dashboard: DashboardService;
  cms: CmsService;
  settings: SettingsService;
  foodAdmin: FoodAdminService;
  content: PublicContentService;
  reports: ReportService;
  line: LineService;
  notifications: NotificationService;
  fonts: FontService;
}

export interface ServiceOptions {
  /** Origin of the current request, used for links when APP_BASE_URL is not set. */
  origin: string;
  clock?: Clock;
  delivery?: PasswordResetDelivery;
  /** Tests: replace the slip verification service (null = manual only). */
  slipVerifier?: SlipVerifier | null;
  /** Tests / e2e: fetch used for the LINE Messaging API. */
  lineFetch?: FetchLike;
}

/** Absolute links (reset / invite) use APP_BASE_URL when configured (https only). */
export function resolveBaseUrl(env: Env, origin: string): string {
  const configured = env.APP_BASE_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" || url.hostname === "localhost") return url.origin;
    } catch {
      // fall through to the request origin
    }
  }
  return origin;
}

/** Only an explicitly configured https APP_BASE_URL is used for links inside LINE messages (cron has no request origin). */
export function configuredBaseUrl(env: Env): string | null {
  const configured = env.APP_BASE_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function createServices(env: Env, options: ServiceOptions): Services {
  const clock = options.clock ?? systemClock;
  const db = env.DB;

  const users = new UserRepository(db);
  const rbac = new RbacRepository(db);
  const resets = new PasswordResetRepository(db);
  const logRepo = new LogRepository(db);

  const log = new SecurityLogService(logRepo, clock);
  const authorization = new AuthorizationService(log);
  const sessions = new SessionService(new SessionRepository(db), rbac, clock);
  const links = new PasswordLinkService(resets, resolveBaseUrl(env, options.origin), clock);
  const delivery = options.delivery ?? new ConsoleOrNoopDelivery(env.APP_ENV === "development");

  const mediaRepo = new MediaRepository(db);
  const units = new AccommodationRepository(db);
  const inventory = new InventoryRepository(db);

  const pricing = new PricingRepository(db);
  const paymentRepo = new PaymentRepository(db);
  const bookingRepo = new BookingRepository(db);
  const availability = new AvailabilityService(db, units, inventory, mediaRepo, authorization, log, clock, pricing);
  const media = new MediaService(db, mediaRepo, env.MEDIA_PUBLIC, authorization, log, env.PUBLIC_MEDIA_BASE_URL, clock);
  const fontRepo = new FontRepository(db);
  // Responsive image renditions (Phase 12).
  const images = new ImageResolver(db, env.PUBLIC_MEDIA_BASE_URL);
  const quotes = new QuoteService(pricing, units, inventory, availability, clock, images, env.PUBLIC_MEDIA_BASE_URL);

  // LINE (Phase 11): outbox rows are written inside the payment / slip / cancel batches.
  const site = new SiteService(new D1SiteSettingsRepository(db), env.PUBLIC_MEDIA_BASE_URL);
  const publicSite = (lang: string) => site.getPublicSite(getLocale(parseLocale(lang)?.code ?? "th"));
  const lineRepo = new LineRepository(db);
  const outbox = new Outbox(lineRepo);
  const notifications = new NotificationService(
    db, lineRepo, new ReportRepository(db),
    async (lang) => {
      const s = await publicSite(lang);
      return { name: s.siteName, address: s.contact.address, phone: s.contact.phone, mapUrl: s.contact.mapUrl };
    },
    () => inventory.siteTimezone(), clock,
    { token: env.LINE_CHANNEL_ACCESS_TOKEN?.trim() || null, fetch: options.lineFetch, linkBase: configuredBaseUrl(env) },
  );
  let bookingsRef: BookingService | null = null;
  const line = new LineService(db, lineRepo, notifications, { guestBooking: (c, p, m) => bookingsRef!.guestBooking(c, p, m) },
    authorization, log, clock, {
      secret: env.LINE_CHANNEL_SECRET?.trim() || null,
      webhookUrl: `${resolveBaseUrl(env, options.origin)}${LINE_WEBHOOK_PATH}`,
      timezone: () => inventory.siteTimezone(),
      siteLineUrl: async () => (await publicSite("th")).contact.lineOaUrl,
      siteName: async (lang) => (await publicSite(lang)).siteName,
    });
  const bookings = new BookingService(db, bookingRepo, quotes, authorization, log, clock, paymentRepo, env.PUBLIC_MEDIA_BASE_URL,
    outbox, (row) => line.guestStatus(row));
  bookingsRef = bookings;
  const verifier = options.slipVerifier !== undefined ? options.slipVerifier : createSlipVerifier(env);

  return {
    site,
    health: new HealthService(new D1HealthRepository(db)),
    sessions,
    authorization,
    auth: new AuthService(db, users, resets, sessions, links, delivery, log, clock),
    users: new UserManagementService(db, users, rbac, sessions, links, authorization, log, clock),
    logs: new AdminLogService(logRepo, authorization),
    media,
    accommodation: new AccommodationService(db, units, inventory, mediaRepo, env.MEDIA_PUBLIC, authorization, log, env.PUBLIC_MEDIA_BASE_URL, clock, images),
    availability,
    quotes,
    bookings,
    slips: new SlipService(db, paymentRepo, bookings, pricing, env.MEDIA_PRIVATE, verifier, authorization, log, clock, outbox),
    payments: new PaymentService(db, paymentRepo, bookingRepo, mediaRepo, authorization, log, env.PUBLIC_MEDIA_BASE_URL, clock, outbox),
    pricingRules: new PricingRuleService(db, pricing, units, authorization, log, clock),
    dashboard: new DashboardService(new DashboardRepository(db), inventory, authorization, clock),
    cms: new CmsService(db, authorization, log, clock, env.PUBLIC_MEDIA_BASE_URL),
    settings: new SettingsService(db, new SettingsRepository(db), authorization, log, clock, env.PUBLIC_MEDIA_BASE_URL, {
      capiToken: !!env.META_CAPI_ACCESS_TOKEN?.trim(),
      testEventCode: !!env.META_TEST_EVENT_CODE?.trim(),
    }, fontRepo),
    foodAdmin: new FoodAdminService(db, new FoodAdminRepository(db), inventory, authorization, log, clock),
    content: new PublicContentService(db, clock, env.PUBLIC_MEDIA_BASE_URL, images),
    reports: new ReportService(new ReportRepository(db), inventory, authorization, log, clock),
    line,
    notifications,
    fonts: new FontService(db, fontRepo, media, mediaRepo, authorization, log, clock, env.PUBLIC_MEDIA_BASE_URL),
  };
}
