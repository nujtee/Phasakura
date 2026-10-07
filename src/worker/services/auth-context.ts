import type { PermissionCode } from "../../shared/auth-types.ts";

/** The authenticated admin for the current request. Built once per request. */
export interface AuthContext {
  userId: string;
  email: string;
  username: string | null;
  displayName: string;
  preferredLanguage: string | null;
  mustChangePassword: boolean;
  roles: readonly string[];
  permissions: ReadonlySet<string>;
  session: { id: string; expiresAt: string; rememberMe: boolean };
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export function iso(date: Date): string {
  return date.toISOString();
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

export type { PermissionCode };
