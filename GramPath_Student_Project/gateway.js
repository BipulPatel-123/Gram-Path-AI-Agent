/**
 * GramPath AI secure Node gateway.
 * Cloudflare Tunnel (optional) -> Helmet + Express rate limits -> private Python SQLite service.
 * Security model: only this gateway can call the loopback Python API (ephemeral gateway token).
 */
import express from 'express';
import helmet from 'helmet';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const API_PORT = Number(process.env.INTERNAL_PYTHON_PORT || 8765);
const TUNNEL_ONLY = process.env.CLOUDFLARE_TUNNEL === 'true';
const ENABLE_ADMIN = process.env.ENABLE_ADMIN === 'true' || (!PROD && process.env.ENABLE_ADMIN !== 'false');
const ADMIN_KEY = process.env.GRAMPATH_ADMIN_KEY || (!PROD ? randomBytes(32).toString('hex') : '');
const GATEWAY_KEY = randomBytes(40).toString('hex');

if (PROD && ENABLE_ADMIN && (!ADMIN_KEY || ADMIN_KEY.length < 32)) {
  console.error('Production admin requires a strong GRAMPATH_ADMIN_KEY of at least 32 characters.');
  process.exit(1);
}
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535 || !Number.isInteger(API_PORT) || API_PORT < 1 || API_PORT > 65535) {
  throw new Error('Invalid port in configuration');
}
if (TUNNEL_ONLY && HOST !== '127.0.0.1' && HOST !== '::1') {
  throw new Error('In Cloudflare Tunnel mode, bind the gateway to 127.0.0.1 or ::1.');
}
if (PROD && HOST !== '127.0.0.1' && HOST !== '::1') {
  console.warn('WARNING: Public origin listening. Restrict direct-origin access using host firewall, Cloudflare Tunnel or authenticated origin pulls.');
}

// Windows can have a working py launcher even when python is missing from PATH.
const pythonCommands = process.env.PYTHON_BIN
  ? [process.env.PYTHON_BIN]
  : process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python'];
let pythonExecutable;
for (const command of pythonCommands) {
  const check = spawnSync(command, [
    '-c', 'import sqlite3, sys; assert sys.version_info >= (3, 10); print(sys.executable)',
  ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (check.status === 0 && check.stdout.trim()) {
    pythonExecutable = check.stdout.trim();
    break;
  }
}
if (!pythonExecutable) {
  console.error('GramPath needs Python 3.10+ with SQLite. Check your py or python command, or set PYTHON_BIN in .env.');
  process.exit(1);
}
const python = spawn(pythonExecutable, ['-u', 'server.py', '--port', String(API_PORT), '--no-browser'], {
  cwd: ROOT,
  env: { ...process.env, GRAMPATH_GATEWAY_TOKEN: GATEWAY_KEY, GRAMPATH_ADMIN_KEY: ADMIN_KEY, GRAMPATH_ENABLE_ADMIN: ENABLE_ADMIN ? 'true' : 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
python.stdout.on('data', data => process.stdout.write(`[backend] ${data}`));
python.stderr.on('data', data => process.stderr.write(`[backend] ${data}`));
python.on('error', error => console.error('Could not launch Python:', error.message));
python.on('exit', (code, signal) => console.error(`Python backend exited (${code ?? signal}). API requests will fail.`));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false); // NEVER trust arbitrary X-Forwarded-For provided by clients.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'blob:', 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: PROD ? [] : null,
    },
  },
  strictTransportSecurity: PROD ? { maxAge: 15552000, includeSubDomains: true } : false,
  referrerPolicy: { policy: 'no-referrer' },
}));

function clientIpKey(req) {
  // CF-Connecting-IP is trustworthy ONLY when an origin is reachable through
  // a local Cloudflare Tunnel, not from arbitrary internet clients.
  const remote = req.socket.remoteAddress || '';
  const isLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
  const cfIp = req.get('cf-connecting-ip') || '';
  const clientIp = TUNNEL_ONLY && isLoopback && isIP(cfIp) ? cfIp : (req.ip || remote);
  return ipKeyGenerator(clientIp, 56);
}
const limiter = (windowMs, limit) => rateLimit({
  windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: clientIpKey,
  message: { error: 'Too many requests. Please try again later.' },
});
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api', limiter(15 * 60_000, 180));
app.post('/api/eligibility', limiter(60_000, 20));
app.post('/api/feedback', limiter(60 * 60_000, 5));
app.use('/api/admin', limiter(15 * 60_000, 12));

