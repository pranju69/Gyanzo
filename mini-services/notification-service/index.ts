/**
 * Notification real-time service — Gyanzo dashboard bell.
 *
 * Two listeners in one process:
 *   - PORT 3004: socket.io on path '/' (public via the Caddy gateway —
 *     clients connect with io('/?XTransformPort=3004')). Path MUST stay '/'.
 *     NOTE: with path '/', engine.io intercepts every HTTP request on this
 *     port, which is why the emit endpoint lives on a second port.
 *   - PORT 3005: plain HTTP "emit" endpoint — INTERNAL ONLY (localhost).
 *     The Next.js API routes POST here when something happens for a user.
 *
 * Client contract (see src/lib/use-notifications.ts):
 *   io('/?XTransformPort=3004', { path: '/' })
 *   socket.emit('join', { email })          → server joins room user:<email>
 *   socket.on('notification', (n) => ...)   → one pushed notification
 *   socket.on('joined', ({ email }) => ...) → room ack (debug)
 */
import { createServer } from 'http';
import { Server } from 'socket.io';

const PORT = 3004; // public socket port (via gateway XTransformPort)
const EMIT_PORT = 3005; // internal localhost-only emit endpoint

/* ── Public socket server ──────────────────────────────────────────── */
const httpServer = createServer();
const io = new Server(httpServer, {
  // DO NOT change the path — Caddy forwards /?XTransformPort=3004 here.
  path: '/',
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

io.on('connection', (socket) => {
  socket.on('join', (data: { email?: unknown }) => {
    if (typeof data?.email !== 'string' || !data.email) return;
    const email = data.email.trim().toLowerCase();
    void socket.join(`user:${email}`);
    socket.emit('joined', { email, at: new Date().toISOString() });
    console.log(`[join] ${email} socket=${socket.id}`);
  });

  socket.on('error', (error) => {
    console.error(`[socket-error] ${socket.id}:`, error);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Notification socket service on :${PORT} (emit on :${EMIT_PORT})`);
});

/* ── Internal emit server (localhost only) ─────────────────────────── */
createServer((req, res) => {
  if (req.method === 'POST' && (req.url ?? '').startsWith('/emit')) {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy(); // sanity cap
    });
    req.on('end', () => {
      try {
        const { email, notification } = JSON.parse(raw) as {
          email?: unknown;
          notification?: unknown;
        };
        if (typeof email !== 'string' || !email || !notification) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid' }));
          return;
        }
        const room = `user:${email.toLowerCase()}`;
        const delivered = io.sockets.adapter.rooms.get(room)?.size ?? 0;
        io.to(room).emit('notification', notification);
        console.log(
          `[emit] ${email} type=${(notification as { type?: string }).type ?? '?'} sockets=${delivered}`
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sockets: delivered }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'badjson' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && (req.url ?? '').startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'notification',
        sockets: io.sockets.sockets.size,
      })
    );
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'notfound' }));
}).listen(EMIT_PORT, '127.0.0.1', () => {
  console.log(`Notification emit endpoint on 127.0.0.1:${EMIT_PORT}`);
});

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0));
});
