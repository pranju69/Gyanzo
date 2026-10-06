'use client';

/**
 * "AI-GENERATED SUMMARY" dialog for one PDF (opened from the PDF Library
 * eye button) — 1:1 with the design screenshot:
 *   · rose PDF icon + file name header
 *   · amber summary card with the AI study summary accumulated so far
 *   · "N of M pages summarised" progress + Stop button while running
 *   · raw page-by-page feed ("--- Page 1 ---") underneath
 *
 * The summary is streamed from GET /api/pdfs/<id>/summary (SSE) page by
 * page; every page is persisted server-side, so Stop keeps the progress
 * and Resume continues where it stopped.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileText,
  Loader2,
  Play,
  RotateCcw,
  Square,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/lib/i18n';
import type { Pdf } from '@/components/dashboard/pdf-utils';

type SummaryPage = { page: number; text: string };
type Status = 'loading' | 'running' | 'stopped' | 'done' | 'error';
type ErrorKind = 'server' | 'missing' | 'corrupt' | 'network' | 'rate_limited';

const NO_TEXT_SENTINEL = '[[NO_TEXT]]';
const PAGE_FAILED_SENTINEL = '[[PAGE_FAILED]]';

/** How many times a broken stream is silently resumed before we show the
    error card — progress is persisted server-side, so a resume continues. */
const MAX_AUTO_RESUMES = 2;

