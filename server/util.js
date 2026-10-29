'use strict';

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

// Wrapper for async handlers: any rejection goes to the error middleware.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The body is always treated as a plain object and never trusted.
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

function readCookie(req, name) {
  const h = req.headers.cookie;
  if (!h || h.length > 4096) return null;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

module.exports = { HttpError, ah, bodyOf, readCookie };
