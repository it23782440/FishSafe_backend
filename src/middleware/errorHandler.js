/* 404 handler for unknown routes. */
function notFound(req, res, next) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
}

/* Map well-known errors to proper client-error status codes. */
function statusFor(err) {
  if (err.statusCode) return err.statusCode;
  if (err.code === 11000) return 409; // duplicate key
  if (err.type === 'entity.parse.failed') return 400; // malformed JSON body
  if (err.type === 'entity.too.large') return 413;
  if (err.name === 'CastError' || err.name === 'ValidationError') return 400;
  return 500;
}

/* Central error handler. Any thrown/next(err) lands here. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = statusFor(err);
  if (status >= 500) console.error('[ERROR]', err);
  else console.warn('[WARN]', status, err.message);

  res.status(status).json({
    error: status >= 500 && process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    ...(status < 500 && err.field ? { field: err.field } : {}), // which form input is invalid (feasibility form)
    ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {}),
  });
}

module.exports = { notFound, errorHandler };
