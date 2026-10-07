import { ValidationError } from "./http/errors.ts";

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

interface StringOptions {
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: RegExp;
  /** Keep whitespace as-is (passwords). Default: trimmed. */
  raw?: boolean;
}

/**
 * Small explicit validator. Every endpoint declares exactly which fields it accepts;
 * unknown fields are rejected (mass-assignment protection).
 */
export class Validator {
  readonly errors: Record<string, string> = {};

  constructor(private readonly body: Record<string, unknown>) {}

  allowOnly(fields: readonly string[]): this {
    for (const key of Object.keys(this.body)) {
      if (!fields.includes(key)) this.errors[key] = "UNKNOWN_FIELD";
    }
    return this;
  }

  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.body, key) && this.body[key] !== undefined;
  }

  string(key: string, options: StringOptions & { required: true }): string;
  string(key: string, options?: StringOptions): string | undefined;
  string(key: string, options: StringOptions = {}): string | undefined {
    const value = this.body[key];
    if (value === undefined || value === null || value === "") {
      if (options.required) this.errors[key] = "REQUIRED";
      return undefined;
    }
    if (typeof value !== "string") {
      this.errors[key] = "EXPECTED_STRING";
      return undefined;
    }
    const v = options.raw ? value : value.trim();
    const length = [...v].length;
    if (!options.raw && CONTROL_CHARS.test(v)) this.errors[key] = "INVALID_CHARACTERS";
    else if (options.required && length === 0) this.errors[key] = "REQUIRED";
    else if (options.min !== undefined && length < options.min) this.errors[key] = "TOO_SHORT";
    else if (options.max !== undefined && length > options.max) this.errors[key] = "TOO_LONG";
    else if (options.pattern && !options.pattern.test(v)) this.errors[key] = "INVALID_FORMAT";
    return v;
  }

  email(key: string, options: { required: true }): string;
  email(key: string, options?: { required?: boolean }): string | undefined;
  email(key: string, options: { required?: boolean } = {}): string | undefined {
    const v = this.string(key, { required: options.required, max: 254 });
    if (v !== undefined && !this.errors[key] && !EMAIL.test(v)) this.errors[key] = "INVALID_EMAIL";
    return v?.toLowerCase();
  }

  boolean(key: string, fallback: boolean): boolean {
    const value = this.body[key];
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") {
      this.errors[key] = "EXPECTED_BOOLEAN";
      return fallback;
    }
    return value;
  }

  oneOf<T extends string>(key: string, values: readonly T[], options: { required?: boolean } = {}): T | undefined {
    const v = this.string(key, { required: options.required });
    if (v !== undefined && !this.errors[key] && !values.includes(v as T)) this.errors[key] = "INVALID_VALUE";
    return v as T | undefined;
  }

  stringArray(key: string, options: { max?: number; pattern?: RegExp; required?: boolean } = {}): string[] | undefined {
    const value = this.body[key];
    if (value === undefined) {
      if (options.required) this.errors[key] = "REQUIRED";
      return undefined;
    }
    if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
      this.errors[key] = "EXPECTED_STRING_ARRAY";
      return undefined;
    }
    if (options.max !== undefined && value.length > options.max) this.errors[key] = "TOO_MANY";
    if (options.pattern && !value.every((x) => options.pattern!.test(x))) this.errors[key] = "INVALID_FORMAT";
    return [...new Set(value as string[])];
  }

  /** Throws ValidationError (422) if any field failed. */
  assertValid(): void {
    if (Object.keys(this.errors).length > 0) throw new ValidationError(this.errors);
  }
}

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;
export const PERMISSION_CODE_PATTERN = /^[a-z_]+\.[a-z_.]+$/;
export const ROLE_CODE_PATTERN = /^[A-Z_]{2,32}$/;
