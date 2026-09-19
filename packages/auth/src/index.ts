export { devSession, requireWorkspace, roleInWorkspace, UnauthorizedError } from "./session"
export type { Session, SessionMembership, SessionUser, WorkspaceRole } from "./session"
export { AuthError, AUTH_ERROR_CODES, type AuthErrorCode } from "./errors"
export { hashPassword, verifyPassword } from "./password"
export {
  generateSessionToken,
  hashSessionToken,
  SESSION_TOKEN_BYTES,
  tokenHashesEqual,
} from "./tokens"
export {
  createLoginRateLimiters,
  LoginRateLimiter,
  type LoginRateLimiters,
  type RateLimitOptions,
} from "./rate-limit"
export {
  emailSchema,
  loginSchema,
  MIN_PASSWORD_LENGTH,
  passwordSchema,
  signupSchema,
  type LoginInput,
  type SignupInput,
} from "./schemas"
export type { AuthMembershipRecord, AuthSessionRecord, AuthStore, AuthUserRecord } from "./store"
export {
  GENERIC_LOGIN_FAILURE,
  loginUser,
  logoutUser,
  resolveSession,
  SESSION_TTL_MS,
  signupUser,
  slugifyWorkspace,
  type AuthResult,
  type RequestMeta,
} from "./service"
export {
  buildSessionCookie,
  clearSessionCookie,
  parseSessionCookie,
  SESSION_COOKIE_NAME,
  type SessionCookieOptions,
} from "./cookies"
export { createMemoryAuthStore } from "./memory-store"
