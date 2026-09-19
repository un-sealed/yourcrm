/**
 * True when the browser reports it has gone offline. Falls back to "not
 * offline" outside a browser (SSR, `bun test`, where `navigator.onLine`
 * doesn't exist) so nothing here changes server-rendering or non-browser
 * test behavior.
 */
export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false
}
