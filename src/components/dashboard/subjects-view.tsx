'use client';

/**
 * Subjects section page — "My Subjects" header with an emerald
 * "+ New Subject" button, and a large dashed empty state ("No subjects
 * yet") that invites the first creation. Once subjects exist they render
 * as a card grid in the same style as the Dashboard overview.
 *
 * Fully functional: every card shows the REAL number of PDFs filed under
 * the subject, clicking a card opens the PDF Library filtered to that
 * subject, and a kebab menu offers Rename / Delete (dialogs live in the
 * parent dashboard so state stays in one place).
 */

import { BookOpen, Loader2, MoreVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLanguage } from '@/lib/i18n';
import {
  CHIP_STYLES,
  type Subject,
} from '@/components/dashboard/subject-styles';
import type { Pdf } from '@/components/dashboard/pdf-utils';

export default function SubjectsView({
  subjects,
  loading,
  pdfs,
  onNewSubject,
  onOpenSubject,
  onRenameSubject,
  onDeleteSubject,
}: {
  subjects: Subject[];
  loading: boolean;
  /** All of the user's PDFs — cards count the ones filed per subject. */
  pdfs: Pdf[];
  /** Opens the shared create-subject dialog. */
  onNewSubject: () => void;
  /** Opens the PDF Library filtered to this subject. */
  onOpenSubject: (subject: Subject) => void;
  /** Opens the shared rename dialog for this subject. */
  onRenameSubject: (subject: Subject) => void;
  /** Opens the shared delete confirmation for this subject. */
  onDeleteSubject: (subject: Subject) => void;
}) {
  const { t } = useLanguage();
  const d = t.dashboard;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      {/* Page header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {d.mySubjects}
          </h1>
          <p className="mt-1.5 text-sm text-slate-500">{d.mySubjectsDesc}</p>
        </div>
        <Button
          onClick={onNewSubject}
          className="h-9 rounded-lg bg-emerald-600 px-3.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-700"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {d.newSubject}
        </Button>
      </div>

      {loading ? (
        <div className="mt-8 flex items-center justify-center rounded-xl border-2 border-dashed border-slate-200 py-16 text-slate-400 sm:py-20">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        </div>
      ) : subjects.length === 0 ? (
        /* Empty state — matches the design exactly */
        <div className="mt-8 flex flex-col items-center rounded-xl border-2 border-dashed border-slate-200 px-6 py-16 text-center sm:py-20">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
            <BookOpen className="h-7 w-7" aria-hidden="true" />
          </span>
          <h2 className="mt-6 text-base font-semibold text-slate-800">
            {d.noSubjectsYet}
          </h2>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">
            {d.noSubjectsDesc}
          </p>
          <Button
            onClick={onNewSubject}
            className="mt-6 h-9 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {d.createSubject}
          </Button>
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {subjects.map((s) => {
            const pdfCount = pdfs.filter((p) => p.subjectName === s.name).length;
            return (
              <div
                key={s.id}
                className="group relative flex items-center gap-3.5 rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition hover:border-emerald-200 hover:shadow-md"
              >
                {/* Card body = open the subject's materials */}
                <button
                  type="button"
                  onClick={() => onOpenSubject(s)}
                  className="flex min-w-0 flex-1 items-center gap-3.5 text-left"
                  aria-label={s.name}
                >
                  <span
                    className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${CHIP_STYLES[s.color]}`}
                  >
                    <BookOpen className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-slate-800">
                      {s.name}
                    </span>
                    <span className="block text-xs text-slate-400">
                      {d.subjectPdfs(pdfCount)} ·{' '}
                      {new Date(s.createdAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </span>
                </button>

                {/* Kebab — rename / delete */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={d.subjectActions}
                      className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                    >
                      <MoreVertical className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem onClick={() => onRenameSubject(s)}>
                      <Pencil
                        className="h-4 w-4 text-slate-500"
                        aria-hidden="true"
                      />
                      {d.renameSubject}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => onDeleteSubject(s)}
                      className="text-rose-600 focus:bg-rose-50 focus:text-rose-700"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                      {d.deleteSubject}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
