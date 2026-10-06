'use client';

/**
 * Revision Notes section — 1:1 with the design screenshot: the
 * "Revision Notes" header with the subtitle, and a config card holding
 * the SUBJECT select, the documents select ("All documents"), the three
 * MODE cards (One-page Notes / Key Concepts / Important Questions) and
 * the green "Generate Revision Notes" button.
 *
 * Fully functional: POST /api/revision-notes generates a real AI note —
 * the text of the subject's uploaded PDFs (or the one chosen document)
 * is extracted server-side and used as the primary source, falling back
 * to general knowledge when the subject has no readable documents. The
 * structured result (overview + sections + points, with model answers
 * for the questions mode) is persisted in SQLite, shown in a result card
 * (copy / delete), and every past note is listed under "Recent revision
 * notes" and survives reloads.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  BookOpen,
  Copy,
  FileCheck2,
  FileText,
  HelpCircle,
  Loader2,
  NotebookText,
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

type NotePoint = { text: string; detail: string };
type NoteSection = { heading: string; points: NotePoint[] };

export type RevisionNoteItem = {
  id: string;
  subjectId: string | null;
  subjectName: string;
  documentLabel: string;
  mode: string;
  title: string;
  content: { overview: string; sections: NoteSection[] };
  createdAt: string;
};

/** Meta subset the dashboard activity feed needs. */
export type RevisionNoteMeta = Pick<
  RevisionNoteItem,
  'id' | 'subjectName' | 'createdAt'
>;

type ModeId = 'one-page' | 'key-concepts' | 'important-questions';

