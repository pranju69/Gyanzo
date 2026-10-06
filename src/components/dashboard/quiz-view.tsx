'use client';

/**
 * Quiz section, 1:1 with the design screenshot: the "Quiz" header
 * ("Generate an AI quiz from your material and track your scores.") and
 * a config card holding the SUBJECT select ("No subject selected" +
 * the orange general-knowledge warning), the QUESTIONS count select,
 * the QUESTION TYPES multi-select chips (MCQ / True/False / Fill in the
 * Blanks), the DIFFICULTY single-select chips (Easy / Medium / Hard)
 * and the green "Generate Quiz" sparkle button. Below: the
 * "Recent attempts" list with per-row score dot, difficulty badge and
 * percentage.
 *
 * Fully functional: POST /api/quiz generates a real AI quiz — when a
 * subject is chosen, the extracted text of its uploaded PDFs is the
 * primary source (general knowledge otherwise). The quiz is taken one
 * question at a time, graded SERVER-SIDE via POST /api/quiz/attempts
 * (correct answers never reach the client before submission), and every
 * attempt is persisted in SQLite with a full per-question review that
 * can be reopened from "Recent attempts".
 */

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  FileCheck2,
  HelpCircle,
  History,
  ListChecks,
  Loader2,
  Sparkles,
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/lib/i18n';
import { aiErrorTitle } from '@/lib/ai-error';
import type { Subject } from '@/components/dashboard/subject-styles';
import type { Pdf } from '@/components/dashboard/pdf-utils';
import { formatDate } from '@/components/dashboard/pdf-utils';

type QType = 'mcq' | 'truefalse' | 'fillblank';
type Difficulty = 'easy' | 'medium' | 'hard';

type QuizQuestion = {
  type: QType;
  question: string;
  options: string[] | null;
  answer: number | string;
  explanation: string;
};

type ReviewQuestion = {
  type: QType;
  question: string;
  options: string[] | null;
  given: number | string | null;
  answer: number | string;
  correct: boolean;
  explanation: string;
};

export type QuizAttemptSummary = {
  id: string;
  subjectName: string;
  difficulty: string;
  total: number;
  correct: number;
  scorePct: number;
  createdAt: string;
};

type AttemptDTO = QuizAttemptSummary & { review: ReviewQuestion[] };

type GeneratedQuiz = {
  id: string;
  subjectId: string | null;
  subjectName: string;
  difficulty: string;
  title: string;
  count: number;
  questions: QuizQuestion[];
};

const QUESTION_COUNTS = [5, 8, 10, 15, 20];
const TYPE_IDS: QType[] = ['mcq', 'truefalse', 'fillblank'];
const DIFFICULTY_IDS: Difficulty[] = ['easy', 'medium', 'hard'];
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

const DIFF_BADGE: Record<Difficulty, string> = {
  easy: 'bg-emerald-50 text-emerald-700',
  medium: 'bg-amber-50 text-amber-700',
  hard: 'bg-rose-50 text-rose-600',
};

/* Score tone: green ≥ 70, amber ≥ 40, red below. */
type Tone = 'emerald' | 'amber' | 'rose';
const scoreTone = (pct: number): Tone =>
  pct >= 70 ? 'emerald' : pct >= 40 ? 'amber' : 'rose';
const TONE_TEXT: Record<Tone, string> = {
  emerald: 'text-emerald-600',
  amber: 'text-amber-600',
  rose: 'text-rose-600',
};
const TONE_BG: Record<Tone, string> = {
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
};
const TONE_HEX: Record<Tone, string> = {
  emerald: '#10b981',
  amber: '#f59e0b',
  rose: '#f43f5e',
};

