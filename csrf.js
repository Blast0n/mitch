const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function makeCsrfMiddleware({ expectedOrigin }) {
  return function csrfMw(req, res, next) {
    if (!MUTATING.has(req.method)) return next();
    const origin = req.headers.origin;
    if (origin) {
      if (origin === expectedOrigin) return next();
      return res.status(403).json({ error: 'csrf_origin_mismatch' });
    }
    const referer = req.headers.referer;
    if (referer && referer.startsWith(expectedOrigin + '/')) return next();
    if (referer === expectedOrigin) return next();
    return res.status(403).json({ error: 'csrf_no_origin' });
  };
}
