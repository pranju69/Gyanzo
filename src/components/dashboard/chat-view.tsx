'use client';

/**
 * AI Study Chat section — 1:1 with the design screenshot: an "AI Study
 * Chat" header, a subject selector with the orange "no document context"
 * warning, the centered "Start a conversation" empty state with four
 * suggestion chips, the "Ask anything..." input with a round send button,
 * and the disclaimer line.
 *
 * Fully functional: real AI answers come from POST /api/chat (LLM via the
 * backend SDK). Selecting a subject switches to that subject's persisted
 * conversation and gives the model document context extracted from the
 * PDFs uploaded for that subject. History lives in SQLite per scope, so
 * the chat survives navigation and reloads.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, MessageSquare, Send, TriangleAlert } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/lib/i18n';
import { aiErrorTitle } from '@/lib/ai-error';
import { playAiSound } from '@/lib/tts';
import type { Subject } from '@/components/dashboard/subject-styles';
import type { Pdf } from '@/components/dashboard/pdf-utils';

export type ChatMsg = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

const NO_SUBJECT = 'none';

export default function ChatView({
  email,
  subjects,
  pdfs,
}: {
  email: string;
  subjects: Subject[];
  pdfs: Pdf[];
}) {
  const { toast } = useToast();
  const { t } = useLanguage();
  const d = t.dashboard;

  /* ── State ──────────────────────────────────────────────────── */
  const [subjectId, setSubjectId] = useState(NO_SUBJECT);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* ── Context line for the selected subject ──────────────────── */
  const subject = useMemo(
    () => subjects.find((s) => s.id === subjectId) ?? null,
    [subjects, subjectId]
  );
  const docCount = useMemo(
    () =>
      subject ? pdfs.filter((p) => p.subjectName === subject.name).length : 0,
    [pdfs, subject]
  );

  /* ── Load the conversation for the selected scope ───────────── */
  // All setState calls live in async continuations (never synchronously
  // inside the effect) to keep the react-hooks lint rule happy; the
  // loading flag is reset from the Select's onValueChange handler.
  useEffect(() => {
    let cancelled = false;
    const scope = subjectId === NO_SUBJECT ? '' : subjectId;
    fetch(
      `/api/chat?email=${encodeURIComponent(email)}&subjectId=${encodeURIComponent(scope)}`
    )
      .then(async (res) => ({ res, data: await res.json().catch(() => null) }))
      .then(({ res, data }) => {
        if (cancelled) return;
        if (res.ok && data?.ok) {
          setMessages(data.messages as ChatMsg[]);
        } else {
          toast({ title: d.aiChatLoadFailed, variant: 'destructive' });
        }
      })
      .catch(() => {
        if (!cancelled) {
          toast({ title: d.aiChatLoadFailed, variant: 'destructive' });
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [email, subjectId, d.aiChatLoadFailed, toast]);

  /* ── Keep the newest message in view ────────────────────────── */
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, historyLoading]);

  /* ── Send a message ─────────────────────────────────────────── */
  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || sending) return;

    setInput('');
    const optimistic: ChatMsg = {
      id: `tmp-${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setSending(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          subjectId: subjectId === NO_SUBJECT ? undefined : subjectId,
          message: text,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== optimistic.id),
          data.userMessage as ChatMsg,
          data.reply as ChatMsg,
        ]);
        // Settings → Notifications → AI Response Sound
        playAiSound(email);
      } else {
        setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
        setInput(text); // restore so the question can be retried
        toast({
          title: aiErrorTitle(
            data,
            d.aiChatSendFailed,
            d.aiNotConfigured,
            d.aiChatRateLimited
          ),
          variant: 'destructive',
        });
      }
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
      setInput(text);
      toast({ title: d.aiChatSendFailed, variant: 'destructive' });
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const pickSubject = (value: string) => {
    setSubjectId(value);
    setHistoryLoading(true);
  };

  const suggestions = [
    d.aiChatSug1,
    d.aiChatSug2,
    d.aiChatSug3,
    d.aiChatSug4,
  ];

  /* ── Message bubbles ────────────────────────────────────────── */
  const EmptyState = (
    <div className="flex h-full flex-col items-center justify-center px-4 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
        <Bot className="h-7 w-7" aria-hidden="true" />
      </span>
      <h2 className="mt-6 text-lg font-semibold text-slate-800 sm:text-xl">
        {d.aiChatStartTitle}
      </h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">
        {d.aiChatStartDesc}
      </p>
      <div className="mt-7 flex w-full max-w-[340px] flex-col gap-3">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => void send(s)}
            disabled={sending}
            className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-left text-sm text-slate-600 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition hover:border-emerald-300 hover:bg-emerald-50/40 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="mx-auto flex h-[calc(100dvh-3.5rem)] w-full max-w-5xl flex-col px-4 py-6 sm:px-6 lg:h-[calc(100dvh-4rem)] lg:px-8">
      {/* Page header */}
      <div className="flex items-center gap-3.5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
          <MessageSquare className="h-5 w-5" aria-hidden="true" />
        </span>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          {d.aiChatTitle}
        </h1>
      </div>

      {/* Subject selector + context status */}
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <Select value={subjectId} onValueChange={pickSubject}>
          <SelectTrigger
            aria-label={d.aiChatNoSubject}
            className="h-10 w-full rounded-lg border-slate-200 text-sm text-slate-700 sm:w-64"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-64 rounded-xl border-slate-200">
            <SelectItem value={NO_SUBJECT}>{d.aiChatNoSubject}</SelectItem>
            {subjects.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {subject ? (
          <p className="flex min-w-0 items-center gap-1.5 text-sm text-emerald-700">
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
              aria-hidden="true"
            />
            <span className="truncate">
              {docCount > 0
                ? d.aiChatSubjectContext(subject.name, docCount)
                : d.aiChatSubjectNoDocs(subject.name)}
            </span>
          </p>
        ) : (
          <p className="flex items-center gap-1.5 text-sm font-medium text-orange-600">
            <TriangleAlert
              className="h-4 w-4 shrink-0 text-orange-500"
              aria-hidden="true"
            />
            {d.aiChatNoSubjectWarn}
          </p>
        )}
      </div>

      <div className="mt-5 border-t border-slate-200/80" aria-hidden="true" />

      {/* Conversation */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto scrollbar-thin"
        aria-live="polite"
      >
        {historyLoading ? (
          <div className="flex h-full items-center justify-center">
            <span className="flex gap-1.5" role="status">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-2 w-2 animate-bounce rounded-full bg-emerald-400"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </span>
          </div>
        ) : messages.length === 0 && !sending ? (
          EmptyState
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 py-6">
            {messages.map((m) =>
              m.role === 'user' ? (
                <div key={m.id} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-emerald-600 px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm sm:max-w-[75%]">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="flex items-start gap-2.5">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                    <Bot className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tl-md border border-slate-200 bg-white px-4 py-2.5 text-sm leading-relaxed text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:max-w-[75%]">
                    {m.content}
                  </div>
                </div>
              )
            )}

            {/* Typing indicator while the AI thinks */}
            {sending && (
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                  <Bot className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="flex items-center gap-1.5 rounded-2xl rounded-tl-md border border-slate-200 bg-white px-4 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                  <span className="flex gap-1" role="status" aria-label={d.aiChatSend}>
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-400"
                        style={{ animationDelay: `${i * 150}ms` }}
                      />
                    ))}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="flex items-center gap-3 pt-2"
      >
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={d.aiChatAskPlaceholder}
          aria-label={d.aiChatAskPlaceholder}
          maxLength={4000}
          autoComplete="off"
          className="h-12 flex-1 rounded-xl border border-slate-200 bg-white px-4 text-sm text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] placeholder:text-slate-400 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
        />
        <button
          type="submit"
          aria-label={d.aiChatSend}
          disabled={!input.trim() || sending}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Send className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
      </form>

      {/* Disclaimer */}
      <p className="pb-1 pt-3 text-center text-xs text-slate-400">
        {d.aiChatDisclaimer}
      </p>
    </div>
  );
}