function DifficultyBadge({ value, label }: { value: string; label: string }) {
  const cls =
    DIFF_BADGE[(value as Difficulty) in DIFF_BADGE ? (value as Difficulty) : 'medium'];
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${cls}`}
    >
      {label}
    </span>
  );
}

export default function QuizView({
  email,
  subjects,
  pdfs,
  onAttemptsChanged,
}: {
  email: string;
  subjects: Subject[];
  pdfs: Pdf[];
  onAttemptsChanged?: (attempts: QuizAttemptSummary[]) => void;
}) {
  const { toast } = useToast();
  const { t, lang } = useLanguage();
  const d = t.dashboard;

  /* ── Builder state ──────────────────────────────────────────── */
  const [subjectId, setSubjectId] = useState('none');
  const [count, setCount] = useState(8);
  const [types, setTypes] = useState<QType[]>(['mcq']);
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [generating, setGenerating] = useState(false);

  /* Where the last generated quiz came from (source transparency) */
  const [source, setSource] = useState<{
    kind: 'pdf' | 'unreadable';
    used: string[];
    unreadable: string[];
  } | null>(null);

  /* ── Session (taking the quiz) + result (review) ────────────── */
  const [session, setSession] = useState<{
    quiz: GeneratedQuiz;
    answers: (number | string | null)[];
    idx: number;
  } | null>(null);
  const [result, setResult] = useState<AttemptDTO | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /* ── Recent attempts ────────────────────────────────────────── */
  const [attemptsFull, setAttemptsFull] = useState<AttemptDTO[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

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

  const typeLabel = (id: QType): string =>
    id === 'mcq'
      ? d.quizTypeMcq
      : id === 'truefalse'
        ? d.quizTypeTrueFalse
        : d.quizTypeFillBlank;

  const diffLabel = (id: string): string =>
    id === 'easy'
      ? d.quizDiffEasy
      : id === 'hard'
        ? d.quizDiffHard
        : d.quizDiffMedium;

  const attemptTitle = (subjectName: string): string =>
    subjectName ? `${subjectName} quiz` : d.quizGeneralQuiz;

  /* Keep the dashboard's "Quizzes taken" stat + activity in sync. */
  const syncAttempts = (full: AttemptDTO[]) => {
    onAttemptsChanged?.(
      full.map((a) => ({
        id: a.id,
        subjectName: a.subjectName,
        difficulty: a.difficulty,
        total: a.total,
        correct: a.correct,
        scorePct: a.scorePct,
        createdAt: a.createdAt,
      }))
    );
  };

  /* ── Load the saved attempts once ───────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/quiz/attempts?email=${encodeURIComponent(email)}`)
      .then(async (res) => ({ res, data: await res.json().catch(() => null) }))
      .then(({ res, data }) => {
        if (cancelled) return;
        if (res.ok && data?.ok) {
          const full = data.attempts as AttemptDTO[];
          setAttemptsFull(full);
          syncAttempts(full);
        } else {
          toast({ title: d.quizLoadFailed, variant: 'destructive' });
        }
      })
      .catch(() => {
        if (!cancelled) {
          toast({ title: d.quizLoadFailed, variant: 'destructive' });
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [email, d.quizLoadFailed, toast]);

  /* ── Default the subject to the first one once subjects land so the
       quiz is generated from that subject's PDFs, not general knowledge ── */
  useEffect(() => {
    if (subjects.length === 0) return;
    setSubjectId((prev) =>
      prev && subjects.some((s) => s.id === prev) ? prev : subjects[0].id
    );
  }, [subjects]);

  /* ── Generate ───────────────────────────────────────────────── */
  const generate = async () => {
    if (types.length === 0) {
      toast({ title: d.quizTypesRequired });
      return;
    }
    if (generating) return;
    setGenerating(true);
    setResult(null);
    setSession(null);
    setSource(null);
    try {
      const res = await fetch('/api/quiz', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          subjectId: subjectId === 'none' ? undefined : subjectId,
          count,
          types,
          difficulty,
          lang,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        const quiz = data.quiz as GeneratedQuiz;
        setSession({
          quiz,
          answers: Array(quiz.questions.length).fill(null),
          idx: 0,
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
          title: aiErrorTitle(data, d.quizGenerateFailed, d.aiNotConfigured),
          variant: 'destructive',
        });
      }
    } catch {
      toast({ title: d.quizGenerateFailed, variant: 'destructive' });
    } finally {
      setGenerating(false);
    }
  };

  /* ── Session helpers ────────────────────────────────────────── */
  const setAnswer = (value: number | string | null) => {
    setSession((prev) => {
      if (!prev) return prev;
      const answers = [...prev.answers];
      answers[prev.idx] = value;
      return { ...prev, answers };
    });
  };

  const goTo = (idx: number) => {
    setSession((prev) => (prev ? { ...prev, idx } : prev));
  };

  const goNext = () => {
    if (!session) return;
    if (session.idx < session.quiz.questions.length - 1) {
      goTo(session.idx + 1);
    }
  };
  const goPrev = () => {
    if (!session) return;
    if (session.idx > 0) goTo(session.idx - 1);
  };

  /* ── Submit (server-side grading) ───────────────────────────── */
  const submit = async () => {
    if (!session || submitting) return;
    const firstUn = session.answers.findIndex(
      (a) => a === null || a === ''
    );
    if (firstUn !== -1) {
      goTo(firstUn);
      toast({ title: d.quizAnswerAll });
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/quiz/attempts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          quizId: session.quiz.id,
          answers: session.answers,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        const attempt = data.attempt as AttemptDTO;
        const nextFull = [attempt, ...attemptsFull];
        setAttemptsFull(nextFull);
        syncAttempts(nextFull);
        setResult(attempt);
        setSession(null);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        toast({ title: d.quizSubmitFailed, variant: 'destructive' });
      }
    } catch {
      toast({ title: d.quizSubmitFailed, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  /* ── Open a saved attempt from history ──────────────────────── */
  const viewAttempt = (a: AttemptDTO) => {
    setSession(null);
    setResult(a);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /* ── Delete an attempt ──────────────────────────────────────── */
  const deleteAttempt = async (id: string) => {
    const snapshot = attemptsFull;
    const next = snapshot.filter((a) => a.id !== id);
    setAttemptsFull(next);
    syncAttempts(next);
    if (result?.id === id) setResult(null);
    try {
      const res = await fetch(
        `/api/quiz/attempts?email=${encodeURIComponent(email)}&id=${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error('failed');
      toast({ title: d.quizDeleted });
    } catch {
      setAttemptsFull(snapshot); // restore on failure
      syncAttempts(snapshot);
      toast({ title: d.quizLoadFailed, variant: 'destructive' });
    }
  };

  /* ── Shared review list (used by the result card) ───────────── */
  const ReviewList = ({ review }: { review: ReviewQuestion[] }) => (
    <div className="mt-5 space-y-5">
      {review.map((r, i) => {
        const opts =
          r.type === 'truefalse'
            ? [d.quizTrue, d.quizFalse]
            : r.options;
        return (
          <div
            key={i}
            className="border-t border-slate-100 pt-5 first:border-0 first:pt-0"
          >
            <div className="flex items-start gap-3">
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${
                  r.correct ? 'bg-emerald-500' : 'bg-rose-500'
                }`}
                aria-hidden="true"
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {typeLabel(r.type)}
                </span>
                <p className="mt-1.5 text-sm font-medium leading-relaxed text-slate-900">
                  {r.question}
                </p>

                {opts ? (
                  <div className="mt-3 space-y-2">
                    {opts.map((opt, oi) => {
                      const isCorrect = oi === r.answer;
                      const isGiven =
                        typeof r.given === 'number' && r.given === oi;
                      return (
                        <div
                          key={oi}
                          className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm ${
                            isCorrect
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                              : isGiven
                                ? 'border-rose-300 bg-rose-50 text-rose-900'
                                : 'border-slate-200 bg-white text-slate-600'
                          }`}
                        >
                          <span
                            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
                              isCorrect
                                ? 'border-emerald-400 bg-emerald-500 text-white'
                                : isGiven
                                  ? 'border-rose-400 bg-rose-500 text-white'
                                  : 'border-slate-300 text-slate-500'
                            }`}
                            aria-hidden="true"
                          >
                            {LETTERS[oi] ?? oi + 1}
                          </span>
                          <span className="min-w-0 flex-1">{opt}</span>
                          {isCorrect && (
                            <Check
                              className="h-4 w-4 shrink-0 text-emerald-600"
                              aria-label={d.quizCorrectAnswer}
                            />
                          )}
                          {isGiven && !isCorrect && (
                            <X
                              className="h-4 w-4 shrink-0 text-rose-600"
                              aria-label={d.quizYourAnswer}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="mt-3 space-y-1.5 text-sm">
                    <p>
                      <span className="text-slate-500">
                        {d.quizYourAnswer}:{' '}
                      </span>
                      <span
                        className={`font-medium ${
                          r.correct ? 'text-emerald-700' : 'text-rose-600'
                        }`}
                      >
                        {typeof r.given === 'string' && r.given
                          ? r.given
                          : d.quizNotAnswered}
                      </span>
                    </p>
                    {!r.correct && (
                      <p>
                        <span className="text-slate-500">
                          {d.quizCorrectAnswer}:{' '}
                        </span>
                        <span className="font-medium text-emerald-700">
                          {String(r.answer).split('|').join(' / ')}
                        </span>
                      </p>
                    )}
                  </div>
                )}

                {r.explanation && (
                  <p className="mt-3 rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
                    {r.explanation}
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );

  /* ── Active quiz card ───────────────────────────────────────── */
  const SessionCard = session ? (
    <section
      aria-live="polite"
      className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="flex items-start gap-3.5 border-b border-slate-100 p-5 sm:p-6">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
          <ListChecks className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-snug text-slate-900">
            {session.quiz.title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-slate-400">
            <span className="truncate">
              {session.quiz.subjectName || d.quizNoSubject}
            </span>
            <span aria-hidden="true">·</span>
            <DifficultyBadge
              value={session.quiz.difficulty}
              label={diffLabel(session.quiz.difficulty)}
            />
            <span aria-hidden="true">·</span>
            <span>{d.quizQuestionsCount(session.quiz.questions.length)}</span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSession(null)}
          aria-label={d.quizClose}
          className="h-8 w-8 rounded-lg p-0 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      {/* Source banner — proves the quiz came from the subject's PDFs */}
      {source?.kind === 'pdf' && source.used.length > 0 && (
        <p className="flex items-start gap-2 border-b border-emerald-100 bg-emerald-50/70 px-5 py-2.5 text-xs leading-relaxed text-emerald-800 sm:px-6">
          <FileCheck2
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="min-w-0">
            {d.quizSourcePdfs(source.used.join(', '))}
          </span>
        </p>
      )}
      {source?.kind === 'unreadable' && (
        <p className="flex items-start gap-2 border-b border-orange-100 bg-orange-50 px-5 py-2.5 text-xs leading-relaxed text-orange-800 sm:px-6">
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span className="min-w-0">{d.quizSourceUnreadable}</span>
        </p>
      )}

      <div className="p-5 sm:p-6">
        {/* Progress */}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
            {d.quizQuestionOf(session.idx + 1, session.quiz.questions.length)}
          </p>
          <p className="text-xs text-slate-400">
            {
              session.answers.filter((a) => a !== null && a !== '').length
            }{' '}
            / {session.quiz.questions.length}
          </p>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-emerald-500 transition-all duration-300"
            style={{
              width: `${((session.idx + 1) / session.quiz.questions.length) * 100}%`,
            }}
          />
        </div>

        {/* Question dots */}
        <div className="mt-4 flex flex-wrap gap-1">
          {session.quiz.questions.map((_, i) => {
            const answered =
              session.answers[i] !== null && session.answers[i] !== '';
            const current = i === session.idx;
            return (
              <button
                key={i}
                type="button"
                onClick={() => goTo(i)}
                aria-label={d.quizQuestionOf(i + 1, session.quiz.questions.length)}
                aria-current={current || undefined}
                className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition ${
                  current
                    ? 'bg-emerald-600 text-white'
                    : answered
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'text-slate-400 hover:bg-slate-100'
                }`}
              >
                {i + 1}
              </button>
            );
          })}
        </div>

        {/* Current question */}
        {(() => {
          const q = session.quiz.questions[session.idx];
          const given = session.answers[session.idx];
          return (
            <div className="mt-5">
              <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {typeLabel(q.type)}
              </span>
              <p className="mt-2.5 text-base font-medium leading-relaxed text-slate-900">
                {q.question}
              </p>

              {q.type === 'fillblank' ? (
                <Input
                  type="text"
                  value={typeof given === 'string' ? given : ''}
                  onChange={(e) => setAnswer(e.target.value || null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      if (session.idx < session.quiz.questions.length - 1)
                        goNext();
                    }
                  }}
                  placeholder={d.quizAnswerPlaceholder}
                  aria-label={d.quizYourAnswer}
                  className="mt-4 h-11 rounded-lg border-slate-200 text-sm text-slate-700 placeholder:text-slate-400 focus-visible:border-emerald-400 focus-visible:ring-emerald-400/40"
                />
              ) : (
                <div className="mt-4 space-y-2">
                  {(q.type === 'truefalse'
                    ? [d.quizTrue, d.quizFalse]
                    : (q.options ?? [])
                  ).map((opt, oi) => {
                    const selected = given === oi;
                    return (
                      <button
                        key={oi}
                        type="button"
                        onClick={() => setAnswer(oi)}
                        aria-pressed={selected}
                        className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm transition ${
                          selected
                            ? 'border-emerald-500 bg-emerald-50 text-emerald-900'
                            : 'border-slate-200 bg-white text-slate-700 hover:border-emerald-300'
                        }`}
                      >
                        <span
                          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                            selected
                              ? 'border-emerald-500 bg-emerald-600 text-white'
                              : 'border-slate-300 text-slate-500'
                          }`}
                          aria-hidden="true"
                        >
                          {LETTERS[oi] ?? oi + 1}
                        </span>
                        <span className="min-w-0 flex-1">{opt}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}

        {/* Footer nav */}
        <div className="mt-6 flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <Button
            variant="outline"
            onClick={goPrev}
            disabled={session.idx === 0}
            className="h-10 rounded-lg text-sm"
          >
            {d.quizPrev}
          </Button>
          {session.idx < session.quiz.questions.length - 1 ? (
            <Button
              onClick={goNext}
              className="h-10 rounded-lg bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-700"
            >
              {d.quizNext}
            </Button>
          ) : (
            <Button
              onClick={() => void submit()}
              disabled={submitting}
              className="h-10 rounded-lg bg-emerald-600 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-70"
            >
              {submitting && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {d.quizSubmitAnswers}
            </Button>
          )}
        </div>
      </div>
    </section>
  ) : null;

  /* ── Result card (score + review) ───────────────────────────── */
  const ResultCard = result ? (
    <section
      aria-live="polite"
      className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="flex flex-col items-center gap-5 border-b border-slate-100 p-5 text-center sm:flex-row sm:items-center sm:p-6 sm:text-left">
        <div
          className="relative h-24 w-24 shrink-0 rounded-full"
          style={{
            background: `conic-gradient(${TONE_HEX[scoreTone(result.scorePct)]} ${result.scorePct * 3.6}deg, #e2e8f0 0deg)`,
          }}
          role="img"
          aria-label={`${result.scorePct}%`}
        >
          <div className="absolute inset-[7px] flex items-center justify-center rounded-full bg-white">
            <span className="text-xl font-bold tabular-nums text-slate-900">
              {result.scorePct}%
            </span>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-slate-900">
            {attemptTitle(result.subjectName)}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-sm text-slate-500 sm:justify-start">
            <span className={`font-semibold ${TONE_TEXT[scoreTone(result.scorePct)]}`}>
              {d.quizScoreCorrectOf(result.correct, result.total)}
            </span>
            <span aria-hidden="true">·</span>
            <DifficultyBadge
              value={result.difficulty}
              label={diffLabel(result.difficulty)}
            />
            <span aria-hidden="true">·</span>
            <span>{formatDate(result.createdAt)}</span>
          </div>
          {result.subjectName && (
            <p className="mt-1 text-xs text-slate-400">
              {result.subjectName}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          onClick={() => setResult(null)}
          className="h-9 shrink-0 rounded-lg text-sm"
        >
          {d.quizBackToBuilder}
        </Button>
      </div>

      <div className="p-5 sm:p-6">
        <h3 className="text-sm font-semibold uppercase tracking-[0.08em] text-slate-500">
          {d.quizReviewTitle}
        </h3>
        <ReviewList review={result.review} />
      </div>
    </section>
  ) : null;

  /* ── Page ───────────────────────────────────────────────────── */
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      {/* Header */}
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
        {d.quizTitle}
      </h1>
      <p className="mt-1.5 text-sm text-slate-500">{d.quizSubtitle}</p>

      {/* Config card — 1:1 with the screenshot */}
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label
              htmlFor="quiz-subject"
              className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500"
            >
              {d.quizSubjectLabel}
            </Label>
            <Select
              value={subjectId}
              onValueChange={setSubjectId}
              disabled={generating}
            >
              <SelectTrigger
                id="quiz-subject"
                aria-label={d.quizSubjectLabel}
                className="h-10 w-full rounded-lg border-slate-200 text-sm text-slate-700"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-64 rounded-xl border-slate-200">
                <SelectItem value="none">{d.quizNoSubject}</SelectItem>
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
              htmlFor="quiz-count"
              className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500"
            >
              {d.quizQuestionsLabel}
            </Label>
            <Select
              value={String(count)}
              onValueChange={(v) => setCount(Number(v))}
              disabled={generating}
            >
              <SelectTrigger
                id="quiz-count"
                aria-label={d.quizQuestionsLabel}
                className="h-10 w-full rounded-lg border-slate-200 text-sm text-slate-700"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-64 rounded-xl border-slate-200">
                {QUESTION_COUNTS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {d.quizQuestionsCount(n)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Subject status line — mirrors the screenshot's orange helper */}
        <p
          className={`mt-3 flex items-center gap-1.5 text-sm ${
            subject && subjectDocs.length > 0
              ? 'text-emerald-700'
              : 'text-orange-600'
          }`}
        >
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              subject && subjectDocs.length > 0
                ? 'bg-emerald-500'
                : 'bg-orange-500'
            }`}
            aria-hidden="true"
          />
          {!subject
            ? d.quizNoSubjectWarn
            : subjectDocs.length > 0
              ? d.quizContextDocs(subject.name, subjectDocs.length)
              : d.quizNoDocsWarn(subject.name)}
        </p>

        {/* Question types — multi-select chips */}
        <div className="mt-5">
          <Label
            htmlFor="quiz-types"
            className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500"
          >
            {d.quizTypesLabel}
          </Label>
          <div
            id="quiz-types"
            role="group"
            aria-label={d.quizTypesLabel}
            className="mt-2 flex flex-wrap gap-2"
          >
            {TYPE_IDS.map((id) => {
              const active = types.includes(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() =>
                    setTypes((prev) =>
                      prev.includes(id)
                        ? prev.filter((x) => x !== id)
                        : [...prev, id]
                    )
                  }
                  aria-pressed={active}
                  disabled={generating}
                  className={`inline-flex h-9 items-center rounded-full border px-3.5 text-sm font-medium transition disabled:cursor-not-allowed ${
                    active
                      ? 'border-emerald-600 bg-emerald-600 text-white shadow-sm'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300 hover:text-emerald-700'
                  }`}
                >
                  {typeLabel(id)}
                </button>
              );
            })}
          </div>
        </div>

        {/* Difficulty — single-select chips */}
        <div className="mt-5">
          <Label
            htmlFor="quiz-difficulty"
            className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500"
          >
            {d.quizDifficultyLabel}
          </Label>
          <div
            id="quiz-difficulty"
            role="group"
            aria-label={d.quizDifficultyLabel}
            className="mt-2 flex flex-wrap gap-2"
          >
            {DIFFICULTY_IDS.map((id) => {
              const active = difficulty === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setDifficulty(id)}
                  aria-pressed={active}
                  disabled={generating}
                  className={`inline-flex h-9 items-center rounded-full border px-3.5 text-sm font-medium transition disabled:cursor-not-allowed ${
                    active
                      ? 'border-amber-400 bg-amber-50 text-amber-700 shadow-sm'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-amber-300 hover:text-amber-700'
                  }`}
                >
                  {diffLabel(id)}
                </button>
              );
            })}
          </div>
        </div>

        <Button
          onClick={() => void generate()}
          disabled={generating || !!session}
          className="mt-5 h-10 gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 disabled:opacity-70"
        >
          {generating ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          )}
          {generating ? d.quizGenerating : d.quizGenerate}
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
              {d.quizGeneratingTitle}
            </p>
            <p className="mt-0.5 text-sm text-slate-500">
              {d.quizGeneratingDesc}
            </p>
          </div>
        </section>
      )}

      {/* Active quiz / Result */}
      {!generating && SessionCard}
      {!generating && !session && ResultCard}

      {/* Empty state — nothing generated/opened yet and no history */}
      {!generating &&
        !session &&
        !result &&
        attemptsFull.length === 0 &&
        !historyLoading && (
        <div className="mt-12 flex flex-col items-center pb-4 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-100 text-slate-400">
            <HelpCircle className="h-7 w-7" aria-hidden="true" />
          </span>
          <h2 className="mt-5 text-base font-semibold text-slate-800">
            {d.quizEmptyTitle}
          </h2>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">
            {d.quizEmptyDesc}
          </p>
        </div>
      )}

      {/* Recent attempts */}
      <section className="mt-8 pb-10" aria-label={d.quizRecent}>
        <h2 className="flex items-center gap-2 text-base font-semibold text-slate-800">
          <History className="h-4 w-4 text-slate-400" aria-hidden="true" />
          {d.quizRecent}
        </h2>
        {historyLoading ? (
          <div className="mt-3 flex items-center justify-center rounded-xl border border-slate-200 bg-white py-8 text-slate-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : attemptsFull.length === 0 ? (
          <div className="mt-3 flex flex-col items-center rounded-2xl border-2 border-dashed border-slate-300 px-6 py-10 text-center">
            <p className="text-sm text-slate-500">{d.quizEmptyTitle}</p>
            <p className="mt-1 text-sm text-slate-400">{d.quizEmptyDesc}</p>
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
            {attemptsFull.map((a) => {
              const tone = scoreTone(a.scorePct);
              return (
                <li
                  key={a.id}
                  className="flex items-center gap-3 px-4 py-3.5 sm:px-5"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${TONE_BG[tone]}`}
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    onClick={() => viewAttempt(a)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-sm font-semibold text-slate-800">
                      {attemptTitle(a.subjectName)}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {a.subjectName ? `${a.subjectName} · ` : ''}
                      {d.quizScoreCorrectOf(a.correct, a.total)} ·{' '}
                      {formatDate(a.createdAt)}
                    </span>
                  </button>
                  <DifficultyBadge
                    value={a.difficulty}
                    label={diffLabel(a.difficulty)}
                  />
                  <span
                    className={`shrink-0 text-sm font-bold tabular-nums ${TONE_TEXT[tone]}`}
                  >
                    {a.scorePct}%
                  </span>
                  <button
                    type="button"
                    onClick={() => void deleteAttempt(a.id)}
                    aria-label={d.quizDelete}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
