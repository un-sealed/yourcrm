/**
 * Knowledge Base domain errors.
 *
 * Each carries a `code` the API layer maps to an HTTP status, exactly like
 * `PersonNotFoundError` in the reference module. Names are prefixed `Kb` so
 * the single `export *` barrel over every CRM module stays unambiguous.
 */

export class KbArticleNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`article ${id} not found`)
    this.name = "KbArticleNotFoundError"
  }
}

export class KbCategoryNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`category ${id} not found`)
    this.name = "KbCategoryNotFoundError"
  }
}

/** A write was rejected: a bad slug, an empty title/name, or a malformed patch. */
export class KbValidationError extends Error {
  readonly code = "VALIDATION_ERROR"
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "KbValidationError"
  }
}

/** Per-workspace slug uniqueness violated (article or category). */
export class KbConflictError extends Error {
  readonly code = "CONFLICT"
  constructor(message: string) {
    super(message)
    this.name = "KbConflictError"
  }
}
