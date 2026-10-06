'use client';

/**
 * Easy Explanation — "Topic Explainer" section, 1:1 with the design
 * screenshot: the amber Lightbulb + "Topic Explainer" header, and a
 * config card holding the TOPIC input, the SUBJECT CONTEXT (OPTIONAL)
 * select ("No context (general)" + the user's subjects), the EXPLANATION
 * STYLE select synced with the four quick style pills (Like a Teacher /
 * Like a 10-year-old / With Examples / Step by Step) and the full-width
 * amber "Explain Topic" button. Below: the light "Ready to explain"
 * empty state with one-tap example topics.
 *
 * Fully functional: POST /api/explanations generates a real AI
 * explanation — when a subject is chosen, the text of that subject's
 * uploaded PDFs is extracted server-side and used as the primary
 * context. The structured result (intro + sections + key takeaways) is
 * persisted in SQLite, shown in a result card (copy / delete), and
 * every past explanation is listed under "Recent explanations".
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Copy,
  Lightbulb,
  ListOrdered,
  Loader2,
  PenLine,
  Smile,
  Sparkles,
  Trash2,
  type LucideIcon,
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
import { CHIP_STYLES, type Subject } from '@/components/dashboard/subject-styles';
import type { Pdf } from '@/components/dashboard/pdf-utils';
import { formatDate } from '@/components/dashboard/pdf-utils';

type StyleId = 'teacher' | 'kid' | 'examples' | 'steps';

const STYLE_IDS: StyleId[] = ['teacher', 'kid', 'examples', 'steps'];

type ExplanationSection = { heading: string; text: string };

export type ExplanationItem = {
  id: string;
  topic: string;
  subjectId: string | null;
  subjectName: string;
  style: string;
  title: string;
  content: {
    intro: string;
    sections: ExplanationSection[];
    takeaways: string[];
  };
  createdAt: string;
};

export default function ExplanationView({
  email,
  subjects,
  pdfs,
}: {
  email: string;
  subjects: Subject[];
  pdfs: Pdf[];
}) {
  const { toast } = useToast();
  const { t, lang } = useLanguage();
  const d = t.dashboard;

  /* ── State ──────────────────────────────────────────────────── */
  const [topic, setTopic] = useState('');
  const [subjectId, setSubjectId] = useState('none');
  const [style, setStyle] = useState<StyleId>('teacher');
  const [generating, setGenerating] = useState(false);
  const [explanations, setExplanations] = useState<ExplanationItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [current, setCurrent] = useState<ExplanationItem | null>(null);

  const topicRef = useRef<HTMLInputElement>(null);

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

  const styleMeta: Record<StyleId, { label: string; icon: LucideIcon }> = {
    teacher: { label: d.exStyleTeacher, icon: BookOpen },
    kid: { label: d.exStyleKid, icon: Smile },
    examples: { label: d.exStyleExamples, icon: PenLine },
    steps: { label: d.exStyleSteps, icon: ListOrdered },
  };
  const styleIconColor: Record<StyleId, string> = {
    teacher: '',
    kid: 'text-orange-500',
    examples: 'text-teal-600',
    steps: 'text-violet-500',
  };

  const styleLabel = (id: string): string =>
    (STYLE_IDS as string[]).includes(id)
      ? styleMeta[id as StyleId].label
      : id;

  /* ── Load the saved explanations once ───────────────────────── */
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/explanations?email=${encodeURIComponent(email)}`)
      .then(async (res) => ({ res, data: await res.json().catch(() => null) }))
      .then(({ res, data }) => {
        if (cancelled) return;
        if (res.ok && data?.ok) {
          setExplanations(data.explanations as ExplanationItem[]);
        } else {
          toast({ title: d.exLoadFailed, variant: 'destructive' });
        }
      })
      .catch(() => {
        if (!cancelled) {
          toast({ title: d.exLoadFailed, variant: 'destructive' });
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [email, d.exLoadFailed, toast]);

  /* ── Generate ───────────────────────────────────────────────── */
  const generate = async () => {
    const cleanTopic = topic.trim();
    if (!cleanTopic) {
      toast({ title: d.exTopicRequired });
      topicRef.current?.focus();
      return;
    }
    if (generating) return;
    setGenerating(true);
    try {
      const res = await fetch('/api/explanations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          topic: cleanTopic,
          subjectId: subjectId === 'none' ? undefined : subjectId,
          style,
          lang,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        const explanation = data.explanation as ExplanationItem;
        setCurrent(explanation);
        setExplanations((prev) => [explanation, ...prev]);
      } else {
        toast({
          title: aiErrorTitle(data, d.exGenerateFailed, d.aiNotConfigured),
          variant: 'destructive',
        });
      }
    } catch {
      toast({ title: d.exGenerateFailed, variant: 'destructive' });
    } finally {
      setGenerating(false);
    }
  };

  /* ── Copy the displayed explanation as plain text ───────────── */
  const copyCurrent = async () => {
    if (!current) return;
    const plain = [
      current.title,
      current.content.intro,
      ...current.content.sections.map((s) =>
        [s.heading, s.text].filter(Boolean).join('\n')
      ),
      current.content.takeaways.length > 0
        ? `${d.exKeyTakeaways}\n${current.content.takeaways
            .map((k) => `\u2022 ${k}`)
            .join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(plain);
      toast({ title: d.exCopied });
    } catch {
      toast({ title: d.exCopied });
    }
  };

  /* ── Delete a saved explanation ─────────────────────────────── */
  const deleteExplanation = async (id: string) => {
    const snapshot = explanations;
    setExplanations((prev) => prev.filter((e) => e.id !== id));
    if (current?.id === id) setCurrent(null);
    try {
      const res = await fetch(
        `/api/explanations?email=${encodeURIComponent(email)}&id=${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error('failed');
      toast({ title: d.exDeleted });
    } catch {
      setExplanations(snapshot); // restore on failure
      toast({ title: d.exLoadFailed, variant: 'destructive' });
    }
  };

  /* ── Suggestion topics (empty state) ────────────────────────── */
  const suggestions: string[] = [
    d.exSug1,
    d.exSug2,
    d.exSug3,
    d.exSug4,
    d.exSug5,
  ];

  const pickSuggestion = (value: string) => {
    setTopic(value);
    topicRef.current?.focus();
  };

  /* ── Result card ────────────────────────────────────────────── */
  const ResultCard = current ? (
    <section
      aria-live="polite"
      className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
    >
      <div className="flex items-start gap-3.5 border-b border-slate-100 p-5 sm:p-6">
        <span
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${CHIP_STYLES['amber']}`}
        >
          <Lightbulb className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-snug text-slate-900">
            {current.title}
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-400">
            <span className="truncate">{current.topic}</span>
            <span aria-hidden="true">·</span>
            <span>{styleLabel(current.style)}</span>
            {current.subjectName && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{current.subjectName}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span>{formatDate(current.createdAt)}</span>
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
            onClick={() => void deleteExplanation(current.id)}
            aria-label={d.exDelete}
            className="h-8 w-8 rounded-lg p-0 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="p-5 sm:p-6">
        {current.content.intro && (
          <p className="text-sm leading-relaxed text-slate-600">
            {current.content.intro}
          </p>
        )}
        <div
          className={`space-y-5 ${current.content.intro ? 'mt-5' : ''}`}
        >
          {current.content.sections.map((sec, i) => (
            <div key={i}>
              {sec.heading && (
                <h3 className="text-sm font-semibold text-slate-800">
                  {sec.heading}
                </h3>
              )}
              {sec.text && (
                <p
                  className={`text-sm leading-relaxed text-slate-600 ${
                    sec.heading ? 'mt-1.5' : ''
                  }`}
                >
                  {sec.text}
                </p>
              )}
            </div>
          ))}
        </div>
        {current.content.takeaways.length > 0 && (
          <div className="mt-6 rounded-xl bg-amber-50/70 p-4">
            <h3 className="text-sm font-semibold text-slate-800">
              {d.exKeyTakeaways}
            </h3>
            <ul className="mt-2.5 space-y-1.5">
              {current.content.takeaways.map((k, j) => (
                <li
                  key={j}
                  className="flex items-start gap-2 text-sm leading-relaxed text-slate-600"
                >
                  <span
                    className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                    aria-hidden="true"
                  />
                  <span className="min-w-0">{k}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
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
      <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight sm:text-3xl">
        <Lightbulb
          className="h-7 w-7 shrink-0 text-amber-400"
          aria-hidden="true"
        />
        {d.exTitle}
      </h1>
      <p className="mt-1.5 text-sm text-slate-500">{d.exSubtitle}</p>

      {/* Config card — 1:1 with the screenshot */}
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-6">
        <div className="space-y-1.5">
          <Label
            htmlFor="ex-topic"
            className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500"
          >
            {d.exTopicLabel}
          </Label>
          <Input
            ref={topicRef}
            id="ex-topic"
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void generate();
              }
            }}
            placeholder={d.exTopicPlaceholder}
            aria-label={d.exTopicLabel}
            disabled={generating}
            className="h-10 rounded-lg border-slate-200 text-sm text-slate-700 placeholder:text-slate-400 focus-visible:ring-amber-400/40 focus-visible:border-amber-400"
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label
              htmlFor="ex-subject"
              className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500"
            >
              {d.exContextLabel}
            </Label>
            <Select
              value={subjectId}
              onValueChange={setSubjectId}
              disabled={generating}
            >
              <SelectTrigger
                id="ex-subject"
                aria-label={d.exContextLabel}
                className="h-10 w-full rounded-lg border-slate-200 text-sm text-slate-700"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-64 rounded-xl border-slate-200">
                <SelectItem value="none">{d.exNoContext}</SelectItem>
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
              htmlFor="ex-style"
              className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500"
            >
              {d.exStyleLabel}
            </Label>
            <Select
              value={style}
              onValueChange={(v) => setStyle(v as StyleId)}
              disabled={generating}
            >
              <SelectTrigger
                id="ex-style"
                aria-label={d.exStyleLabel}
                className="h-10 w-full rounded-lg border-slate-200 text-sm text-slate-700"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-64 rounded-xl border-slate-200">
                {STYLE_IDS.map((id) => (
                  <SelectItem key={id} value={id}>
                    {styleMeta[id].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Quick style pills — synced with the EXPLANATION STYLE select */}
        <div
          role="group"
          aria-label={d.exStyleLabel}
          className="mt-4 flex flex-wrap gap-2"
        >
          {STYLE_IDS.map((id) => {
            const active = style === id;
            const Icon = styleMeta[id].icon;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setStyle(id)}
                aria-pressed={active}
                disabled={generating}
                className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition disabled:cursor-not-allowed ${
                  active
                    ? 'border-amber-500 bg-amber-500 text-white shadow-sm'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-amber-300 hover:text-amber-700'
                }`}
              >
                <Icon
                  className={`h-3.5 w-3.5 shrink-0 ${
                    active ? '' : styleIconColor[id]
                  }`}
                  aria-hidden="true"
                />
                {styleMeta[id].label}
              </button>
            );
          })}
        </div>

        {/* Subject-context status line (only when a subject adds value) */}
        {subject && subjectDocs.length > 0 && (
          <p className="mt-4 flex items-center gap-1.5 text-sm text-emerald-700">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
              aria-hidden="true"
            />
            {d.sumContextLine(subject.name, subjectDocs.length)}
          </p>
        )}

        <Button
          onClick={() => void generate()}
          disabled={generating}
          className="mt-5 h-11 w-full gap-2 rounded-lg bg-amber-400 text-sm font-medium text-white shadow-sm hover:bg-amber-500 disabled:opacity-70"
        >
          {generating ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          )}
          {generating ? d.exExplaining : d.exButton}
        </Button>
      </section>

      {/* Generating placeholder */}
      {generating && (
        <section
          aria-live="polite"
          className="mt-6 flex items-center gap-3.5 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-6"
        >
          <Loader2
            className="h-5 w-5 shrink-0 animate-spin text-amber-500"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-700">
              {d.exGeneratingTitle}
            </p>
            <p className="mt-0.5 text-sm text-slate-500">
              {d.exGeneratingDesc}
            </p>
          </div>
        </section>
      )}

      {/* Result */}
      {!generating && ResultCard}

      {/* Empty state — nothing generated/opened yet */}
      {!generating && !current && (
        <div className="mt-12 flex flex-col items-center pb-10 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-100 text-slate-400">
            <Lightbulb className="h-7 w-7" aria-hidden="true" />
          </span>
          <h2 className="mt-5 text-base font-semibold text-slate-800">
            {d.exEmptyTitle}
          </h2>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">
            {d.exEmptyDesc}
          </p>
          <div className="mt-5 flex max-w-xl flex-wrap justify-center gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => pickSuggestion(s)}
                className="rounded-lg border border-slate-200 bg-white px-3.5 py-1.5 text-sm text-slate-600 transition hover:border-amber-300 hover:text-amber-700"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Recent explanations */}
      {explanations.length > 0 && (
        <section className="mt-8 pb-10" aria-label={d.exHistory}>
          <h2 className="text-base font-semibold text-slate-800">
            {d.exHistory}
          </h2>
          {historyLoading ? (
            <div className="mt-3 flex items-center justify-center rounded-xl border border-slate-200 bg-white py-8 text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <ul className="scrollbar-thin mt-3 max-h-96 space-y-2.5 overflow-y-auto pr-1">
              {explanations.map((e) => (
                <li
                  key={e.id}
                  className={`flex items-center gap-2 rounded-xl border bg-white px-4 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition ${
                    current?.id === e.id
                      ? 'border-amber-300'
                      : 'border-slate-200 hover:border-amber-200'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setCurrent(e);
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${CHIP_STYLES['amber']}`}
                    >
                      <Lightbulb className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-slate-800">
                        {e.title}
                      </span>
                      <span className="block truncate text-xs text-slate-400">
                        {e.topic} · {styleLabel(e.style)} ·{' '}
                        {formatDate(e.createdAt)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteExplanation(e.id)}
                    aria-label={d.exDelete}
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
    </div>
  );
}
