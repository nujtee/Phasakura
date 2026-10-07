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
}

export interface ServiceOptions {
  /** Origin of the current request, used for links when APP_BASE_URL is not set. */
  origin: string;
  clock?: Clock;
  delivery?: PasswordResetDelivery;
  /** Tests: replace the slip verification service (null = manual only). */
  slipVerifier?: SlipVerifier | null;
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
  const quotes = new QuoteService(pricing, units, inventory, availability, clock);

  const bookings = new BookingService(db, bookingRepo, quotes, authorization, log, clock, paymentRepo, env.PUBLIC_MEDIA_BASE_URL);
  const verifier = options.slipVerifier !== undefined ? options.slipVerifier : createSlipVerifier(env);

  return {
    site: new SiteService(new D1SiteSettingsRepository(db), env.PUBLIC_MEDIA_BASE_URL),
    health: new HealthService(new D1HealthRepository(db)),
    sessions,
    authorization,
    auth: new AuthService(db, users, resets, sessions, links, delivery, log, clock),
    users: new UserManagementService(db, users, rbac, sessions, links, authorization, log, clock),
    logs: new AdminLogService(logRepo, authorization),
    media: new MediaService(db, mediaRepo, env.MEDIA_PUBLIC, authorization, log, env.PUBLIC_MEDIA_BASE_URL, clock),
    accommodation: new AccommodationService(db, units, inventory, mediaRepo, env.MEDIA_PUBLIC, authorization, log, env.PUBLIC_MEDIA_BASE_URL, clock),
    availability,
    quotes,
    bookings,
    slips: new SlipService(db, paymentRepo, bookings, pricing, env.MEDIA_PRIVATE, verifier, authorization, log, clock),
    payments: new PaymentService(db, paymentRepo, bookingRepo, mediaRepo, authorization, log, env.PUBLIC_MEDIA_BASE_URL, clock),
    pricingRules: new PricingRuleService(db, pricing, units, authorization, log, clock),
  };
}
