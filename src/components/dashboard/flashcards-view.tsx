'use client';

/**
 * Flashcards section, 1:1 with the design screenshot: the "Flashcards"
 * header ("Generate smart decks and study them with spaced repetition."),
 * the generator card (SUBJECT select with the orange no-subject warning,
 * the CARDS count select and the green "Generate Flashcards" layers
 * button) and — once decks exist — the "Your decks" list with per-deck
 * mastery progress.
 *
 * Fully functional: POST /api/flashcards generates a real AI deck — when
 * a subject is chosen, the extracted text of its uploaded PDFs is the
 * primary source (general study material otherwise). Decks are studied
 * one card at a time with a 3D flip, "Still Learning" / "I Knew It"
 * marks persisted per card via POST /api/flashcards/<id>/progress, and a
 * completion screen summarizes the session. Mastery survives reloads.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  Layers,
  Loader2,
  RotateCw,
  Trash2,
  X,
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
import type { Subject } from '@/components/dashboard/subject-styles';
import type { Pdf } from '@/components/dashboard/pdf-utils';
import { formatDate } from '@/components/dashboard/pdf-utils';

export type FlashCard = { front: string; back: string };

export type DeckSummary = {
  id: string;
  subjectName: string;
  title: string;
  total: number;
  knownCount: number;
  createdAt: string;
};

type DeckFull = DeckSummary & { cards: FlashCard[]; known: number[] };

type Session = {
  deck: DeckFull;
  known: boolean[];
  idx: number;
  flipped: boolean;
  finished: boolean;
};

const CARD_COUNTS = [6, 12, 16, 20, 24];

export default function FlashcardsView({
  email,
  subjects,
  pdfs,
  onDecksChanged,
}: {
  email: string;
  subjects: Subject[];
  pdfs: Pdf[];
  onDecksChanged?: (decks: DeckSummary[]) => void;
}) {
  const { toast } = useToast();
  const { t, lang } = useLanguage();
  const d = t.dashboard;

  /* ── Builder state ──────────────────────────────────────────── */
  const [subjectId, setSubjectId] = useState('none');
  const [count, setCount] = useState(12);
  const [generating, setGenerating] = useState(false);

  /* Where the last generated deck came from (source transparency) */
  const [source, setSource] = useState<{
    kind: 'pdf' | 'unreadable';
    used: string[];
    unreadable: string[];
  } | null>(null);

  /* ── Study session ──────────────────────────────────────────── */
  const [session, setSession] = useState<Session | null>(null);
  const advancingRef = useRef(false);

  /* ── Saved decks ────────────────────────────────────────────── */
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [decksLoading, setDecksLoading] = useState(true);

  /* ── Derived ────────────────────────────────────────────────── */
  const subject = useMemo(
    () => subjects.find((s) => s.id === subjectId) ?? null,
    [subjects, subjectId]
  );
  const subjectDocs = useMemo(
    () =>
      subject ? pdfs.filter((p) => p.subjectName === subject.name) : [],
    [pdfs, subject]
  );

  /* Keep the dashboard activity feed in sync. */
  useEffect(() => {
    onDecksChanged?.(decks);
  }, [decks, onDecksChanged]);

  /* ── Load the saved decks once ──────────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/flashcards?email=${encodeURIComponent(email)}`)
      .then(async (res) => ({ res, data: await res.json().catch(() => null) }))
      .then(({ res, data }) => {
        if (cancelled) return;
        if (res.ok && data?.ok) {
          setDecks(data.decks as DeckSummary[]);
        } else {
          toast({ title: d.fcLoadFailed, variant: 'destructive' });
        }
      })
      .catch(() => {
        if (!cancelled) {
          toast({ title: d.fcLoadFailed, variant: 'destructive' });
        }
      })
      .finally(() => {
        if (!cancelled) setDecksLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [email, d.fcLoadFailed, toast]);

  /* ── Default the subject to the first one once subjects land so the
       deck is generated from that subject's PDFs, not general knowledge ── */
  useEffect(() => {
    if (subjects.length === 0) return;
    setSubjectId((prev) =>
      prev && subjects.some((s) => s.id === prev) ? prev : subjects[0].id
    );
  }, [subjects]);

  /* ── Generate ───────────────────────────────────────────────── */
  const generate = async () => {
    if (generating || session) return;
    setGenerating(true);
    setSource(null);
    try {
      const res = await fetch('/api/flashcards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          subjectId: subjectId === 'none' ? undefined : subjectId,
          count,
          lang,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        const deck = data.deck as DeckFull;
        const summary: DeckSummary = {
          id: deck.id,
          subjectName: deck.subjectName,
          title: deck.title,
          total: deck.total,
          knownCount: 0,
          createdAt: deck.createdAt,
        };
        setDecks((prev) => [summary, ...prev]);
        setSession({
          deck,
          known: Array(deck.cards.length).fill(false),
          idx: 0,
          flipped: false,
          finished: false,
        });
        setSource(
          data.source && typeof data.source === 'object'
            ? (data.source as {
                kind: 'pdf' | 'unreadable';
                used: string[];
                unreadable: string[];
              })
            : null
        );
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        toast({
          title: aiErrorTitle(data, d.fcGenerateFailed, d.aiNotConfigured),
          variant: 'destructive',
        });
      }
    } catch {
      toast({ title: d.fcGenerateFailed, variant: 'destructive' });
    } finally {
      setGenerating(false);
    }
  };

  /* ── Open a saved deck from the list ────────────────────────── */
  const openDeck = async (id: string) => {
    try {
      const res = await fetch(
        `/api/flashcards/${encodeURIComponent(id)}?email=${encodeURIComponent(email)}`
      );
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        const deck = data.deck as DeckFull;
        setSession({
          deck,
          known: deck.cards.map((_, i) => deck.known.includes(i)),
          idx: 0,
          flipped: false,
          finished: false,
        });
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        toast({ title: d.fcLoadFailed, variant: 'destructive' });
      }
    } catch {
      toast({ title: d.fcLoadFailed, variant: 'destructive' });
    }
  };

  /* ── Mark the current card + advance (optimistic, DB-persisted) */
  const mark = (value: boolean) => {
    if (!session || session.finished) return;
    if (advancingRef.current) return;
    advancingRef.current = true;
    setTimeout(() => {
      advancingRef.current = false;
    }, 300);

    const idx = session.idx;
    const deckId = session.deck.id;

    setSession((prev) => {
      if (!prev) return prev;
      const known = [...prev.known];
      known[idx] = value;
      const isLast = prev.idx >= prev.deck.cards.length - 1;
      return {
        ...prev,
        known,
        idx: isLast ? prev.idx : prev.idx + 1,
        flipped: false,
        finished: isLast,
      };
    });

    void (async () => {
      try {
        const res = await fetch(
          `/api/flashcards/${encodeURIComponent(deckId)}/progress`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, cardIdx: idx, known: value }),
          }
        );
        const data = await res.json().catch(() => null);
        if (res.ok && data?.ok) {
          const knownCount = data.knownCount as number;
          setDecks((prev) =>
            prev.map((x) =>
              x.id === deckId ? { ...x, knownCount } : x
            )
          );
        } else {
          throw new Error('failed');
        }
      } catch {
        setSession((prev) =>
          prev
            ? {
                ...prev,
                known: prev.known.map((k, i) => (i === idx ? !value : k)),
              }
            : prev
        );
        toast({ title: d.fcProgressFailed, variant: 'destructive' });
      }
    })();
  };

  /* ── Delete a deck ──────────────────────────────────────────── */
  const deleteDeck = async (id: string) => {
    const snapshot = decks;
    setDecks((prev) => prev.filter((x) => x.id !== id));
    if (session?.deck.id === id) setSession(null);
    try {
      const res = await fetch(
        `/api/flashcards/${encodeURIComponent(id)}?email=${encodeURIComponent(email)}`,
        { method: 'DELETE' }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error('failed');
      toast({ title: d.fcDeleted });
    } catch {
      setDecks(snapshot); // restore on failure
      toast({ title: d.fcLoadFailed, variant: 'destructive' });
    }
  };

  /* ── Active study card ──────────────────────────────────────── */
  const StudyCard = session ? (
    <section
      aria-live="polite"
      className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="flex items-start gap-3.5 border-b border-slate-100 p-5 sm:p-6">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
          <Layers className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-snug text-slate-900">
            {session.deck.title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-slate-400">
            <span className="truncate">
              {session.deck.subjectName || d.fcGeneralDeck}
            </span>
            <span aria-hidden="true">·</span>
            <span>{d.fcCardsCount(session.deck.cards.length)}</span>
            <span aria-hidden="true">·</span>
            <span>
              {d.fcMasteredOf(
                session.known.filter(Boolean).length,
                session.deck.cards.length
              )}
            </span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSession(null)}
          aria-label={d.fcClose}
          className="h-8 w-8 rounded-lg p-0 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      {/* Source banner — proves the deck came from the subject's PDFs */}
      {source?.kind === 'pdf' && source.used.length > 0 && (
        <p className="flex items-start gap-2 border-b border-emerald-100 bg-emerald-50/70 px-5 py-2.5 text-xs leading-relaxed text-emerald-800 sm:px-6">
          <FileCheck2
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="min-w-0">
            {d.fcSourcePdfs(source.used.join(', '))}
          </span>
        </p>
      )}
      {source?.kind === 'unreadable' && (
        <p className="flex items-start gap-2 border-b border-orange-100 bg-orange-50 px-5 py-2.5 text-xs leading-relaxed text-orange-800 sm:px-6">
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="min-w-0">{d.fcSourceUnreadable}</span>
        </p>
      )}

      <div className="p-5 sm:p-6">
        {/* Progress */}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
            {session.finished
              ? d.fcDeckComplete
              : d.fcCardOf(
                  session.idx + 1,
                  session.deck.cards.length
                )}
          </p>
          <p className="text-xs text-slate-400">
            {d.fcMasteredCount(session.known.filter(Boolean).length)}
          </p>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all duration-300"
            style={{
              width: `${session.finished ? 100 : (session.idx / session.deck.cards.length) * 100}%`,
            }}
          />
        </div>

        {session.finished ? (
          /* ── Completion screen ──────────────────────────────── */
          <div className="flex flex-col items-center py-10 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
              <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
            </span>
            <h3 className="mt-5 text-lg font-semibold text-slate-900">
              {d.fcDeckComplete}
            </h3>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">
              {d.fcDeckCompleteDesc(
                session.known.filter(Boolean).length,
                session.deck.cards.length
              )}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Button
                onClick={() =>
                  setSession((prev) =>
                    prev
                      ? { ...prev, idx: 0, flipped: false, finished: false }
                      : prev
                  )
                }
                className="h-10 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700"
              >
                {d.fcStudyAgain}
              </Button>
              <Button
                variant="outline"
                onClick={() => setSession(null)}
                className="h-10 rounded-lg text-sm"
              >
                {d.fcBackToDecks}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* ── Flip card ──────────────────────────────────────── */}
            <button
              type="button"
              onClick={() =>
                setSession((prev) =>
                  prev ? { ...prev, flipped: !prev.flipped } : prev
                )
              }
              aria-pressed={session.flipped}
              aria-label={
                session.flipped ? d.fcBackLabel : d.fcFrontLabel
              }
              className="mt-5 block h-60 w-full [perspective:1400px] sm:h-64"
            >
              <span
                className={`relative block h-full w-full transition-transform duration-500 [transform-style:preserve-3d] ${
                  session.flipped
                    ? '[transform:rotateY(180deg)]'
                    : '[transform:rotateY(0deg)]'
                }`}
              >
                {/* Front (question / term) */}
                <span className="absolute inset-0 flex flex-col rounded-2xl border-2 border-emerald-200 bg-gradient-to-br from-emerald-50 via-white to-white p-6 [backface-visibility:hidden]">
                  <span className="self-start rounded-full bg-emerald-100 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                    {d.fcFrontLabel}
                  </span>
                  <span className="flex flex-1 items-center justify-center px-2 text-center">
                    <span className="text-lg font-medium leading-relaxed text-slate-900 sm:text-xl">
                      {session.deck.cards[session.idx]?.front}
                    </span>
                  </span>
                  <span className="flex items-center justify-center gap-1.5 text-xs text-slate-400">
                    <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                    {d.fcFlipHint}
                  </span>
                </span>

                {/* Back (answer / definition) */}
                <span className="absolute inset-0 flex flex-col rounded-2xl border-2 border-slate-300 bg-white p-6 [backface-visibility:hidden] [transform:rotateY(180deg)]">
                  <span className="self-start rounded-full bg-slate-100 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    {d.fcBackLabel}
                  </span>
                  <span className="flex flex-1 items-center justify-center overflow-y-auto px-2 py-3 text-center">
                    <span className="text-base leading-relaxed text-slate-800 sm:text-lg">
                      {session.deck.cards[session.idx]?.back}
                    </span>
                  </span>
                  <span className="flex items-center justify-center gap-1.5 text-xs text-slate-400">
                    <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                    {d.fcFlipHint}
                  </span>
                </span>
              </span>
            </button>

            {/* ── Mark buttons ───────────────────────────────────── */}
            <div className="mt-5 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
              {session.flipped ? (
                <>
                  <Button
                    variant="outline"
                    onClick={() => mark(false)}
                    className="h-11 w-full rounded-lg border-rose-300 text-sm font-medium text-rose-600 hover:bg-rose-50 sm:w-auto"
                  >
                    {d.fcStillLearning}
                  </Button>
                  <Button
                    onClick={() => mark(true)}
                    className="h-11 w-full rounded-lg bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-700 sm:w-auto"
                  >
                    {d.fcKnewIt}
                  </Button>
                </>
              ) : (
                <p className="text-sm text-slate-400">{d.fcFlipHint}</p>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  ) : null;

  /* ── Page ───────────────────────────────────────────────────── */
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      {/* Header */}
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
        {d.fcTitle}
      </h1>
      <p className="mt-1.5 text-sm text-slate-500">{d.fcSubtitle}</p>

      {/* Generator card — 1:1 with the screenshot */}
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-6">
        <div className="grid gap-4 sm:grid-cols-2 sm:gap-x-16">
          <div className="space-y-1.5">
            <Label
              htmlFor="fc-subject"
              className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500"
            >
              {d.fcSubjectLabel}
            </Label>
            <Select
              value={subjectId}
              onValueChange={setSubjectId}
              disabled={generating}
            >
              <SelectTrigger
                id="fc-subject"
                aria-label={d.fcSubjectLabel}
                className="h-10 w-full rounded-lg border-slate-200 text-sm text-slate-700"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-64 rounded-xl border-slate-200">
                <SelectItem value="none">{d.fcNoSubject}</SelectItem>
                {subjects.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label
              htmlFor="fc-count"
              className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500"
            >
              {d.fcCardsLabel}
            </Label>
            <Select
              value={String(count)}
              onValueChange={(v) => setCount(Number(v))}
              disabled={generating}
            >
              <SelectTrigger
                id="fc-count"
                aria-label={d.fcCardsLabel}
                className="h-10 w-full rounded-lg border-slate-200 text-sm text-slate-700"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-64 rounded-xl border-slate-200">
                {CARD_COUNTS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {d.fcCardsCount(n)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Subject status line — mirrors the screenshot's orange helper */}
        <p
          className={`mt-3 text-sm ${
            subject && subjectDocs.length > 0
              ? 'text-emerald-700'
              : 'text-orange-600'
          }`}
        >
          {!subject
            ? d.fcNoSubjectWarn
            : subjectDocs.length > 0
              ? d.fcContextDocs(subject.name, subjectDocs.length)
              : d.fcNoDocsWarn(subject.name)}
        </p>

        <Button
          onClick={() => void generate()}
          disabled={generating || !!session}
          className="mt-5 h-10 gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-70"
        >
          {generating ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Layers className="h-4 w-4" aria-hidden="true" />
          )}
          {generating ? d.fcGenerating : d.fcGenerate}
        </Button>
      </section>

      {/* Generating placeholder */}
      {generating && (
        <section
          aria-live="polite"
          className="mt-6 flex items-center gap-3.5 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-6"
        >
          <Loader2
            className="h-5 w-5 shrink-0 animate-spin text-emerald-500"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-700">
              {d.fcGeneratingTitle}
            </p>
            <p className="mt-0.5 text-sm text-slate-500">
              {d.fcGeneratingDesc}
            </p>
          </div>
        </section>
      )}

      {/* Active study session */}
      {!generating && StudyCard}

      {/* Your decks — hidden entirely while empty (matches the
          screenshot's generator-only empty page) */}
      {!generating && !decksLoading && decks.length > 0 && (
        <section className="mt-8 pb-10" aria-label={d.fcYourDecks}>
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-800">
            <Layers className="h-4 w-4 text-slate-400" aria-hidden="true" />
            {d.fcYourDecks}
          </h2>
          <ul className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            {decks.map((deck) => {
              const pct =
                deck.total > 0
                  ? Math.round((deck.knownCount / deck.total) * 100)
                  : 0;
              return (
                <li
                  key={deck.id}
                  className="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:flex-nowrap sm:px-5"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-50 text-orange-600">
                    <Layers className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <button
                    type="button"
                    onClick={() => void openDeck(deck.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-sm font-semibold text-slate-800">
                      {deck.title}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {deck.subjectName || d.fcGeneralDeck} ·{' '}
                      {d.fcCardsCount(deck.total)} · {formatDate(deck.createdAt)}
                    </span>
                  </button>
                  <span className="shrink-0 text-xs font-semibold tabular-nums text-slate-500 sm:hidden">
                    {deck.knownCount}/{deck.total}
                  </span>
                  <span className="hidden w-32 shrink-0 sm:block">
                    <span className="flex items-center justify-between gap-2 text-[11px] font-medium text-slate-500">
                      <span className="truncate">
                        {d.fcMasteredOf(deck.knownCount, deck.total)}
                      </span>
                    </span>
                    <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <span
                        className="block h-full rounded-full bg-emerald-500 transition-all duration-300"
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    onClick={() => void openDeck(deck.id)}
                    className="h-9 shrink-0 rounded-lg border-emerald-600 px-3 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
                  >
                    {d.fcStudy}
                  </Button>
                  <button
                    type="button"
                    onClick={() => void deleteDeck(deck.id)}
                    aria-label={d.fcDelete}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
