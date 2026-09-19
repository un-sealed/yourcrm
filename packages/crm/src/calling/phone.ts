/**
 * E.164 phone normalisation (spec 17-calling, P0).
 *
 * No phone-number library is a declared dependency of `@yourcrm/crm` (adding
 * one is out of scope — `bun add` is not available to this agent), so this is
 * a deliberately narrow, dependency-free normaliser: it accepts what a rep or
 * a provider webhook plausibly sends and produces `+<countrycode><number>`,
 * rejecting anything it cannot normalise with confidence rather than
 * guessing a country code.
 *
 * Rules:
 *  - strip everything but digits and a leading `+`/`00` prefix;
 *  - `00` prefix is treated as the international dialling prefix and
 *    replaced with `+`;
 *  - a value that already starts with `+` is accepted as-is once punctuation
 *    is stripped, provided 8-15 digits follow (ITU E.164 bounds);
 *  - a value with no `+`/`00` prefix is accepted ONLY when `defaultCountryCallingCode`
 *    is supplied (e.g. "1", "91") and the remaining digits are within bounds
 *    — otherwise it is rejected rather than silently mis-normalised.
 */

export class InvalidPhoneNumberError extends Error {
  readonly code = "INVALID_PHONE_NUMBER"
  constructor(raw: string) {
    super(`"${raw}" is not a normalisable phone number (expected E.164, e.g. +14155550123)`)
    this.name = "InvalidPhoneNumberError"
  }
}

const MIN_DIGITS = 8
const MAX_DIGITS = 15

export type NormalizePhoneOptions = {
  /** ITU calling code, no `+` (e.g. "1", "91"), used only when the input has no international prefix. */
  defaultCountryCallingCode?: string
}

/** Normalise a phone number to E.164 (`+<digits>`). Throws `InvalidPhoneNumberError` when it cannot. */
export function normalizeE164(raw: string, options: NormalizePhoneOptions = {}): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new InvalidPhoneNumberError(raw)

  // Keep only digits and a leading "+"; drop spaces, dashes, parens, dots.
  const hasPlus = trimmed.startsWith("+")
  const digitsOnly = trimmed.replace(/[^\d]/g, "")
  if (digitsOnly.length === 0) throw new InvalidPhoneNumberError(raw)

  let national: string
  if (hasPlus) {
    national = digitsOnly
  } else if (digitsOnly.startsWith("00")) {
    national = digitsOnly.slice(2)
  } else if (options.defaultCountryCallingCode) {
    national = `${options.defaultCountryCallingCode}${digitsOnly}`
  } else {
    throw new InvalidPhoneNumberError(raw)
  }

  if (national.length < MIN_DIGITS || national.length > MAX_DIGITS) {
    throw new InvalidPhoneNumberError(raw)
  }
  return `+${national}`
}

/** True when `value` is already normalised E.164 (`+` then 8-15 digits). */
export function isE164(value: string): boolean {
  return /^\+\d{8,15}$/.test(value)
}
