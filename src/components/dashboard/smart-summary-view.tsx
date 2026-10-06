'use client';

/**
 * Smart Summary section — 1:1 with the design screenshot: the "Smart
 * Summary" header with the subtitle, and a config card holding the
 * SUBJECT select, the documents select ("All documents"), the four
 * SUMMARY LENGTH pills (Short / Medium / Detailed / Bullet) and the
 * green "Generate Summary" button.
 *
 * Fully functional: POST /api/summaries generates a real AI summary —
 * the text of the subject's uploaded PDFs (or the one chosen document)
 * is extracted server-side and used as the primary source, falling back
 * to general knowledge when the subject has no readable documents. The
 * structured result (overview + sections + bullets) is persisted in
 * SQLite, shown in a result card (copy / delete), and every past summary
 * is listed under "Recent summaries" and survives reloads.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Copy,
  Files,
  FileText,
  Loader2,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/lib/i18n';
import { aiErrorTitle } from '@/lib/ai-error';
import { CHIP_STYLES, type Subject } from '@/components/dashboard/subject-styles';
import type { Pdf } from '@/components/dashboard/pdf-utils';
import { formatDate } from '@/components/dashboard/pdf-utils';

type SummarySection = { heading: string; bullets: string[] };

export type SummaryItem = {
  id: string;
  subjectId: string | null;
  subjectName: string;
  documentLabel: string;
  length: string;
  title: string;
  content: { overview: string; sections: SummarySection[] };
  createdAt: string;
};

type LengthId = 'short' | 'medium' | 'detailed' | 'bullet';

export default function SmartSummaryView({
  email,
  subjects,
  subjectsLoading,
  pdfs,
  onNewSubject,
}: {
  email: string;
  subjects: Subject[];
  subjectsLoading: boolean;
  pdfs: Pdf[];
  onNewSubject: () => void;
}) {
  const { toast } = useToast();
  const { t, lang } = useLanguage();
  const d = t.dashboard;

  /* ── State ──────────────────────────────────────────────────── */
  const [subjectId, setSubjectId] = useState('');
  const [documentId, setDocumentId] = useState('all');
  const [length, setLength] = useState<LengthId>('medium');
  const [generating, setGenerating] = useState(false);
  const [summaries, setSummaries] = useState<SummaryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [current, setCurrent] = useState<SummaryItem | null>(null);

  /* ── Derived ────────────────────────────────────────────────── */
  const subject = useMemo(
    () => subjects.find((s) => s.id === subjectId) ?? null,
    [subjects, subjectId]
  );
  const subjectDocs = useMemo(
    () =>
      subject
        ? pdfs.filter((p) => p.subjectName === subject.name)
        : [],
    [pdfs, subject]
  );
  /* The specific PDF chosen in the DOCUMENTS select (null = all) */
  const activeDoc = useMemo(
    () =>
      documentId !== 'all'
        ? (subjectDocs.find((p) => p.id === documentId) ?? null)
        : null,
    [subjectDocs, documentId]
  );

  /* ── Load the saved summaries once ──────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/summaries?email=${encodeURIComponent(email)}`)
      .then(async (res) => ({ res, data: await res.json().catch(() => null) }))
      .then(({ res, data }) => {
        if (cancelled) return;
        if (res.ok && data?.ok) {
          setSummaries(data.summaries as SummaryItem[]);
        } else {
          toast({ title: d.sumLoadFailed, variant: 'destructive' });
        }
      })
      .catch(() => {
        if (!cancelled) {
          toast({ title: d.sumLoadFailed, variant: 'destructive' });
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [email, d.sumLoadFailed, toast]);

  /* ── Default the subject to the first one once subjects land ── */
  useEffect(() => {
    if (!subjectsLoading && subjects.length > 0) {
      setSubjectId((prev) =>
        prev && subjects.some((s) => s.id === prev) ? prev : subjects[0].id
      );
    }
  }, [subjectsLoading, subjects]);

  const pickSubject = (value: string) => {
    setSubjectId(value);
    setDocumentId('all');
  };

  /* ── Generate ───────────────────────────────────────────────── */
  const generate = async () => {
    if (!subject || generating) return;
    setGenerating(true);
    try {
      const res = await fetch('/api/summaries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          subjectId: subject.id,
          documentId,
          length,
          lang,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        const summary = data.summary as SummaryItem;
        setCurrent(summary);
        setSummaries((prev) => [summary, ...prev]);
      } else {
        toast({
          title: aiErrorTitle(data, d.sumGenerateFailed, d.aiNotConfigured),
          variant: 'destructive',
        });
      }
    } catch {
      toast({ title: d.sumGenerateFailed, variant: 'destructive' });
    } finally {
      setGenerating(false);
    }
  };

  /* ── Copy the displayed summary as plain text ───────────────── */
  const copyCurrent = async () => {
    if (!current) return;
    const plain = [
      current.title,
      current.content.overview,
      ...current.content.sections.flatMap((s) =>
        [s.heading, ...s.bullets.map((b) => `\u2022 ${b}`)].filter(Boolean)
      ),
    ]
      .filter(Boolean)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(plain);
      toast({ title: d.sumCopied });
    } catch {
      toast({ title: d.sumCopied });
    }
  };

  /* ── Delete a saved summary ─────────────────────────────────── */
  const deleteSummary = async (id: string) => {
    const snapshot = summaries;
    setSummaries((prev) => prev.filter((s) => s.id !== id));
    if (current?.id === id) setCurrent(null);
    try {
      const res = await fetch(
        `/api/summaries?email=${encodeURIComponent(email)}&id=${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error('failed');
      toast({ title: d.sumDeleted });
    } catch {
      setSummaries(snapshot); // restore on failure
      toast({ title: d.sumLoadFailed, variant: 'destructive' });
    }
  };

  const lengthLabel = (id: string): string => {
    const map: Record<string, string> = {
      short: d.sumShort,
      medium: d.sumMedium,
      detailed: d.sumDetailed,
      bullet: d.sumBullet,
    };
    return map[id] ?? id;
  };

  const lengthOptions: { id: LengthId; label: string }[] = [
    { id: 'short', label: d.sumShort },
    { id: 'medium', label: d.sumMedium },
    { id: 'detailed', label: d.sumDetailed },
    { id: 'bullet', label: d.sumBullet },
  ];

  /* ── Result card ────────────────────────────────────────────── */
  const ResultCard = current ? (
    <section
      aria-live="polite"
      className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="flex items-start gap-3.5 border-b border-slate-100 p-5 sm:p-6">
        <span
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${CHIP_STYLES['emerald']}`}
        >
          <FileText className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-snug text-slate-900">
            {current.title}
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-400">
            <span className="truncate">{current.subjectName}</span>
            <span aria-hidden="true">·</span>
            <span>{lengthLabel(current.length)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatDate(current.createdAt)}</span>
            {current.documentLabel !== 'All documents' && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{current.documentLabel}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void copyCurrent()}
            className="h-8 gap-1.5 rounded-lg text-xs"
          >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            {d.sumCopy}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void deleteSummary(current.id)}
            aria-label={d.sumDelete}
            className="h-8 w-8 rounded-lg p-0 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="p-5 sm:p-6">
        {current.content.overview && (
          <p className="text-sm leading-relaxed text-slate-600">
            {current.content.overview}
          </p>
        )}
        <div
          className={`space-y-5 ${current.content.overview ? 'mt-5' : ''}`}
        >
          {current.content.sections.map((sec, i) => (
            <div key={i}>
              {sec.heading && (
                <h3 className="text-sm font-semibold text-slate-800">
                  {sec.heading}
                </h3>
              )}
              <ul className={`space-y-1.5 ${sec.heading ? 'mt-2' : ''}`}>
                {sec.bullets.map((b, j) => (
                  <li
                    key={j}
                    className="flex items-start gap-2 text-sm leading-relaxed text-slate-600"
                  >
                    <span
                      className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                      aria-hidden="true"
                    />
                    <span className="min-w-0">{b}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-6 border-t border-slate-100 pt-3 text-xs text-slate-400">
          {d.sumGeneratedBy}
        </p>
      </div>
    </section>
  ) : null;

  /* ── Page ───────────────────────────────────────────────────── */
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      {/* Header */}
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
        {d.sumTitle}
      </h1>
      <p className="mt-1.5 text-sm text-slate-500">{d.sumSubtitle}</p>

      {subjectsLoading ? (
        <div className="mt-6 flex items-center justify-center rounded-2xl border border-slate-200 bg-white py-14 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : subjects.length === 0 ? (
        /* Empty state — no subject to summarize yet */
        <div className="mt-6 flex flex-col items-center rounded-2xl border-2 border-dashed border-slate-300 px-6 py-14 text-center sm:py-16">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
            <Files className="h-7 w-7" aria-hidden="true" />
          </span>
          <h2 className="mt-5 text-base font-semibold text-slate-800">
            {d.sumEmptyTitle}
          </h2>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">
            {d.sumEmptyDesc}
          </p>
          <Button
            onClick={onNewSubject}
            className="mt-6 h-9 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700"
          >
            {d.createSubject}
          </Button>
        </div>
      ) : (
        <>
          {/* Config card — 1:1 with the screenshot */}
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label
                  htmlFor="sum-subject"
                  className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500"
                >
                  {d.sumSubjectLabel}
                </Label>
                <Select
                  value={subjectId}
                  onValueChange={pickSubject}
                  disabled={generating}
                >
                  <SelectTrigger
                    id="sum-subject"
                    aria-label={d.sumSubjectLabel}
                    className="h-10 w-full rounded-lg border-slate-200 text-sm text-slate-700"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-64 rounded-xl border-slate-200">
                    {subjects.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                {/* Visible label keeps the PDF select on the same baseline
                    as the Subject select — opposite, never floating above */}
                <Label
                  htmlFor="sum-document"
                  className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500"
                >
                  {d.sumDocumentsLabel}
                </Label>
                <Select
                  value={documentId}
                  onValueChange={setDocumentId}
                  disabled={generating}
                >
                  <SelectTrigger
                    id="sum-document"
                    aria-label={d.sumDocumentsLabel}
                    className="h-10 w-full rounded-lg border-slate-200 text-sm text-slate-700"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-64 rounded-xl border-slate-200">
                    <SelectItem value="all">{d.sumAllDocuments}</SelectItem>
                    {subjectDocs.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="mt-5 space-y-1.5">
              <Label className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">
                {d.sumLengthLabel}
              </Label>
              <div
                role="group"
                aria-label={d.sumLengthLabel}
                className="flex flex-wrap gap-2 pt-0.5"
              >
                {lengthOptions.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => setLength(o.id)}
                    aria-pressed={length === o.id}
                    disabled={generating}
                    className={`h-9 rounded-full border px-4 text-sm font-medium transition disabled:cursor-not-allowed ${
                      length === o.id
                        ? 'border-emerald-600 bg-emerald-600 text-white shadow-sm'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300 hover:text-emerald-700'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <Button
              onClick={() => void generate()}
              disabled={generating}
              className="mt-5 h-10 gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-70"
            >
              {generating ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="h-4 w-4" aria-hidden="true" />
              )}
              {generating ? d.sumGenerating : d.sumGenerate}
            </Button>

            {/* Document-context status line */}
            {subject && (
              <p
                className={`mt-4 flex items-center gap-1.5 text-sm ${
                  subjectDocs.length > 0
                    ? 'text-emerald-700'
                    : 'text-orange-600'
                }`}
              >
                {subjectDocs.length > 0 ? (
                  <>
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                      aria-hidden="true"
                    />
                    {activeDoc
                      ? d.sumContextDoc(activeDoc.name)
                      : d.sumContextLine(subject.name, subjectDocs.length)}
                  </>
                ) : (
                  <>
                    <TriangleAlert
                      className="h-4 w-4 shrink-0 text-orange-500"
                      aria-hidden="true"
                    />
                    {d.sumNoPdfsHint(subject.name)}
                  </>
                )}
              </p>
            )}
          </section>

          {/* Generating placeholder */}
          {generating && (
            <section
              aria-live="polite"
              className="mt-6 flex items-center gap-3.5 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-6"
            >
              <Loader2
                className="h-5 w-5 shrink-0 animate-spin text-emerald-600"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-700">
                  {d.sumGeneratingTitle}
                </p>
                <p className="mt-0.5 text-sm text-slate-500">
                  {d.sumGeneratingDesc}
                </p>
              </div>
            </section>
          )}

          {/* Result */}
          {!generating && ResultCard}

          {/* Recent summaries */}
          {summaries.length > 0 && (
            <section className="mt-8 pb-10" aria-label={d.sumHistory}>
              <h2 className="text-base font-semibold text-slate-800">
                {d.sumHistory}
              </h2>
              <ul className="mt-3 space-y-2.5">
                {summaries.map((s) => (
                  <li
                    key={s.id}
                    className={`flex items-center gap-2 rounded-xl border bg-white px-4 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition ${
                      current?.id === s.id
                        ? 'border-emerald-300'
                        : 'border-slate-200 hover:border-emerald-200'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setCurrent(s);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${CHIP_STYLES['emerald']}`}
                      >
                        <FileText className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-slate-800">
                          {s.title}
                        </span>
                        <span className="block truncate text-xs text-slate-400">
                          {s.subjectName} · {lengthLabel(s.length)} ·{' '}
                          {formatDate(s.createdAt)}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteSummary(s.id)}
                      aria-label={d.sumDelete}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
