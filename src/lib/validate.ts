export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function str(value: FormDataEntryValue | null | undefined, field: string, opts: {
  min?: number; max?: number; required?: boolean;
} = {}): string {
  const raw = typeof value === "string" ? value : "";
  const trimmed = raw.trim();
  if (opts.required && trimmed.length === 0) throw new ValidationError(`${field} is required`);
  if (opts.min !== undefined && trimmed.length > 0 && trimmed.length < opts.min) {
    throw new ValidationError(`${field} must be at least ${opts.min} characters`);
  }
  if (opts.max !== undefined && trimmed.length > opts.max) {
    throw new ValidationError(`${field} must be under ${opts.max} characters`);
  }
  return trimmed;
}

export function email(value: FormDataEntryValue | null | undefined, field = "Email", required = true): string {
  const v = str(value, field, { required, max: 254 });
  if (!v) return "";
  // Deliberately simple, robust check (full RFC validation is not useful here)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) throw new ValidationError(`${field} is not a valid email address`);
  return v.toLowerCase();
}

export function int(value: FormDataEntryValue | null | undefined, field: string, opts: {
  min?: number; max?: number; fallback?: number;
} = {}): number {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return opts.fallback ?? 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new ValidationError(`${field} must be a whole number`);
  if (opts.min !== undefined && n < opts.min) throw new ValidationError(`${field} must be ${opts.min} or more`);
  if (opts.max !== undefined && n > opts.max) throw new ValidationError(`${field} must be ${opts.max} or less`);
  return n;
}

export function money(value: FormDataEntryValue | null | undefined, field: string): number {
  const raw = typeof value === "string" ? value.trim().replace(/[$,]/g, "") : "";
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new ValidationError(`${field} must be a positive amount`);
  if (n > 10_000_000) throw new ValidationError(`${field} is too large`);
  return Math.round(n * 100);
}

export function oneOf<T extends string>(value: FormDataEntryValue | null | undefined, field: string, allowed: readonly T[], fallback?: T): T {
  const raw = typeof value === "string" ? value : "";
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  if (fallback !== undefined) return fallback;
  throw new ValidationError(`${field} is not a valid option`);
}

export function optionalStr(value: FormDataEntryValue | null | undefined, max = 2000): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.slice(0, max);
}
