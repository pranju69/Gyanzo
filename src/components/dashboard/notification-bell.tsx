'use client';

/**
 * NotificationBell — the dashboard header bell, fully real-time.
 *
 * - Live push: socket.io room per user (notification mini-service), so any
 *   event from any tab/device pops into this dropdown with no reload.
 * - Persisted: unread state survives reloads (SQLite via /api/notifications).
 * - Actions: click → mark read + navigate to the related section;
 *   mark-all-read; per-item delete; clear all. The badge respects the
 *   Settings → Notifications preference (badgeEnabled).
 */

import {
  Bell,
  BookOpen,
  CheckCheck,
  FileText,
  FolderPlus,
  Layers,
  Loader2,
  NotebookText,
  Target,
  Trash2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLanguage } from '@/lib/i18n';
import {
  useNotifications,
  type NotificationItem,
} from '@/lib/use-notifications';

const TYPE_STYLES: Record<
  string,
  { icon: typeof FileText; chip: string }
> = {
  subject: {
    icon: FolderPlus,
    chip: 'bg-emerald-50 text-emerald-600',
  },
  pdf: { icon: FileText, chip: 'bg-violet-50 text-violet-600' },
  summary: { icon: BookOpen, chip: 'bg-teal-50 text-teal-600' },
  note: { icon: NotebookText, chip: 'bg-emerald-50 text-emerald-600' },
  flashcards: { icon: Layers, chip: 'bg-orange-50 text-orange-600' },
  quiz: { icon: Target, chip: 'bg-amber-50 text-amber-600' },
};

export default function NotificationBell({
  email,
  badgeEnabled,
  quizReminder,
  onNavigate,
}: {
  email: string;
  /** Settings → Notifications preference — gates the unread badge. */
  badgeEnabled: boolean;
  /** Optional Settings-driven quiz reminder rendered above the list. */
  quizReminder?: React.ReactNode;
  onNavigate: (navId: string) => void;
}) {
  const { t } = useLanguage();
  const d = t.dashboard;
  const {
    items,
    unreadCount,
    loaded,
    markAllRead,
    markRead,
    clearAll,
    remove,
  } = useNotifications(email);

  /* Localized title/description per type (English fallback from the row). */
  const describe = (n: NotificationItem): { title: string; body: string } => {
    const p = n.params ?? {};
    const str = (v: string | number | undefined, fb = '') =>
      typeof v === 'string' || typeof v === 'number' ? String(v) : fb;
    const num = (v: string | number | undefined, fb = 0) =>
      typeof v === 'number' ? v : Number(v) || fb;
    switch (n.type) {
      case 'subject':
        return { title: d.notifSubjectTitle(str(p.name)), body: d.notifSubjectDesc };
      case 'pdf':
        return {
          title: d.notifPdfTitle(str(p.name)),
          body: d.notifPdfDesc(str(p.subject) || d.fallbackLibrary, num(p.pages)),
        };
      case 'summary':
        return {
          title: d.notifSummaryTitle,
          body: d.notifSummaryDesc(str(p.subject) || d.fallbackLibrary),
        };
      case 'note':
        return {
          title: d.notifNoteTitle,
          body: d.notifNoteDesc(str(p.subject) || d.fallbackLibrary),
        };
      case 'flashcards':
        return {
          title: d.notifFcTitle,
          body: d.notifFcDesc(num(p.count), str(p.subject)),
        };
      case 'quiz':
        return {
          title: d.notifQuizTitle,
          body: d.notifQuizDesc(num(p.score), str(p.subject)),
        };
      default:
        return { title: n.title, body: n.body };
    }
  };

  /* Relative time (localized). */
  const relTime = (iso: string): string => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return d.notifJustNow;
    if (mins < 60) return d.notifMinsAgo(mins);
    const hours = Math.floor(mins / 60);
    if (hours < 24) return d.notifHoursAgo(hours);
    return d.notifDaysAgo(Math.floor(hours / 24));
  };

  const badge = unreadCount > 0 && badgeEnabled;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        aria-label={`${d.a11yNotifications}${unreadCount > 0 ? ` (${d.notifNewCount(unreadCount)})` : ''}`}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 transition hover:bg-slate-100 outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
      >
        <Bell className="h-[18px] w-[18px]" aria-hidden="true" />
        {badge && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-orange-500 px-1 text-[10px] font-semibold leading-none text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className="z-[80] w-[22rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border-slate-200 bg-white p-0 text-slate-700"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3.5 py-2.5">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            {d.a11yNotifications}
            {unreadCount > 0 && (
              <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-emerald-700">
                {d.notifNewCount(unreadCount)}
              </span>
            )}
          </p>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={() => void markAllRead()}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-slate-500 transition hover:bg-emerald-50 hover:text-emerald-700"
            >
              <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {d.notifMarkAllRead}
            </button>
          )}
        </div>

        {/* List (scrollable, thin scrollbar) */}
        <div className="scrollbar-thin max-h-96 overflow-y-auto p-1.5">
          {!loaded ? (
            <div className="flex items-center justify-center py-10 text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            </div>
          ) : items.length === 0 && !quizReminder ? (
            <div className="flex flex-col items-center px-4 py-10 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                <Bell className="h-4.5 w-4.5" aria-hidden="true" />
              </span>
              <p className="mt-3 text-xs text-slate-400">{d.notifEmpty}</p>
            </div>
          ) : (
            <>
              {quizReminder}
              {items.map((n) => {
                const style = TYPE_STYLES[n.type] ?? TYPE_STYLES.pdf;
                const Icon = style.icon;
                const text = describe(n);
                const unread = !n.readAt;
                return (
                  <div
                    key={n.id}
                    className={`group relative flex items-start gap-2.5 rounded-lg ${
                      unread ? 'bg-emerald-50/50' : ''
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        void markRead(n.id);
                        if (n.actionNav) onNavigate(n.actionNav);
                      }}
                      className="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 rounded-lg p-2.5 text-left transition data-[x]:bg-transparent hover:bg-emerald-50/70"
                    >
                      <span
                        className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${style.chip}`}
                      >
                        <Icon className="h-4 w-4" aria-hidden="true" />
                        {unread && (
                          <span
                            className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-white"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="block pr-12 text-sm font-medium leading-snug text-slate-800">
                          {text.title}
                        </span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-slate-500">
                          {text.body}
                        </span>
                        <span className="mt-1 block text-[10px] font-medium uppercase tracking-wide text-slate-400">
                          {relTime(n.createdAt)}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove(n.id);
                      }}
                      aria-label={d.notifDeleteItem}
                      className="absolute right-2 top-2.5 flex h-6 w-6 items-center justify-center rounded-md text-slate-300 opacity-0 transition hover:bg-rose-50 hover:text-rose-500 focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* Footer — clear all */}
        {loaded && items.length > 0 && (
          <div className="border-t border-slate-100 p-1.5">
            <DropdownMenuItem
              className="cursor-pointer justify-center gap-1.5 rounded-lg py-2 text-xs font-medium text-slate-500 data-[highlighted]:bg-rose-50 data-[highlighted]:text-rose-600"
              onClick={() => void clearAll()}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              {d.notifClearAll}
            </DropdownMenuItem>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
