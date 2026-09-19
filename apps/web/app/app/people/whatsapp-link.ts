/**
 * `https://wa.me/<number>` requires digits only — no `+`, spaces,
 * parentheses or dashes — country code included. Returns `null` for a
 * phone number with no digits at all so callers can skip rendering the
 * quick action instead of linking to a broken URL.
 */
export function toWhatsAppLink(phone: string): string | null {
  const digits = phone.replace(/\D/g, "")
  return digits === "" ? null : `https://wa.me/${digits}`
}