export default function RevisionNotesView({
  email,
  subjects,
  subjectsLoading,
  pdfs,
  onNewSubject,
  onNotesChanged,
}: {
  email: string;
  subjects: Subject[];
  subjectsLoading: boolean;
  pdfs: Pdf[];
  onNewSubject: () => void;
  onNotesChanged?: (notes: RevisionNoteMeta[]) => void;
}) {
  const { toast } = useToast();
  const { t, lang } = useLanguage();
  const d = t.dashboard;

  /* ── State ──────────────────────────────────────────────────── */
  const [subjectId, setSubjectId] = useState('');
  const [documentId, setDocumentId] = useState('all');
  const [mode, setMode] = useState<ModeId>('one-page');
  const [generating, setGenerating] = useState(false);
  const [notes, setNotes] = useState<RevisionNoteItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [current, setCurrent] = useState<RevisionNoteItem | null>(null);

  /* Where the last generated note came from (source transparency) */
  const [source, setSource] = useState<{
    kind: 'pdf' | 'unreadable';
    used: string[];
    unreadable: string[];
  } | null>(null);

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

  const modeLabel = (id: string): string => {
    const map: Record<string, string> = {
      'one-page': d.revModeOnePage,
      'key-concepts': d.revModeKeyConcepts,
      'important-questions': d.revModeImportantQuestions,
    };
    return map[id] ?? id;
  };

  const modeOptions: {
    id: ModeId;
    label: string;
    desc: string;
    icon: typeof FileText;
  }[] = [
    {
      id: 'one-page',
      label: d.revModeOnePage,
      desc: d.revModeOnePageDesc,
      icon: FileText,
    },
    {
      id: 'key-concepts',
      label: d.revModeKeyConcepts,
      desc: d.revModeKeyConceptsDesc,
      icon: BookOpen,
    },
    {
      id: 'important-questions',
      label: d.revModeImportantQuestions,
      desc: d.revModeImportantQuestionsDesc,
      icon: HelpCircle,
    },
  ];

  /* ── Keep the dashboard activity feed in sync ───────────────── */
  const syncFeed = (list: RevisionNoteItem[]) => {
    onNotesChanged?.(
      list.map((n) => ({ id: n.id, subjectName: n.subjectName, createdAt: n.createdAt }))
    );
  };

  /* ── Load the saved notes once ──────────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/revision-notes?email=${encodeURIComponent(email)}`)
      .then(async (res) => ({ res, data: await res.json().catch(() => null) }))
      .then(({ res, data }) => {
        if (cancelled) return;
        if (res.ok && data?.ok) {
          const list = data.notes as RevisionNoteItem[];
          setNotes(list);
          syncFeed(list);
        } else {
          toast({ title: d.revLoadFailed, variant: 'destructive' });
        }
      })
      .catch(() => {
        if (!cancelled) {
          toast({ title: d.revLoadFailed, variant: 'destructive' });
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [email, d.revLoadFailed, toast]);

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
    setSource(null);
    try {
      const res = await fetch('/api/revision-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          subjectId: subject.id,
          documentId,
          mode,
          lang,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        const note = data.note as RevisionNoteItem;
        setCurrent(note);
        setSource(
          data.source && typeof data.source === 'object'
            ? (data.source as {
                kind: 'pdf' | 'unreadable';
                used: string[];
                unreadable: string[];
              })
            : null
        );
        const next = [note, ...notes];
        setNotes(next);
        syncFeed(next);
      } else {
        toast({
          title: aiErrorTitle(data, d.revGenerateFailed, d.aiNotConfigured),
          variant: 'destructive',
        });
      }
    } catch {
      toast({ title: d.revGenerateFailed, variant: 'destructive' });
    } finally {
      setGenerating(false);
    }
  };

  /* ── Copy the displayed note as plain text ──────────────────── */
  const copyCurrent = async () => {
    if (!current) return;
    let q = 0;
    const plain = [
      current.title,
      current.content.overview,
      ...current.content.sections.flatMap((s) =>
        [
          s.heading,
          ...s.points.map((p) => {
            if (p.detail) {
              q += 1;
              return `Q${q}. ${p.text}\nA. ${p.detail}`;
            }
            return `\u2022 ${p.text}`;
          }),
        ].filter(Boolean)
      ),
    ]
      .filter(Boolean)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(plain);
      toast({ title: d.revCopied });
    } catch {
      toast({ title: d.revCopied });
    }
  };

  /* ── Delete a saved note ────────────────────────────────────── */
  const deleteNote = async (id: string) => {
    const snapshot = notes;
    const next = notes.filter((n) => n.id !== id);
    setNotes(next);
    syncFeed(next);
    if (current?.id === id) setCurrent(null);
    try {
      const res = await fetch(
        `/api/revision-notes?email=${encodeURIComponent(email)}&id=${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error('failed');
      toast({ title: d.revDeleted });
    } catch {
      setNotes(snapshot); // restore on failure
      syncFeed(snapshot);
      toast({ title: d.revLoadFailed, variant: 'destructive' });
    }
  };

  /* ── Running numbers for question-style points (detail ≠ empty) ── */
  const qNumbers = useMemo(() => {
    const map = new Map<string, number>(); // "sectionIdx-pointIdx" → Q number
    let q = 0;
    current?.content.sections.forEach((s, si) =>
      s.points.forEach((p, pi) => {
        if (p.detail) {
          q += 1;
          map.set(`${si}-${pi}`, q);
        }
      })
    );
    return map;
  }, [current]);

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
          <NotebookText className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-snug text-slate-900">
            {current.title}
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-400">
            <span className="truncate">{current.subjectName}</span>
            <span aria-hidden="true">·</span>
            <span>{modeLabel(current.mode)}</span>
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
            {d.revCopy}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void deleteNote(current.id)}
            aria-label={d.revDelete}
            className="h-8 w-8 rounded-lg p-0 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* Source banner — proves the note came from the subject's PDFs */}
      {source?.kind === 'pdf' && source.used.length > 0 && (
        <p className="flex items-start gap-2 border-b border-emerald-100 bg-emerald-50/70 px-5 py-2.5 text-xs leading-relaxed text-emerald-800 sm:px-6">
          <FileCheck2
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="min-w-0">
            {d.revSourcePdfs(source.used.join(', '))}
          </span>
        </p>
      )}
      {source?.kind === 'unreadable' && (
        <p className="flex items-start gap-2 border-b border-orange-100 bg-orange-50 px-5 py-2.5 text-xs leading-relaxed text-orange-800 sm:px-6">
          <TriangleAlert
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="min-w-0">{d.revSourceUnreadable}</span>
        </p>
      )}

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
              <ul
                className={`space-y-2.5 ${sec.heading ? 'mt-2.5' : ''}`}
              >
                {sec.points.map((p, j) =>
                  p.detail ? (
                    /* Question with a model answer (Important Questions) */
                    <li key={j} className="rounded-xl bg-slate-50 p-3.5">
                      <p className="flex items-start gap-2 text-sm font-medium leading-relaxed text-slate-800">
                        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[10px] font-bold text-white">
                          {qNumbers.get(`${i}-${j}`)}
                        </span>
                        <span className="min-w-0">{p.text}</span>
                      </p>
                      <p className="mt-1.5 pl-7 text-sm leading-relaxed text-slate-600">
                        {p.detail}
                      </p>
                    </li>
                  ) : (
                    /* Plain revision bullet */
                    <li
                      key={j}
                      className="flex items-start gap-2 text-sm leading-relaxed text-slate-600"
                    >
                      <span
                        className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                        aria-hidden="true"
                      />
                      <span className="min-w-0">{p.text}</span>
                    </li>
                  )
                )}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-6 border-t border-slate-100 pt-3 text-xs text-slate-400">
          {d.revGeneratedBy}
        </p>
      </div>
    </section>
  ) : null;

  /* ── Page ───────────────────────────────────────────────────── */
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      {/* Header */}
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
        {d.revTitle}
      </h1>
      <p className="mt-1.5 text-sm text-slate-500">{d.revSubtitle}</p>

      {subjectsLoading ? (
        <div className="mt-6 flex items-center justify-center rounded-2xl border border-slate-200 bg-white py-14 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : subjects.length === 0 ? (
        /* Empty state — no subject to revise yet */
        <div className="mt-6 flex flex-col items-center rounded-2xl border-2 border-dashed border-slate-300 px-6 py-14 text-center sm:py-16">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
            <NotebookText className="h-7 w-7" aria-hidden="true" />
          </span>
          <h2 className="mt-5 text-base font-semibold text-slate-800">
            {d.revEmptyTitle}
          </h2>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">
            {d.revEmptyDesc}
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
                  htmlFor="rev-subject"
                  className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500"
                >
                  {d.revSubjectLabel}
                </Label>
                <Select
                  value={subjectId}
                  onValueChange={pickSubject}
                  disabled={generating}
                >
                  <SelectTrigger
                    id="rev-subject"
                    aria-label={d.revSubjectLabel}
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
                  htmlFor="rev-document"
                  className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500"
                >
                  {d.revDocumentsLabel}
                </Label>
                <Select
                  value={documentId}
                  onValueChange={setDocumentId}
                  disabled={generating}
                >
                  <SelectTrigger
                    id="rev-document"
                    aria-label={d.revDocumentsLabel}
                    className="h-10 w-full rounded-lg border-slate-200 text-sm text-slate-700"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-64 rounded-xl border-slate-200">
                    <SelectItem value="all">{d.revAllDocuments}</SelectItem>
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
                {d.revModeLabel}
              </Label>
              <div
                role="group"
                aria-label={d.revModeLabel}
                className="grid gap-3 pt-0.5 sm:grid-cols-3"
              >
                {modeOptions.map((o) => {
                  const active = mode === o.id;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => setMode(o.id)}
                      aria-pressed={active}
                      disabled={generating}
                      className={`rounded-xl border p-4 text-left transition disabled:cursor-not-allowed ${
                        active
                          ? 'border-emerald-500 bg-emerald-50/70'
                          : 'border-slate-200 bg-white hover:border-emerald-200'
                      }`}
                    >
                      <o.icon
                        className={`h-5 w-5 ${
                          active ? 'text-emerald-600' : 'text-slate-700'
                        }`}
                        aria-hidden="true"
                      />
                      <span
                        className={`mt-2.5 block text-sm font-semibold ${
                          active ? 'text-emerald-700' : 'text-slate-900'
                        }`}
                      >
                        {o.label}
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-slate-500">
                        {o.desc}
                      </span>
                    </button>
                  );
                })}
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
              {generating ? d.revGenerating : d.revGenerate}
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
                      ? d.revContextDoc(activeDoc.name)
                      : d.revContextLine(subject.name, subjectDocs.length)}
                  </>
                ) : (
                  <>
                    <TriangleAlert
                      className="h-4 w-4 shrink-0 text-orange-500"
                      aria-hidden="true"
                    />
                    {d.revNoPdfsHint(subject.name)}
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
                  {d.revGeneratingTitle}
                </p>
                <p className="mt-0.5 text-sm text-slate-500">
                  {d.revGeneratingDesc}
                </p>
              </div>
            </section>
          )}

          {/* Result */}
          {!generating && ResultCard}

          {/* Recent revision notes */}
          {notes.length > 0 && (
            <section className="mt-8 pb-10" aria-label={d.revHistory}>
              <h2 className="text-base font-semibold text-slate-800">
                {d.revHistory}
              </h2>
              {historyLoading ? (
                <div className="mt-3 flex items-center justify-center rounded-xl border border-slate-200 bg-white py-8 text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {notes.map((n) => (
                    <li
                      key={n.id}
                      className={`flex items-center gap-2 rounded-xl border bg-white px-4 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition ${
                        current?.id === n.id
                          ? 'border-emerald-300'
                          : 'border-slate-200 hover:border-emerald-200'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setCurrent(n);
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <span
                          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${CHIP_STYLES['emerald']}`}
                        >
                          <NotebookText className="h-4 w-4" aria-hidden="true" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-slate-800">
                            {n.title}
                          </span>
                          <span className="block truncate text-xs text-slate-400">
                            {n.subjectName} · {modeLabel(n.mode)} ·{' '}
                            {formatDate(n.createdAt)}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteNote(n.id)}
                        aria-label={d.revDelete}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
