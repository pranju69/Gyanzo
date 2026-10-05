'use client';

/**
 * PDF Library section — 1:1 with the design screenshot:
 * "PDF Library" header with an emerald "Upload PDF" button, an
 * "All subjects" filter + "Search by file name..." row, and a documents
 * table (DOCUMENT / SUBJECT / STATUS / ACTIONS). Fully functional: real
 * uploads (stored on disk + SQLite), inline view, download, rename and
 * delete. On mobile the table rows collapse into stacked cards.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  Eye,
  FileText,
  Loader2,
  Pencil,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import PdfSummaryDialog from '@/components/dashboard/pdf-summary-dialog';
import {
  formatDate,
  formatBytes,
  MAX_PDF_BYTES,
  type Pdf,
  type PdfStorageMode,
} from '@/components/dashboard/pdf-utils';
import { upload as blobUpload } from '@vercel/blob/client';
import type { Subject } from '@/components/dashboard/subject-styles';

export default function PdfLibraryView({
  email,
  subjects,
  pdfs,
  loading,
  storage = 'disk',
  onPdfsChanged,
  initialSubject,
  initialSubjectNonce = 0,
}: {
  email: string;
  subjects: Subject[];
  pdfs: Pdf[];
  loading: boolean;
  /** Server-reported storage backend — picks the upload strategy. */
  storage?: PdfStorageMode;
  /** Ask the parent to reload the PDF list (after any mutation). */
  onPdfsChanged: () => void;
  /** Pre-select this subject in the filter (set when navigating from
      the Subjects page). Empty/undefined = keep "All subjects". */
  initialSubject?: string;
  /** Bumped by the parent on every navigation so clicking the SAME
      subject twice re-applies the filter after a manual change. */
  initialSubjectNonce?: number;
}) {
  const { toast } = useToast();
  const { t } = useLanguage();
  const d = t.dashboard;

  /* ── Filtering ──────────────────────────────────────────────── */
  const [filterSubject, setFilterSubject] = useState('all');
  const [search, setSearch] = useState('');

  /* Navigation from the Subjects page re-applies the pre-selected
     subject (the nonce re-fires this even when the SAME subject is
     picked again after a manual filter change). */
  useEffect(() => {
    if (initialSubject) setFilterSubject(initialSubject);
  }, [initialSubject, initialSubjectNonce]);

  const visiblePdfs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return pdfs.filter((p) => {
      if (filterSubject !== 'all' && p.subjectName !== filterSubject) {
        return false;
      }
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [pdfs, filterSubject, search]);

  /* ── Upload dialog state ────────────────────────────────────── */
  const [uploadOpen, setUploadOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState(false);
  const [uploadSubject, setUploadSubject] = useState('none');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const openUpload = () => {
    setFile(null);
    setFileError(false);
    /* Pre-select the subject when the user has exactly one, so a PDF
       uploaded "to that subject" is actually linked to it and the Quiz,
       Flashcards and Revision Notes features can learn from it. */
    setUploadSubject(subjects.length === 1 ? subjects[0].name : 'none');
    setUploading(false);
    setUploadOpen(true);
  };

  const pickFile = (f: File | null) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.pdf')) {
      toast({ title: d.uploadErrPdfOnly, variant: 'destructive' });
      return;
    }
    if (f.size > MAX_PDF_BYTES) {
      toast({ title: d.uploadErrTooBig, variant: 'destructive' });
      return;
    }
    setFileError(false);
    setFile(f);
  };

  const handleUpload = async () => {
    if (!file) {
      setFileError(true);
      toast({ title: d.uploadErrNone, variant: 'destructive' });
      return;
    }
    if (uploading) return;
    setUploading(true);
    try {
      const subjectField = uploadSubject === 'none' ? '' : uploadSubject;

      if (storage === 'blob') {
        /* Vercel: upload DIRECTLY from the browser to the Blob store.
           Bypasses the ~4.5 MB serverless request-body limit entirely, so
           textbook-sized PDFs (hundreds of MB) work. The row is then
           registered server-side with ownership verification. */
        const pathname = `pdfs/${crypto.randomUUID()}.pdf`;
        const blob = await blobUpload(pathname, file, {
          access: 'public',
          handleUploadUrl: '/api/pdfs/upload',
          clientPayload: JSON.stringify({ email, subject: subjectField }),
        });

        const res = await fetch('/api/pdfs/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            name: file.name,
            subject: subjectField,
            url: blob.url,
            pathname: blob.pathname,
          }),
        });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.ok) {
          setUploadOpen(false);
          onPdfsChanged();
          toast({
            title: d.uploadedToastTitle,
            description: d.uploadedToastDesc(data.pdf.name as string),
          });
        } else {
          const err = data?.error;
          toast({
            title:
              err === 'tooBig'
                ? d.uploadErrTooBig
                : err === 'notPdf'
                  ? d.uploadErrPdfOnly
                  : d.pdfLoadFailed,
            variant: 'destructive',
          });
        }
      } else {
        /* Disk mode (sandbox / self-hosted): stream through the API. */
        const fd = new FormData();
        fd.append('email', email);
        fd.append('file', file);
        if (uploadSubject !== 'none') fd.append('subject', uploadSubject);

        const res = await fetch('/api/pdfs', { method: 'POST', body: fd });
        const data = await res.json().catch(() => null);
        if (res.ok && data?.ok) {
          setUploadOpen(false);
          onPdfsChanged();
          toast({
            title: d.uploadedToastTitle,
            description: d.uploadedToastDesc(data.pdf.name as string),
          });
        } else {
          const err = data?.error;
          toast({
            title:
              err === 'tooBig'
                ? d.uploadErrTooBig
                : err === 'notPdf'
                  ? d.uploadErrPdfOnly
                  : d.pdfLoadFailed,
            variant: 'destructive',
          });
        }
      }
    } catch {
      toast({ title: d.pdfLoadFailed, variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  };

  /* ── View / download ────────────────────────────────────────── */
  const openFile = (p: Pdf, download: boolean) => {
    const url = `/api/pdfs/${p.id}/file?email=${encodeURIComponent(email)}${download ? '&download=1' : ''}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  /* ── AI summary dialog (eye button) ──────────────────────────── */
  const [summaryTarget, setSummaryTarget] = useState<Pdf | null>(null);

  /* ── Rename dialog state ────────────────────────────────────── */
  const [renameTarget, setRenameTarget] = useState<Pdf | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const openRename = (p: Pdf) => {
    setRenameTarget(p);
    setRenameValue(p.name);
    setRenameError(false);
    setRenaming(false);
  };

  const handleRename = async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) {
      setRenameError(true);
      return;
    }
    if (renaming) return;
    setRenaming(true);
    try {
      const res = await fetch(`/api/pdfs/${renameTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setRenameTarget(null);
        onPdfsChanged();
        toast({ title: d.renamedToastTitle });
      } else {
        toast({ title: d.pdfLoadFailed, variant: 'destructive' });
      }
    } catch {
      toast({ title: d.pdfLoadFailed, variant: 'destructive' });
    } finally {
      setRenaming(false);
    }
  };

  /* ── Delete dialog state ────────────────────────────────────── */
  const [deleteTarget, setDeleteTarget] = useState<Pdf | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/pdfs/${deleteTarget.id}?email=${encodeURIComponent(email)}`,
        { method: 'DELETE' }
      );
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        const name = deleteTarget.name;
        setDeleteTarget(null);
        onPdfsChanged();
        toast({
          title: d.deletedToastTitle,
          description: d.deletedToastDesc(name),
        });
      } else {
        toast({ title: d.pdfLoadFailed, variant: 'destructive' });
      }
    } catch {
      toast({ title: d.pdfLoadFailed, variant: 'destructive' });
    } finally {
      setDeleting(false);
    }
  };

  /* ── Pills ──────────────────────────────────────────────────── */
  const SubjectPill = ({ name }: { name: string | null }) =>
    name ? (
      <span className="inline-flex max-w-[150px] items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-600">
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
          aria-hidden="true"
        />
        <span className="truncate">{name}</span>
      </span>
    ) : (
      <span className="text-xs text-slate-400">{d.noSubject}</span>
    );

  const StatusPill = () => (
    <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-600">
      {d.statusReady}
    </span>
  );

  const ActionButtons = ({ p }: { p: Pdf }) => (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => setSummaryTarget(p)}
        aria-label={d.aiSummaryView}
        title={d.aiSummaryView}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-emerald-600"
      >
        <Eye className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => openFile(p, true)}
        aria-label={d.downloadPdf}
        title={d.downloadPdf}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-emerald-600"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => openRename(p)}
        aria-label={d.renameDlgTitle}
        title={d.renameDlgTitle}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-emerald-600"
      >
        <Pencil className="h-4 w-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => setDeleteTarget(p)}
        aria-label={d.deleteBtn}
        title={d.deleteBtn}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );

  /* */

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      {/* Page header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {d.pdfLibraryTitle}
          </h1>
          <p className="mt-1.5 text-sm text-slate-500">{d.pdfLibraryDesc}</p>
        </div>
        <Button
          onClick={openUpload}
          className="h-9 rounded-lg bg-emerald-600 px-3.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-700"
        >
          <Upload className="h-4 w-4" aria-hidden="true" />
          {d.uploadPdf}
        </Button>
      </div>

      {/* Filter + search row */}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Select value={filterSubject} onValueChange={setFilterSubject}>
          <SelectTrigger
            aria-label={d.allSubjects}
            className="h-10 w-full rounded-lg border-slate-200 text-sm text-slate-700 sm:w-52"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-xl border-slate-200">
            <SelectItem value="all">{d.allSubjects}</SelectItem>
            {subjects.map((s) => (
              <SelectItem key={s.id} value={s.name}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={d.searchPdfPlaceholder}
            aria-label={d.searchPdfPlaceholder}
            className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
          />
        </div>
      </div>

      {/* Library */}
      {loading ? (
        <div className="mt-6 flex items-center justify-center rounded-xl border border-slate-200 bg-white py-16 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        </div>
      ) : pdfs.length === 0 ? (
        /* Empty state — matches the design language */
        <div className="mt-6 flex flex-col items-center rounded-xl border-2 border-dashed border-slate-200 px-6 py-16 text-center sm:py-20">
          <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
            <FileText className="h-7 w-7" aria-hidden="true" />
          </span>
          <h2 className="mt-6 text-base font-semibold text-slate-800">
            {d.pdfEmptyTitle}
          </h2>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">
            {d.pdfEmptyDesc}
          </p>
          <Button
            onClick={openUpload}
            className="mt-6 h-9 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700"
          >
            <Upload className="h-4 w-4" aria-hidden="true" />
            {d.uploadPdf}
          </Button>
        </div>
      ) : visiblePdfs.length === 0 ? (
        <div className="mt-6 flex flex-col items-center rounded-xl border border-slate-200 bg-white px-6 py-14 text-center shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <FileText className="h-8 w-8 text-slate-300" aria-hidden="true" />
          <p className="mt-3 text-sm text-slate-500">{d.pdfNoMatch}</p>
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          {/* Table header (desktop) */}
          <div
            className="hidden grid-cols-[minmax(0,1fr)_170px_110px_170px] items-center gap-4 border-b border-slate-100 bg-slate-50/60 px-5 py-3 md:grid"
            aria-hidden="true"
          >
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
              {d.pdfColDocument}
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
              {d.pdfColSubject}
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
              {d.pdfColStatus}
            </span>
            <span className="text-right text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">
              {d.pdfColActions}
            </span>
          </div>

          <ul>
            {visiblePdfs.map((p) => (
              <li
                key={p.id}
                className="border-b border-slate-100 px-5 py-4 last:border-0 transition hover:bg-slate-50/60"
              >
                {/* Desktop row */}
                <div className="hidden grid-cols-[minmax(0,1fr)_170px_110px_170px] items-center gap-4 md:grid">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                      <FileText className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-slate-800">
                        {p.name}
                      </span>
                      <span className="block text-xs text-slate-400">
                        {formatBytes(p.size)} · {d.pdfPages(p.pages)} ·{' '}
                        {formatDate(p.createdAt)}
                      </span>
                    </span>
                  </div>
                  <SubjectPill name={p.subjectName} />
                  <StatusPill />
                  <div className="flex justify-end">
                    <ActionButtons p={p} />
                  </div>
                </div>

                {/* Mobile card */}
                <div className="md:hidden">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                      <FileText className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-slate-800">
                        {p.name}
                      </span>
                      <span className="block text-xs text-slate-400">
                        {formatBytes(p.size)} · {d.pdfPages(p.pages)} ·{' '}
                        {formatDate(p.createdAt)}
                      </span>
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <SubjectPill name={p.subjectName} />
                      <StatusPill />
                    </div>
                    <ActionButtons p={p} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Upload dialog ──────────────────────────────────────── */}
      <Dialog open={uploadOpen} onOpenChange={(open) => !uploading && setUploadOpen(open)}>
        <DialogContent className="font-brand rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">
              {d.uploadDlgTitle}
            </DialogTitle>
            <DialogDescription className="text-sm text-slate-500">
              {d.uploadDlgDesc}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            {/* File picker */}
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label={d.uploadChoose}
              className={`flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition ${
                file
                  ? 'border-emerald-300 bg-emerald-50/40'
                  : fileError
                    ? 'border-rose-300 bg-rose-50/40'
                    : 'border-slate-300 hover:border-emerald-300 hover:bg-slate-50'
              }`}
            >
              {file ? (
                <>
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
                    <FileText className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="max-w-full truncate text-sm font-medium text-slate-700">
                    {d.uploadSelected(file.name, formatBytes(file.size))}
                  </span>
                </>
              ) : (
                <>
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
                    <Upload className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="text-sm font-medium text-slate-700">
                    {d.uploadChoose}
                  </span>
                  <span className="text-xs text-slate-400">
                    {d.uploadChooseHint}
                  </span>
                </>
              )}
            </button>

            {/* Subject (optional) */}
            <div className="space-y-1.5">
              <Label className="text-sm">{d.uploadSubjectLabel}</Label>
              <Select value={uploadSubject} onValueChange={setUploadSubject}>
                <SelectTrigger className="h-10 w-full rounded-lg border-slate-200 text-sm text-slate-700">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-xl border-slate-200 max-h-64">
                  <SelectItem value="none">{d.noSubject}</SelectItem>
                  {subjects.map((s) => (
                    <SelectItem key={s.id} value={s.name}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setUploadOpen(false)}
              disabled={uploading}
              className="rounded-lg"
            >
              {d.dlgCancel}
            </Button>
            <Button
              onClick={() => void handleUpload()}
              disabled={uploading}
              className="rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {uploading && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {uploading ? d.uploading : d.uploadBtn}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── AI summary dialog (eye button) ──────────────────────── */}
      <PdfSummaryDialog
        pdf={summaryTarget}
        email={email}
        onOpenChange={(open) => {
          if (!open) setSummaryTarget(null);
        }}
        onOpenOriginal={(p) => openFile(p, false)}
      />

      {/* ── Rename dialog ──────────────────────────────────────── */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => !renaming && !open && setRenameTarget(null)}>
        <DialogContent className="font-brand rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">
              {d.renameDlgTitle}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5 py-1">
            <Label htmlFor="pdf-rename" className="text-sm">
              {d.renameDlgLabel}
            </Label>
            <Input
              id="pdf-rename"
              value={renameValue}
              onChange={(e) => {
                setRenameValue(e.target.value);
                setRenameError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleRename();
                }
              }}
              maxLength={120}
              autoFocus
              aria-invalid={renameError}
              className={renameError ? 'border-rose-400' : undefined}
            />
            {renameError && (
              <p className="text-xs text-rose-600">{d.dlgErrName}</p>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setRenameTarget(null)}
              disabled={renaming}
              className="rounded-lg"
            >
              {d.dlgCancel}
            </Button>
            <Button
              onClick={() => void handleRename()}
              disabled={renaming}
              className="rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {renaming && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {d.renameDlgTitle}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete dialog ──────────────────────────────────────── */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !deleting && !open && setDeleteTarget(null)}>
        <DialogContent className="font-brand rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">
              {d.deleteDlgTitle}
            </DialogTitle>
            <DialogDescription className="text-sm text-slate-500">
              {deleteTarget && d.deleteDlgDesc(deleteTarget.name)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
              className="rounded-lg"
            >
              {d.dlgCancel}
            </Button>
            <Button
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="rounded-lg bg-rose-600 text-white hover:bg-rose-700"
            >
              {deleting && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {d.deleteBtn}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