function validAdminKey(candidate) {
  if (!ENABLE_ADMIN || !ADMIN_KEY || typeof candidate !== 'string') return false;
  const actual = Buffer.from(candidate);
  const expected = Buffer.from(ADMIN_KEY);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function originCheck(req, res, next) {
  if (req.method !== 'POST') return next();
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Cross-origin modifications blocked' });
    } catch { return res.status(403).json({ error: 'Invalid Origin' }); }
  }
  if (!req.is('application/json')) return res.status(415).json({ error: 'Content-Type must be application/json' });
  next();
}
app.use('/api', originCheck);
app.use('/api', express.json({ limit: '18kb', strict: true }));
app.use('/api', (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
  const path = req.originalUrl;
  if (path.startsWith('/api/admin/') && !validAdminKey(req.get('x-grampath-admin'))) {
    return res.status(403).json({ error: ENABLE_ADMIN ? 'Admin authorization required' : 'Admin API is disabled on public deployments' });
  }
  const rawBody = req.method === 'POST' ? JSON.stringify(req.body || {}) : '';
  const headers = {
    'x-grampath-gateway': GATEWAY_KEY,
    'accept': 'application/json',
    ...(rawBody ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(rawBody) } : {}),
    ...(path.startsWith('/api/admin/') ? { 'x-grampath-admin': ADMIN_KEY } : {}),
  };
  const inner = httpRequest({ hostname: '127.0.0.1', port: API_PORT, path, method: req.method, headers, timeout: 10000 }, response => {
    res.status(response.statusCode || 502);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'application/json; charset=utf-8');
    response.pipe(res);
  });
  inner.on('timeout', () => inner.destroy(new Error('Backend timeout')));
  inner.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'The eligibility service is unavailable. Check the Python messages in the VS Code terminal.' }); else res.end(); });
  if (rawBody) inner.write(rawBody);
  inner.end();
});

// Publicly served files are explicitly enumerated. sqlite3, .env, server.py and source secrets cannot be fetched.
app.get('/', (_req, res) => res.sendFile(join(ROOT, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(join(ROOT, 'index.html')));
app.get('/assets/style.css', (_req, res) => res.type('text/css').sendFile(join(ROOT, 'assets/style.css')));
app.get('/assets/app.js', (_req, res) => res.type('application/javascript').sendFile(join(ROOT, 'assets/app.js')));
app.use((_req, res) => res.status(404).send('Not found'));
app.use('/api', (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.too.large') return res.status(413).json({error: 'Request is too large.'});
  if (error.status >= 400 && error.status < 500) {
    return res.status(error.status).json({error: 'The request body could not be read.'});
  }
  return res.status(500).json({error: 'The server could not complete the request.'});
});

const server = app.listen(PORT, HOST, () => {
  console.log(`\nGramPath AI — Secure Dynamic Prototype\nOpen: http://${HOST === '::1' ? '[::1]' : HOST}:${server.address().port}`);
  console.log(`Node gateway: Helmet ✓  •  Rate limiting ✓  •  SQLite backend: localhost only ✓`);
  console.log(`Admin editor: ${ENABLE_ADMIN ? 'ON' : 'DISABLED'}  •  Cloudflare Tunnel mode: ${TUNNEL_ONLY ? 'ON' : 'OFF'}\n`);
  if (!PROD && ENABLE_ADMIN) console.log(`DEVELOPMENT ADMIN KEY (do not share): ${ADMIN_KEY}\n`);
  if (PROD && !TUNNEL_ONLY) console.warn('Production warning: configure Cloudflare WAF and restrict access to your origin.');
});
function shutdown() { try { python.kill(); } catch {} server.close(() => process.exit(0)); }
process.on('disconnect', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
