export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  AUTH: 4,
  NOT_FOUND: 5,
  CANCELLED: 130
};

export class CliError extends Error {
  constructor(message, { exitCode = EXIT.ERROR, hint, details } = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.hint = hint;
    this.details = details;
  }
}

export class UsageError extends CliError {
  constructor(message, { hint, command } = {}) {
    super(message, { exitCode: EXIT.USAGE, hint });
    this.name = "UsageError";
    this.command = command;
  }
}

export class NotFoundError extends CliError {
  constructor(message, { hint, details } = {}) {
    super(message, { exitCode: EXIT.NOT_FOUND, hint, details });
    this.name = "NotFoundError";
  }
}

export class ApiError extends CliError {
  constructor(message, { status, code, details, body, method, url, hint } = {}) {
    const exitCode = status === 401 ? EXIT.AUTH : status === 404 ? EXIT.NOT_FOUND : EXIT.ERROR;
    super(message, { exitCode, hint, details });
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
    this.method = method;
    this.url = url;
  }
}

export class CancelledError extends CliError {
  constructor(message = "Cancelled.") {
    super(message, { exitCode: EXIT.CANCELLED });
    this.name = "CancelledError";
  }
}