export default function PdfSummaryDialog({
  pdf,
  email,
  onOpenChange,
  onOpenOriginal,
}: {
  pdf: Pdf | null;
  email: string;
  /** Radix open state — closing always aborts an in-flight stream. */
  onOpenChange: (open: boolean) => void;
  /** Open the original PDF binary in a new tab. */
  onOpenOriginal: (p: Pdf) => void;
}) {
  const { t } = useLanguage();
  const d = t.dashboard;

  const [pages, setPages] = useState<SummaryPage[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<Status>('loading');
  const [errorKind, setErrorKind] = useState<ErrorKind>('server');

  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const autoResumesRef = useRef(0);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ── Stream lifecycle ───────────────────────────────────────── */
  const stopStream = useCallback(() => {
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const startStream = useCallback(async () => {
    if (!pdf) return;
    stopStream();

    const runId = ++runIdRef.current;
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setStatus('loading');
    try {
      const res = await fetch(
        `/api/pdfs/${pdf.id}/summary?email=${encodeURIComponent(email)}`,
        { signal: ctrl.signal }
      );
      if (!res.ok || !res.body) throw new Error('stream');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const handle = (evt: Record<string, unknown>) => {
        if (runId !== runIdRef.current) return;
        const type = evt.type;
        if (type === 'meta' && typeof evt.total === 'number') {
          setTotal(evt.total);
          setStatus('running');
        } else if (type === 'page') {
          const page = Number(evt.page);
          const text = String(evt.text ?? '');
          if (!Number.isFinite(page)) return;
          setPages((prev) => {
            const next = prev.filter((p) => p.page !== page);
            next.push({ page, text });
            next.sort((a, b) => a.page - b.page);
            return next;
          });
        } else if (type === 'end') {
          setStatus(evt.done ? 'done' : 'stopped');
          autoResumesRef.current = 0;
          runIdRef.current = ++runIdRef.current; // stream finished
        } else if (type === 'error') {
          const kind = String(evt.error ?? 'server') as ErrorKind;
          if (kind === 'server' && autoResumesRef.current < MAX_AUTO_RESUMES) {
            autoResumesRef.current += 1;
            resumeTimerRef.current = setTimeout(
              () => void startStream(),
              1200
            );
          } else {
            setErrorKind(kind);
            setStatus('error');
            runIdRef.current = ++runIdRef.current;
          }
        }
      };

      /* Read the SSE body incrementally. */
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = chunk
            .split('\n')
            .find((l) => l.startsWith('data: '));
          if (!line) continue;
          try {
            handle(JSON.parse(line.slice(6)) as Record<string, unknown>);
          } catch {
            /* skip malformed event */
          }
        }
      }

      /* Server closed without an end event (e.g. killed mid-run). */
      if (
        runId === runIdRef.current &&
        abortRef.current === ctrl &&
        !ctrl.signal.aborted
      ) {
        setStatus((s) => (s === 'running' || s === 'loading' ? 'stopped' : s));
      }
    } catch (error) {
      if (ctrl.signal.aborted) return; // Stop/close — expected
      console.warn('[pdf-summary-dialog] stream failed', error);
      if (runId !== runIdRef.current) return;
      /* Network hiccup — resume silently (progress is persisted
         server-side); only surface the error after several failures. */
      if (autoResumesRef.current < MAX_AUTO_RESUMES) {
        autoResumesRef.current += 1;
        resumeTimerRef.current = setTimeout(() => void startStream(), 1200);
      } else {
        setErrorKind('network');
        setStatus('error');
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }, [pdf, email, stopStream]);

  /* Start on open, abort on close/unmount. */
  useEffect(() => {
    if (pdf) {
      setPages([]);
      setTotal(0);
      setStatus('loading');
      setErrorKind('server');
      autoResumesRef.current = 0;
      void startStream();
    }
    return stopStream;
  }, [pdf?.id, startStream, stopStream]);

  /* ── Auto-scroll the raw feed while pages arrive ────────────── */
  const pagesDone = pages.length;
  useEffect(() => {
    if (status === 'running') {
      feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
    }
  }, [pagesDone, status]);

  const open = !!pdf;

  const stopNow = () => {
    stopStream();
    setStatus('stopped');
  };

  /* Manual Retry / Resume starts a fresh run with a clean retry budget. */
  const startFresh = () => {
    autoResumesRef.current = 0;
    void startStream();
  };

  const fileBroken = errorKind === 'missing' || errorKind === 'corrupt';
  const errorText =
    errorKind === 'missing'
      ? d.aiSummaryErrMissing
      : errorKind === 'corrupt'
        ? d.aiSummaryErrCorrupt
        : errorKind === 'rate_limited'
          ? d.aiSummaryErrRateLimited
          : d.aiSummaryErr;

  const pageDisplayText = (text: string) =>
    text === NO_TEXT_SENTINEL
      ? d.aiSummaryNoText
      : text === PAGE_FAILED_SENTINEL
        ? d.aiSummaryPageFailed
        : text;

  const cardText = pages.map((p) => pageDisplayText(p.text)).join('\n\n');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="font-brand max-h-[88vh] overflow-y-auto rounded-2xl p-5 sm:max-w-lg">
        {pdf && (
          <>
            <DialogHeader className="text-left">
              <div className="flex items-center gap-3 pr-6">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-rose-100 text-rose-500">
                  <FileText className="h-5 w-5" aria-hidden="true" />
                </span>
                <DialogTitle
                  className="min-w-0 truncate text-lg font-bold text-slate-900"
                  title={pdf.name}
                >
                  {pdf.name}
                </DialogTitle>
              </div>
              <DialogDescription className="sr-only">
                {d.aiSummaryLabel}
              </DialogDescription>
            </DialogHeader>

            {/* ── AI summary card ─────────────────────────────── */}
            <div className="mt-1 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-amber-700">
                {d.aiSummaryLabel}
              </p>
              <div className="mt-2.5 max-h-[36vh] overflow-y-auto">
                {pages.length === 0 && status === 'loading' ? (
                  <p className="flex items-center gap-2 py-2 text-sm text-slate-500">
                    <Loader2
                      className="h-4 w-4 shrink-0 animate-spin text-amber-600"
                      aria-hidden="true"
                    />
                    {d.aiSummaryPreparing}
                  </p>
                ) : pages.length === 0 && status === 'error' ? (
                  <div className="flex flex-col items-start gap-3 py-1 sm:flex-row sm:items-center">
                    <p className="text-sm text-rose-600">{errorText}</p>
                    {!fileBroken && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={startFresh}
                        className="h-8 shrink-0 gap-1.5 rounded-lg text-xs"
                      >
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        {d.aiSummaryRetry}
                      </Button>
                    )}
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-slate-700">
                    {cardText}
                  </p>
                )}
              </div>
            </div>

            {/* ── Progress + Stop / Resume ────────────────────── */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              {status === 'done' ? (
                <p className="text-xs text-slate-500">{d.aiSummaryDoneAll}</p>
              ) : total > 0 ? (
                <p className="text-xs text-slate-500" aria-live="polite">
                  {d.aiSummaryProgress(pagesDone, total)}
                </p>
              ) : (
                <span />
              )}

              {status === 'running' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={stopNow}
                  className="h-8 gap-1.5 rounded-lg border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <Square
                    className="h-3 w-3 fill-rose-500 text-rose-500"
                    aria-hidden="true"
                  />
                  {d.aiSummaryStop}
                </Button>
              )}
              {status === 'stopped' && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={startFresh}
                  className="h-8 gap-1.5 rounded-lg border-emerald-300 bg-white text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                >
                  <Play className="h-3 w-3" aria-hidden="true" />
                  {d.aiSummaryResume}
                </Button>
              )}
              {status === 'error' && !fileBroken && pages.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={startFresh}
                  className="h-8 gap-1.5 rounded-lg border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  {d.aiSummaryRetry}
                </Button>
              )}
            </div>

            {/* ── Raw page-by-page feed ───────────────────────── */}
            {pages.length > 0 && (
              <div
                ref={feedRef}
                className="mt-3 max-h-[30vh] overflow-y-auto rounded-lg font-mono text-xs leading-relaxed text-slate-600"
                aria-live="polite"
              >
                {pages.map((p) => (
                  <div key={p.page} className="whitespace-pre-wrap break-words py-1">
                    {'--- '}
                    {d.aiSummaryPage(p.page)}
                    {' ---\n'}
                    {pageDisplayText(p.text)}
                  </div>
                ))}
              </div>
            )}

            {/* ── Open the original file (hidden when it can't be served) */}
            {!fileBroken && (
              <button
                type="button"
                onClick={() => onOpenOriginal(pdf)}
                className="mt-4 inline-flex items-center gap-1 text-xs text-slate-400 underline-offset-2 transition hover:text-emerald-600 hover:underline"
              >
                <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                {d.aiSummaryOpenPdf}
              </button>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
