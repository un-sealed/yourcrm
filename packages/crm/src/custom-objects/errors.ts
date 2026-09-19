/**
 * Custom-objects domain errors.
 *
 * Each carries a `code` the API layer maps to an HTTP status, exactly like
 * `PersonNotFoundError` in the reference module. Names are prefixed so the
 * single `export *` barrel over every CRM module stays unambiguous.
 */

export class CustomObjectNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(slugOrId: string) {
    super(`custom object ${slugOrId} not found`)
    this.name = "CustomObjectNotFoundError"
  }
}

export class CustomObjectFieldNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`custom field ${id} not found`)
    this.name = "CustomObjectFieldNotFoundError"
  }
}

export class CustomObjectRecordNotFoundError extends Error {
  readonly code = "NOT_FOUND"
  constructor(id: string) {
    super(`custom object record ${id} not found`)
    this.name = "CustomObjectRecordNotFoundError"
  }
}

/**
 * A write was rejected by the metadata engine: a bad slug or field key, a
 * payload that does not satisfy the live field definitions, or a definition
 * the engine refuses to build a schema from (fail closed).
 */
export class CustomObjectValidationError extends Error {
  readonly code = "VALIDATION_ERROR"
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "CustomObjectValidationError"
  }
}

/** Per-workspace uniqueness violated (object slug or field key). */
export class CustomObjectConflictError extends Error {
  readonly code = "CONFLICT"
  constructor(message: string) {
    super(message)
    this.name = "CustomObjectConflictError"
  }
}
