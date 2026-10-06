'use client';

/**
 * useNotifications — real-time dashboard bell state.
 *
 * Data flow:
 *   1. Initial load: GET /api/notifications (persisted rows + unreadCount).
 *   2. Real-time: a socket.io connection (via the Caddy gateway) joins the
 *      user's room on the notification mini-service; every feature route
 *      that creates a notification fans it out there — so ALL tabs and
 *      devices of the user update instantly, no reload needed.
 *   3. Resilience: refresh on window focus + a slow 90 s poll as a socket
 *      fallback (kept subtle so real-time remains the primary path).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

export type NotificationItem = {
  id: string;
  type: string;
  params: Record<string, string | number>;
  title: string;
  body: string;
  actionNav: string;
  readAt: string | null;
  createdAt: string;
};

const SOCKET_PORT = 3004; // notification-service public socket port
const LIST_CAP = 30; // matches the API's LIST_LIMIT
const FOCUS_REFRESH_MS = 1500; // debounce for focus refreshes
const POLL_MS = 90_000; // safety net when the socket is down

export function useNotifications(email: string | null) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  /* ── Refresh the full list from the API ─────────────────────── */
  const refresh = useCallback(async () => {
    if (!email) return;
    try {
      const res = await fetch(
        `/api/notifications?email=${encodeURIComponent(email)}`
      );
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setItems(data.notifications as NotificationItem[]);
        setUnreadCount(Number(data.unreadCount) || 0);
      }
    } catch {
      /* offline — keep current state */
    } finally {
      setLoaded(true);
    }
  }, [email]);

  /* ── Initial load ───────────────────────────────────────────── */
  useEffect(() => {
    if (!email) {
      setItems([]);
      setUnreadCount(0);
      setLoaded(false);
      return;
    }
    setLoaded(false);
    void refresh();
  }, [email, refresh]);

  /* ── Real-time socket (per-email singleton connection) ──────── */
  useEffect(() => {
    if (!email || typeof window === 'undefined') return;
    // Serverless deploys (e.g. Vercel) have no long-lived socket service —
    // the focus/interval polling below keeps the bell fresh there.
    if (process.env.NEXT_PUBLIC_DISABLE_SOCKET === '1') return;

    // Never use the port in the URL — always XTransformPort (Caddy gateway).
    // The path MUST stay '/' for the same reason.
    const socket = io(`/?XTransformPort=${SOCKET_PORT}`, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      timeout: 10000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('join', { email });
    });
    socket.on('disconnect', () => setConnected(false));

    socket.on('joined', () => {
      /* Room ack — sync once in case an event fired before we joined. */
      void refresh();
    });

    socket.on('notification', (payload: NotificationItem) => {
      if (!payload?.id) return;
      setItems((prev) => {
        if (prev.some((n) => n.id === payload.id)) return prev;
        return [payload, ...prev].slice(0, LIST_CAP);
      });
      setUnreadCount((c) => (payload.readAt ? c : c + 1));
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [email, refresh]);

  /* ── Resilience: refresh on focus + slow poll fallback ──────── */
  useEffect(() => {
    if (!email) return;
    let last = 0;
    const onFocus = () => {
      const now = Date.now();
      if (now - last < FOCUS_REFRESH_MS) return;
      last = now;
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => {
      if (!socketRef.current?.connected) void refresh();
    }, POLL_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [email, refresh]);

  /* ── Actions (optimistic, API-backed) ───────────────────────── */
  const markAllRead = useCallback(async () => {
    if (!email) return;
    setItems((prev) =>
      prev.map((n) =>
        n.readAt ? n : { ...n, readAt: new Date().toISOString() }
      )
    );
    setUnreadCount(0);
    try {
      await fetch('/api/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, all: true }),
      });
    } catch {
      /* keep optimistic state */
    }
  }, [email]);

  const markRead = useCallback(
    async (id: string) => {
      if (!email || !id) return;
      setItems((prev) =>
        prev.map((n) =>
          n.id === id && !n.readAt
            ? { ...n, readAt: new Date().toISOString() }
            : n
        )
      );
      setUnreadCount((c) => Math.max(0, c - 1));
      try {
        await fetch('/api/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, id }),
        });
      } catch {
        /* keep optimistic state */
      }
    },
    [email]
  );

  const clearAll = useCallback(async () => {
    if (!email) return;
    setItems([]);
    setUnreadCount(0);
    try {
      await fetch(
        `/api/notifications?email=${encodeURIComponent(email)}`,
        { method: 'DELETE' }
      );
    } catch {
      /* keep optimistic state */
    }
  }, [email]);

  const remove = useCallback(
    async (id: string) => {
      if (!email || !id) return;
      const snapshot = items;
      const target = items.find((n) => n.id === id);
      setItems((prev) => prev.filter((n) => n.id !== id));
      if (target && !target.readAt) {
        setUnreadCount((c) => Math.max(0, c - 1));
      }
      try {
        const res = await fetch(
          `/api/notifications?email=${encodeURIComponent(email)}&id=${encodeURIComponent(id)}`,
          { method: 'DELETE' }
        );
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) throw new Error('failed');
      } catch {
        setItems(snapshot); // restore on failure
        if (target && !target.readAt) setUnreadCount((c) => c + 1);
      }
    },
    [email, items]
  );

  return {
    items,
    unreadCount,
    connected,
    loaded,
    refresh,
    markAllRead,
    markRead,
    clearAll,
    remove,
  };
}
