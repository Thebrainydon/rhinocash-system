// router.js — a small, dependency-free router. Express isn't installable
// offline here, so this implements just enough of the same shape
// (app.get/post/patch/delete, req.params, req.body, res.json/.status) that
// the route files below read like ordinary Express routes.
'use strict';
const zlib = require('node:zlib');

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024; // 2MB — plenty for any form this app submits; uploads use their own separate binary path with a 5MB cap.
const GZIP_MIN_BYTES = 1024; // below this, gzip's own overhead isn't worth it

class Router {
  constructor() { this.routes = []; this.middlewares = []; }
  use(fn) { this.middlewares.push(fn); }
  _add(method, path, handlers) {
    const paramNames = [];
    const pattern = path.replace(/:[^/]+/g, (m) => { paramNames.push(m.slice(1)); return '([^/]+)'; });
    const regex = new RegExp(`^${pattern}$`);
    this.routes.push({ method, regex, paramNames, handlers });
  }
  get(path, ...h) { this._add('GET', path, h); }
  post(path, ...h) { this._add('POST', path, h); }
  patch(path, ...h) { this._add('PATCH', path, h); }
  put(path, ...h) { this._add('PUT', path, h); }
  delete(path, ...h) { this._add('DELETE', path, h); }

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    req.query = Object.fromEntries(url.searchParams.entries());
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (obj) => {
      const body = Buffer.from(JSON.stringify(obj));
      res.setHeader('Content-Type', 'application/json');
      // The bulk dashboard/loanbook endpoints return large JSON arrays that
      // compress extremely well; on a slow client connection this is the
      // single biggest lever over actual response latency. Gated on the
      // client advertising support and a minimum size so we don't spend
      // CPU compressing tiny responses.
      const acceptEncoding = req.headers['accept-encoding'] || '';
      if (body.length >= GZIP_MIN_BYTES && acceptEncoding.includes('gzip')) {
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.end(zlib.gzipSync(body));
      } else {
        res.end(body);
      }
    };

    // Only consume the request stream here for JSON-ish bodies. Routes like
    // /api/uploads intentionally read a raw binary stream themselves
    // (see server.js) — if we drained it here first for every POST/PATCH/PUT
    // regardless of content-type, those handlers would receive nothing.
    const contentType = req.headers['content-type'] || '';
    const looksLikeJson = contentType.includes('application/json') || contentType === '';
    if (['POST', 'PATCH', 'PUT'].includes(req.method) && looksLikeJson) {
      try {
        req.body = await new Promise((resolve, reject) => {
          let raw = ''; let size = 0;
          req.on('data', (c) => {
            size += c.length;
            if (size > MAX_JSON_BODY_BYTES) { reject(Object.assign(new Error('Request body too large'), { status: 413 })); req.destroy(); return; }
            raw += c;
          });
          req.on('end', () => {
            if (!raw) return resolve({});
            try { resolve(JSON.parse(raw)); } catch { resolve({}); }
          });
          req.on('error', reject);
        });
      } catch (e) {
        res.status(e.status || 400).json({ error: e.message || 'Invalid request body' });
        return;
      }
    } else {
      req.body = {};
    }

    // CORS preflight: browsers send OPTIONS before any cross-origin
    // GET/POST/etc. request and expect an answer straight from the CORS
    // middleware (registered via router.use in server.js) — never
    // route-matched (routes are only ever registered for the real HTTP
    // method, never OPTIONS) and never authenticated (route handlers, and
    // any requireAuth call inside them, are never part of this chain).
    // Previously this fell straight through to the 404 below, since no
    // route's method is ever "OPTIONS" — breaking every real preflight
    // from a browser. Run just the global middleware chain; the CORS
    // middleware itself ends the response (204 + CORS headers).
    if (req.method === 'OPTIONS') {
      let mIdx = 0;
      const mNext = async (err) => {
        if (err) { res.status(err.status || 500).json({ error: 'Server error' }); return; }
        const fn = this.middlewares[mIdx++];
        if (!fn) { if (!res.headersSent) res.status(204).end(); return; }
        try { await fn(req, res, mNext); } catch (e) { await mNext(e); }
      };
      await mNext();
      return;
    }

    const match = this.routes.find(r => r.method === req.method && r.regex.test(url.pathname));
    if (!match) { res.status(404).json({ error: 'Not found' }); return; }
    const m = url.pathname.match(match.regex);
    req.params = {};
    match.paramNames.forEach((name, i) => { req.params[name] = decodeURIComponent(m[i + 1]); });

    const chain = [...this.middlewares, ...match.handlers];
    let idx = 0;
    const next = async (err) => {
      if (err) {
        const status = err.status || 500;
        // 4xx codes come from our own code deliberately explaining what went
        // wrong (validation, auth, scope) — that message is meant to be
        // read by the caller. A bare 500 means something unexpected broke;
        // its message might be a raw DB/driver error, so it's logged
        // server-side only and the client gets a generic message instead —
        // instruction #27: never leak internals in the response.
        if (status >= 500) {
          console.error('[unhandled]', err);
          res.status(500).json({ error: 'Internal server error' });
        } else {
          res.status(status).json({ error: err.message || 'Request failed', code: err.code });
        }
        return;
      }
      const fn = chain[idx++];
      if (!fn) return; // handler already responded
      try { await fn(req, res, next); } catch (e) { next(e); }
    };
    await next();
  }
}

module.exports = { Router };
