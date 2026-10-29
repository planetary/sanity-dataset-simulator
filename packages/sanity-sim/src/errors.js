/**
 * An error with the HTTP status and body Content Lake would answer.
 * `type` follows Content Lake's vocabulary where one exists
 * (`mutationError`, `queryParseError`, `validationError`, ...).
 */
export class SimError extends Error {
  constructor(status, type, description, extra = {}) {
    super(description)
    this.status = status
    this.type = type
    this.extra = extra
  }

  toBody() {
    return {error: {type: this.type, description: this.message, ...this.extra}}
  }
}

export const badRequest = (description, extra) => new SimError(400, 'validationError', description, extra)
export const notFound = (description) => new SimError(404, 'notFound', description)
export const conflict = (description, extra) => new SimError(409, 'mutationError', description, extra)
export const notImplemented = (what) =>
  new SimError(
    501,
    'notImplemented',
    `sanity-sim does not implement ${what}. It is a local Content Lake simulator; see the Connections page of the dashboard for what was requested.`,
  )
