/** Auth error codes. Login failures stay generic (see service.loginUser). */
export const AUTH_ERROR_CODES = [
  "INVALID_CREDENTIALS",
  "EMAIL_TAKEN",
  "RATE_LIMITED",
  "WEAK_PASSWORD",
  "NO_WORKSPACE",
] as const

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number]

export class AuthError extends Error {
  readonly code: AuthErrorCode
  readonly status: number
  constructor(code: AuthErrorCode, message: string, status = 400) {
    super(message)
    this.name = "AuthError"
    this.code = code
    this.status = status
  }
}
