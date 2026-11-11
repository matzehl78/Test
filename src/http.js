// Minimal HTTP toolkit: router, JSON bodies, cookies, typed errors.

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const bad = (msg, details) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Login required') => new HttpError(401, msg);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);

export class Router {
  #routes = [];

  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '/?$',
    );
    this.#routes.push({ method, re, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  match(method, path) {
    let pathMatched = false;
    for (const r of this.#routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

const MAX_BODY = 64 * 1024;

export async function readJson(req) {
  const type = req.headers['content-type'] || '';
  // Requiring application/json forces a CORS preflight for cross-site
  // requests, which (with SameSite=Lax cookies) is our CSRF defence.
  if (!type.startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw bad('Invalid JSON body');
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name, value, { maxAge, secure } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  if (secure) c += '; Secure';
  return c;
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

// ---- validation helpers ---------------------------------------------------

export function str(v, field, { min = 1, max = 200, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return '';
    throw bad(`${field} is required`);
  }
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  const s = v.trim();
  if (s.length < min) throw bad(`${field} must be at least ${min} characters`);
  if (s.length > max) throw bad(`${field} must be at most ${max} characters`);
  return s;
}

export function int(v, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw bad(`${field} must be a positive integer`);
  return n;
}
