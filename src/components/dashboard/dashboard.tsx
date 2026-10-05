'use client';

/**
 * Gyanzo Dashboard — the signed-in home screen (shown right after a new
 * account verifies its email, after sign-in, and on refresh while the
 * session persists).
 *
 * Layout (1:1 with the design): fixed white left sidebar (brand, grouped
 * nav, user card) + light content area (breadcrumb/search top bar,
 * welcome header, 4 stat cards, quick actions, your subjects, recent
 * activity). The sidebar collapses into an off-canvas drawer on mobile.
 *
 * Real behavior: subjects live in SQLite (GET/POST /api/subjects), the
 * notification bell clears its badge (and respects the Settings
 * notification preference), ⌘K focuses search, logout ends the session.
 * Every sidebar section — including Mind Map, Progress, Voice Tutor,
 * Citation, Vocabulary, Exam Prediction, Formula Sheet, Profile and
 * Settings — renders a real, working view.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  BookOpen,
  Calendar,
  ChevronRight,
  Clock,
  FileText,
  Files,
  GraduationCap,
  HelpCircle,
  Layers,
  LayoutGrid,
  Lightbulb,
  Loader2,
  LogOut,
  Menu,
  MessageSquare,
  Mic,
  Network,
  NotebookText,
  Plus,
  Quote,
  Search,
  Settings,
  Sigma,
  Sparkles,
  Target,
  Upload,
  User,
  X,
  type LucideIcon,
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import LanguageSwitcher from '@/components/language-switcher';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/lib/i18n';
import { firstName, initials, setSession, type SessionUser } from '@/lib/session';
import {
  BORDER_STYLES,
  CHIP_STYLES,
  SUBJECT_COLORS,
  type Subject,
  type SubjectColor,
} from '@/components/dashboard/subject-styles';
import SubjectsView from '@/components/dashboard/subjects-view';
import PdfLibraryView from '@/components/dashboard/pdf-library-view';
import ChatView from '@/components/dashboard/chat-view';
import SmartSummaryView from '@/components/dashboard/smart-summary-view';
import ExplanationView from '@/components/dashboard/explanation-view';
import QuizView, {
  type QuizAttemptSummary,
} from '@/components/dashboard/quiz-view';
import FlashcardsView, {
  type DeckSummary,
} from '@/components/dashboard/flashcards-view';
import RevisionNotesView, {
  type RevisionNoteMeta,
} from '@/components/dashboard/revision-notes-view';
import StudyPlannerView from '@/components/dashboard/study-planner-view';
import MindMapView from '@/components/dashboard/mind-map-view';
import ProgressView from '@/components/dashboard/progress-view';
import VoiceTutorView from '@/components/dashboard/voice-tutor-view';
import MobileTabBar from '@/components/dashboard/mobile-tab-bar';
import CitationView from '@/components/dashboard/citation-view';
import VocabularyView from '@/components/dashboard/vocabulary-view';
import ExamPredictionView from '@/components/dashboard/exam-prediction-view';
import FormulaSheetView from '@/components/dashboard/formula-sheet-view';
import ProfileView from '@/components/dashboard/profile-view';
import SettingsView from '@/components/dashboard/settings-view';
import { loadPrefs, PREFS_EVENT } from '@/lib/prefs';
import NotificationBell from '@/components/dashboard/notification-bell';
import {
  formatDate,
  type Pdf,
  type PdfStorageMode,
} from '@/components/dashboard/pdf-utils';

export default function Dashboard({
  user,
  onLogout,
}: {
  user: SessionUser;
  onLogout: () => void;
}) {
  const { toast } = useToast();
  const { t } = useLanguage();
  const d = t.dashboard;

  const [activeNav, setActiveNav] = useState('dashboard');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // The real-time bell badge + quiz reminder respect the Settings →
  // Notifications preferences (live via the prefs event, persisted per user).
  const [notifEnabled, setNotifEnabled] = useState(true);
  const [quizReminders, setQuizReminders] = useState(true);

  useEffect(() => {
    const sync = () => {
      const prefs = loadPrefs(user.email);
      setNotifEnabled(prefs.notifications);
      setQuizReminders(prefs.quizReminders);
    };
    sync();
    window.addEventListener(PREFS_EVENT, sync);
    return () => window.removeEventListener(PREFS_EVENT, sync);
  }, [user.email]);

  const handleUserChanged = useCallback(
    (updated: SessionUser) =>
      setSession({ name: updated.name, email: updated.email, avatar: updated.avatar }),
    []
  );

  /* ── Subjects (real data from SQLite) ─────────────────────── */
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [subjectsLoading, setSubjectsLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [subjectName, setSubjectName] = useState('');
  const [subjectColor, setSubjectColor] = useState<SubjectColor>('emerald');
  const [nameError, setNameError] = useState(false);
  const [creating, setCreating] = useState(false);

  /* ── Rename / delete subject (Subjects page kebab menu) ─────── */
  const [renameTarget, setRenameTarget] = useState<Subject | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameError, setRenameError] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Subject | null>(null);
  const [deleting, setDeleting] = useState(false);

  /* PDF Library pre-filter, applied when a subject card is opened. */
  const [pdfSubjectFilter, setPdfSubjectFilter] = useState('');
  const [pdfSubjectNonce, setPdfSubjectNonce] = useState(0);

  /* ── PDFs (real data from SQLite) ─────────────────────────── */
  const [pdfs, setPdfs] = useState<Pdf[]>([]);
  const [pdfsLoading, setPdfsLoading] = useState(true);
  /** Storage backend reported by GET /api/pdfs — picks the upload path. */
  const [storageMode, setStorageMode] = useState<PdfStorageMode>('disk');

  /* ── Quiz attempts (meta only — powers the stat + activity) ── */
  const [quizAttempts, setQuizAttempts] = useState<QuizAttemptSummary[]>([]);

  /* ── Flashcard decks (meta only — powers the activity feed) ── */
  const [fcDecks, setFcDecks] = useState<DeckSummary[]>([]);

  /* ── Revision notes (meta only — powers the activity feed) ── */
  const [rnNotes, setRnNotes] = useState<RevisionNoteMeta[]>([]);

  const searchRef = useRef<HTMLInputElement>(null);

  /* ── Load subjects ──────────────────────────────────────────── */
  const loadSubjects = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/subjects?email=${encodeURIComponent(user.email)}`
      );
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setSubjects(data.subjects as Subject[]);
      } else {
        toast({ title: d.loadFailed, variant: 'destructive' });
      }
    } catch {
      toast({ title: d.loadFailed, variant: 'destructive' });
    } finally {
      setSubjectsLoading(false);
    }
  }, [user.email, d.loadFailed, toast]);

  useEffect(() => {
    void loadSubjects();
  }, [loadSubjects]);

  /* ── Load PDFs ──────────────────────────────────────────────── */
  const loadPdfs = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/pdfs?email=${encodeURIComponent(user.email)}`
      );
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setPdfs(data.pdfs as Pdf[]);
        setStorageMode(data.storage === 'blob' ? 'blob' : 'disk');
      } else {
        toast({ title: d.pdfLoadFailed, variant: 'destructive' });
      }
    } catch {
      toast({ title: d.pdfLoadFailed, variant: 'destructive' });
    } finally {
      setPdfsLoading(false);
    }
  }, [user.email, d.pdfLoadFailed, toast]);

  useEffect(() => {
    void loadPdfs();
  }, [loadPdfs]);

  /* ── Load quiz attempt summaries (meta list, silent on failure) ── */
  const loadQuizMeta = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/quiz/attempts?email=${encodeURIComponent(user.email)}&meta=1`
      );
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setQuizAttempts(data.attempts as QuizAttemptSummary[]);
      }
    } catch {
      /* the stat simply stays empty — the Quiz section toasts on its own */
    }
  }, [user.email]);

  useEffect(() => {
    void loadQuizMeta();
  }, [loadQuizMeta]);

  const handleQuizAttemptsChanged = useCallback(
    (list: QuizAttemptSummary[]) => setQuizAttempts(list),
    []
  );

  const handleFcDecksChanged = useCallback(
    (list: DeckSummary[]) => setFcDecks(list),
    []
  );

  const handleRnNotesChanged = useCallback(
    (list: RevisionNoteMeta[]) => setRnNotes(list),
    []
  );

  /* ── ⌘K / Ctrl+K focuses the search field ───────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* ── Navigation ─────────────────────────────────────────────── */
  const NAV_SECTIONS = useMemo(
    () => [
      {
        label: d.secMain,
        items: [
          { id: 'dashboard', icon: LayoutGrid, label: d.navDashboard },
          { id: 'subjects', icon: BookOpen, label: d.navSubjects },
          { id: 'pdf-library', icon: FileText, label: d.navPdfLibrary },
        ],
      },
      {
        label: d.secAiTools,
        items: [
          { id: 'ai-chat', icon: MessageSquare, label: d.navAiChat },
          { id: 'smart-summary', icon: Files, label: d.navSmartSummary },
          {
            id: 'easy-explanation',
            icon: Lightbulb,
            label: d.navEasyExplanation,
          },
        ],
      },
      {
        label: d.secPractice,
        items: [
          { id: 'quiz', icon: HelpCircle, label: d.navQuiz },
          { id: 'flashcards', icon: Layers, label: d.navFlashcards },
          {
            id: 'revision-notes',
            icon: NotebookText,
            label: d.navRevisionNotes,
          },
        ],
      },
      {
        label: d.secPlanning,
        items: [
          { id: 'study-planner', icon: Calendar, label: d.navStudyPlanner },
          { id: 'mind-map', icon: Network, label: d.navMindMap },
          { id: 'progress', icon: BarChart3, label: d.navProgress },
        ],
      },
      {
        label: d.secUtilities,
        items: [
          { id: 'voice-tutor', icon: Mic, label: d.navVoiceTutor },
          { id: 'citation', icon: Quote, label: d.navCitation },
          { id: 'vocabulary', icon: Target, label: d.navVocabulary },
          {
            id: 'exam-prediction',
            icon: Sparkles,
            label: d.navExamPrediction,
          },
          { id: 'formula-sheet', icon: Sigma, label: d.navFormulaSheet },
        ],
      },
    ],
    [d]
  );

  const handleNav = (id: string, label: string) => {
    setMobileNavOpen(false);
    if (id === activeNav) return;
    // Every sidebar entry and the Profile/Settings user-card buttons
    // render real, working sections.
    const real = [
      'dashboard',
      'subjects',
      'pdf-library',
      'ai-chat',
      'smart-summary',
      'easy-explanation',
      'quiz',
      'flashcards',
      'revision-notes',
      'study-planner',
      'mind-map',
      'progress',
      'voice-tutor',
      'citation',
      'vocabulary',
      'exam-prediction',
      'formula-sheet',
      'profile',
      'settings',
    ];
    if (real.includes(id)) {
      setActiveNav(id);
      return;
    }
    toast({
      title: d.comingSoonTitle,
      description: d.comingSoonDesc(label),
    });
  };

  const comingSoon = (feature: string) =>
    toast({ title: d.comingSoonTitle, description: d.comingSoonDesc(feature) });

  /* ── Open a subject: PDF Library filtered to its materials ───── */
  const openSubject = (s: Subject) => {
    setPdfSubjectFilter(s.name);
    setPdfSubjectNonce((n) => n + 1);
    setMobileNavOpen(false);
    setActiveNav('pdf-library');
  };

  /* Real quiz-reminder notification (Settings → Quiz Reminders). */
  const showQuizReminder =
    quizReminders && subjects.length > 0 && quizAttempts.length === 0;

  /* ── Create subject ─────────────────────────────────────────── */
  const openCreate = () => {
    setSubjectName('');
    setSubjectColor('emerald');
    setNameError(false);
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    const name = subjectName.trim();
    if (!name) {
      setNameError(true);
      return;
    }
    if (creating) return;
    setCreating(true);
    try {
      const res = await fetch('/api/subjects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user.email,
          name,
          color: subjectColor,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setSubjects((prev) => [data.subject as Subject, ...prev]);
        setCreateOpen(false);
        toast({
          title: d.createdToastTitle,
          description: d.createdToastDesc(name),
        });
      } else {
        toast({ title: d.loadFailed, variant: 'destructive' });
      }
    } catch {
      toast({ title: d.loadFailed, variant: 'destructive' });
    } finally {
      setCreating(false);
    }
  };

  /* ── Rename / delete subject handlers ───────────────────────── */
  const openRename = (s: Subject) => {
    setRenameTarget(s);
    setRenameName(s.name);
    setRenameError(false);
  };

  const handleRename = async () => {
    const target = renameTarget;
    if (!target) return;
    const name = renameName.trim();
    if (!name) {
      setRenameError(true);
      return;
    }
    if (renaming) return;
    setRenaming(true);
    try {
      const res = await fetch(`/api/subjects/${encodeURIComponent(target.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, name }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        const updated = data.subject as Subject;
        setSubjects((prev) =>
          prev.map((s) => (s.id === updated.id ? updated : s))
        );
        setRenameTarget(null);
        toast({
          title: d.subjRenamedToastTitle,
          description: d.subjRenamedToastDesc(updated.name),
        });
      } else {
        toast({ title: d.loadFailed, variant: 'destructive' });
      }
    } catch {
      toast({ title: d.loadFailed, variant: 'destructive' });
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async () => {
    const target = deleteTarget;
    if (!target || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/subjects/${encodeURIComponent(target.id)}?email=${encodeURIComponent(user.email)}`,
        { method: 'DELETE' }
      );
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setSubjects((prev) => prev.filter((s) => s.id !== target.id));
        setDeleteTarget(null);
        toast({
          title: d.subjDeletedToastTitle,
          description: d.subjDeletedToastDesc(target.name),
        });
      } else {
        toast({ title: d.loadFailed, variant: 'destructive' });
      }
    } catch {
      toast({ title: d.loadFailed, variant: 'destructive' });
    } finally {
      setDeleting(false);
    }
  };

  /* ── Sidebar markup (shared between desktop + mobile drawer) ── */
  const sidebarContent = (
    <>
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-600">
          <GraduationCap className="h-5 w-5 text-white" strokeWidth={2.2} />
        </span>
        <span className="min-w-0">
          <span className="block text-base font-bold leading-tight tracking-tight text-slate-900">
            Gyanzo
          </span>
          <span className="block text-[11px] leading-tight text-slate-500">
            Your Study Companion
          </span>
        </span>
        {/* Close button (mobile drawer only) */}
        <button
          type="button"
          onClick={() => setMobileNavOpen(false)}
          aria-label={d.a11yCloseNav}
          className="ml-auto rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/* Nav */}
      <nav
        aria-label={d.a11yDashboard}
        className="scrollbar-thin flex-1 overflow-y-auto px-3 pb-4"
      >
        {NAV_SECTIONS.map((section) => (
          <div key={section.label} className="mt-4 first:mt-2">
            <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
              {section.label}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = item.id === activeNav;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => handleNav(item.id, item.label)}
                      aria-current={active ? 'page' : undefined}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition ${
                        active
                          ? 'bg-emerald-50 font-medium text-emerald-700'
                          : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                      }`}
                    >
                      <item.icon
                        className={`h-[18px] w-[18px] shrink-0 ${
                          active ? 'text-emerald-600' : 'text-slate-500'
                        }`}
                        aria-hidden="true"
                      />
                      <span className="truncate">{item.label}</span>
                      {active && (
                        <span
                          className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* User card */}
      <div className="border-t border-slate-200/80 p-4">
        <div className="flex items-center gap-3">
          {user.avatar ? (
            <img
              src={user.avatar}
              alt=""
              className="h-9 w-9 shrink-0 rounded-full object-cover"
            />
          ) : (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-xs font-semibold text-white">
              {initials(user.name)}
            </span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-slate-800">
              {user.name}
            </span>
            <span className="block truncate text-[11px] text-slate-500">
              {user.email}
            </span>
          </span>
        </div>
        <div className="mt-3 flex items-center gap-4 text-xs text-slate-500">
          <button
            type="button"
            onClick={() => handleNav('profile', d.profile)}
            className={`inline-flex items-center gap-1.5 rounded transition hover:text-slate-800 ${
              activeNav === 'profile' ? 'font-semibold text-emerald-700' : ''
            }`}
          >
            <User className="h-3.5 w-3.5" aria-hidden="true" />
            {d.profile}
          </button>
          <button
            type="button"
            onClick={() => handleNav('settings', d.settings)}
            className={`inline-flex items-center gap-1.5 rounded transition hover:text-slate-800 ${
              activeNav === 'settings' ? 'font-semibold text-emerald-700' : ''
            }`}
          >
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
            {d.settings}
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="inline-flex items-center gap-1.5 rounded transition hover:text-rose-600"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            {d.logout}
          </button>
        </div>
      </div>
    </>
  );

  /* ── Stat cards (subjects is real, the rest start at 0) ─────── */
  const STATS: {
    label: string;
    value: number;
    icon: LucideIcon;
    color: SubjectColor;
  }[] = [
    {
      label: d.statTotalSubjects,
      value: subjects.length,
      icon: BookOpen,
      color: 'emerald',
    },
    { label: d.statPdfsUploaded, value: pdfs.length, icon: FileText, color: 'orange' },
    {
      label: d.statQuizzesTaken,
      value: quizAttempts.length,
      icon: HelpCircle,
      color: 'teal',
    },
    { label: d.statStudyHours, value: 0, icon: Clock, color: 'amber' },
  ];

  const QUICK_ACTIONS: {
    icon: LucideIcon;
    label: string;
    color: SubjectColor;
    nav?: string;
  }[] = [
    { icon: Upload, label: d.qaUploadPdf, color: 'emerald', nav: 'pdf-library' },
    { icon: HelpCircle, label: d.qaGenerateQuiz, color: 'orange', nav: 'quiz' },
    { icon: MessageSquare, label: d.qaStartChat, color: 'emerald', nav: 'ai-chat' },
    { icon: Layers, label: d.qaCreateFlashcards, color: 'orange', nav: 'flashcards' },
  ];

  /* ── Recent activity = subject creations + PDF uploads + quiz
     attempts + flashcard decks, newest first ── */
  type ActivityItem = {
    id: string;
    kind: 'subject' | 'pdf' | 'quiz' | 'flashcards' | 'revision';
    name: string;
    color: SubjectColor;
    at: string;
  };

  const activity: ActivityItem[] = useMemo(() => {
    const items: ActivityItem[] = [
      ...subjects.map((s) => ({
        id: `s-${s.id}`,
        kind: 'subject' as const,
        name: s.name,
        color: s.color,
        at: s.createdAt,
      })),
      ...pdfs.map((p) => ({
        id: `p-${p.id}`,
        kind: 'pdf' as const,
        name: p.name,
        color: 'emerald' as const,
        at: p.createdAt,
      })),
      ...quizAttempts.map((a) => ({
        id: `q-${a.id}`,
        kind: 'quiz' as const,
        name: a.subjectName,
        color: 'teal' as const,
        at: a.createdAt,
      })),
      ...fcDecks.map((deck) => ({
        id: `f-${deck.id}`,
        kind: 'flashcards' as const,
        name: deck.subjectName,
        color: 'orange' as const,
        at: deck.createdAt,
      })),
      ...rnNotes.map((note) => ({
        id: `r-${note.id}`,
        kind: 'revision' as const,
        name: note.subjectName,
        color: 'violet' as const,
        at: note.createdAt,
      })),
    ];
    return items
      .sort((a, b) => +new Date(b.at) - +new Date(a.at))
      .slice(0, 6);
  }, [subjects, pdfs, quizAttempts, fcDecks, rnNotes]);

  return (
    <div
      className="font-brand flex min-h-screen flex-col bg-[#fafbfa] text-slate-900"
      aria-label={d.a11yDashboard}
    >
      {/* ── Desktop sidebar (fixed) ──────────────────────────── */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[272px] flex-col border-r border-slate-200/80 bg-white lg:flex">
        {sidebarContent}
      </aside>

      {/* ── Mobile drawer ────────────────────────────────────── */}
      <div
        className={`fixed inset-0 z-50 bg-slate-900/40 transition-opacity lg:hidden ${
          mobileNavOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={() => setMobileNavOpen(false)}
        aria-hidden="true"
      />
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[280px] max-w-[85vw] flex-col bg-white shadow-xl transition-transform duration-300 lg:hidden ${
          mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-hidden={!mobileNavOpen}
      >
        {sidebarContent}
      </aside>

      {/* ── Main column ──────────────────────────────────────── */}
      {/* pb-24 reserves room for the fixed mobile tab bar (h ≈ 60px
          + iOS safe-area inset); the bar only renders below lg. */}
      <div className="flex min-h-screen flex-col pb-24 lg:pb-0 lg:pl-[272px]">
        {/* Top bar */}
        <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/90 backdrop-blur">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6 lg:h-16 lg:px-8">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              aria-label={d.a11yOpenNav}
              className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </button>

            {/* Breadcrumb */}
            <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => handleNav('dashboard', d.navDashboard)}
                className="text-sm text-slate-500 transition hover:text-slate-800"
              >
                {d.breadcrumbHome}
              </button>
              <ChevronRight
                className="h-3.5 w-3.5 text-slate-400"
                aria-hidden="true"
              />
              <span
                className="text-sm font-semibold text-slate-800"
                aria-current={activeNav !== 'dashboard' ? 'page' : undefined}
              >
                {activeNav === 'profile'
                  ? d.profile
                  : activeNav === 'settings'
                    ? d.settings
                    : (NAV_SECTIONS.flatMap((s) => s.items).find(
                          (i) => i.id === activeNav
                        )?.label ?? d.navDashboard)}
              </span>
            </nav>

            {/* Right cluster */}
            <div className="ml-auto flex items-center gap-1.5 sm:gap-2.5">
              {/* Search */}
              <div className="relative hidden md:block">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  ref={searchRef}
                  type="text"
                  placeholder={d.searchPlaceholder}
                  aria-label={d.a11ySearch}
                  className="h-9 w-56 rounded-lg border border-slate-200 bg-white pl-9 pr-12 text-sm text-slate-700 placeholder:text-slate-400 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 lg:w-64"
                />
                <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
                  ⌘K
                </kbd>
              </div>

              {/* Notifications — real-time (socket push + persisted) */}
              <NotificationBell
                email={user.email}
                badgeEnabled={notifEnabled}
                onNavigate={(id) => {
                  const item = NAV_SECTIONS.flatMap((s) => s.items).find(
                    (i) => i.id === id
                  );
                  handleNav(id, item?.label ?? d.navDashboard);
                }}
                quizReminder={
                  showQuizReminder ? (
                    <DropdownMenuItem
                      className="cursor-pointer gap-2.5 rounded-lg p-2.5 data-[highlighted]:bg-emerald-50 data-[highlighted]:text-emerald-900"
                      onClick={() => handleNav('quiz', d.navQuiz)}
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
                        <Target className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">
                          {d.stBellQuizTitle}
                        </span>
                        <span className="block text-xs text-slate-500">
                          {d.stBellQuizDesc}
                        </span>
                      </span>
                    </DropdownMenuItem>
                  ) : undefined
                }
              />

              {/* Language */}
              <LanguageSwitcher variant="icon" />

              {/* Avatar */}
              {user.avatar ? (
                  <img
                  src={user.avatar}
                  alt=""
                  className="h-8 w-8 rounded-full object-cover"
                />
              ) : (
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-800 text-[11px] font-semibold text-white"
                  aria-hidden="true"
                >
                  {initials(user.name)}
                </span>
              )}
            </div>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1">
          {activeNav === 'subjects' ? (
            <SubjectsView
              subjects={subjects}
              loading={subjectsLoading}
              pdfs={pdfs}
              onNewSubject={openCreate}
              onOpenSubject={openSubject}
              onRenameSubject={openRename}
              onDeleteSubject={(s) => setDeleteTarget(s)}
            />
          ) : activeNav === 'smart-summary' ? (
            <SmartSummaryView
              email={user.email}
              subjects={subjects}
              subjectsLoading={subjectsLoading}
              pdfs={pdfs}
              onNewSubject={openCreate}
            />
          ) : activeNav === 'ai-chat' ? (
            <ChatView email={user.email} subjects={subjects} pdfs={pdfs} />
          ) : activeNav === 'easy-explanation' ? (
            <ExplanationView
              email={user.email}
              subjects={subjects}
              pdfs={pdfs}
            />
          ) : activeNav === 'quiz' ? (
            <QuizView
              email={user.email}
              subjects={subjects}
              pdfs={pdfs}
              onAttemptsChanged={handleQuizAttemptsChanged}
            />
          ) : activeNav === 'flashcards' ? (
            <FlashcardsView
              email={user.email}
              subjects={subjects}
              pdfs={pdfs}
              onDecksChanged={handleFcDecksChanged}
            />
          ) : activeNav === 'revision-notes' ? (
            <RevisionNotesView
              email={user.email}
              subjects={subjects}
              subjectsLoading={subjectsLoading}
              pdfs={pdfs}
              onNewSubject={openCreate}
              onNotesChanged={handleRnNotesChanged}
            />
          ) : activeNav === 'study-planner' ? (
            <StudyPlannerView
              email={user.email}
              subjects={subjects}
              subjectsLoading={subjectsLoading}
              onNewSubject={openCreate}
            />
          ) : activeNav === 'mind-map' ? (
            <MindMapView
              email={user.email}
              subjects={subjects}
              subjectsLoading={subjectsLoading}
              pdfs={pdfs}
              onNewSubject={openCreate}
            />
          ) : activeNav === 'progress' ? (
            <ProgressView
              email={user.email}
              subjects={subjects}
              subjectsLoading={subjectsLoading}
              pdfs={pdfs}
            />
          ) : activeNav === 'voice-tutor' ? (
            <VoiceTutorView email={user.email} subjects={subjects} pdfs={pdfs} />
          ) : activeNav === 'citation' ? (
            <CitationView
              email={user.email}
              subjects={subjects}
              subjectsLoading={subjectsLoading}
              pdfs={pdfs}
              onNewSubject={openCreate}
            />
          ) : activeNav === 'vocabulary' ? (
            <VocabularyView
              email={user.email}
              subjects={subjects}
              subjectsLoading={subjectsLoading}
              pdfs={pdfs}
              onNewSubject={openCreate}
            />
          ) : activeNav === 'exam-prediction' ? (
            <ExamPredictionView
              email={user.email}
              subjects={subjects}
              subjectsLoading={subjectsLoading}
              pdfs={pdfs}
              onNewSubject={openCreate}
            />
          ) : activeNav === 'formula-sheet' ? (
            <FormulaSheetView
              email={user.email}
              subjects={subjects}
              subjectsLoading={subjectsLoading}
              pdfs={pdfs}
              onNewSubject={openCreate}
            />
          ) : activeNav === 'profile' ? (
            <ProfileView user={user} onUserChanged={handleUserChanged} />
          ) : activeNav === 'settings' ? (
            <SettingsView email={user.email} onLogout={onLogout} />
          ) : activeNav === 'pdf-library' ? (
            <PdfLibraryView
              email={user.email}
              subjects={subjects}
              pdfs={pdfs}
              loading={pdfsLoading}
              storage={storageMode}
              onPdfsChanged={() => void loadPdfs()}
              initialSubject={pdfSubjectFilter || undefined}
              initialSubjectNonce={pdfSubjectNonce}
            />
          ) : (
          <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            {/* Welcome header */}
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                  {d.welcomeBack(firstName(user.name))}
                </h1>
                <p className="mt-1.5 text-sm text-slate-500">{d.readyLine}</p>
              </div>
              <Button
                onClick={openCreate}
                className="h-9 rounded-lg bg-emerald-600 px-3.5 text-sm font-medium text-white shadow-sm hover:bg-emerald-700"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                {d.newSubject}
              </Button>
            </div>

            {/* Stats — on phones the four cards sit in a 2×2 grid and
                must all be EXACTLY the same size: grid-cols-2 fixes the
                width of every card, auto-rows-fr makes both rows equal
                (so all four get the height of the tallest), and the
                value/updated block is pinned to the bottom (mt-auto) so
                shorter labels can't make a card look different. */}
            <section
              aria-label={d.statTotalSubjects}
              className="mt-6 grid auto-rows-fr grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4"
            >
              {STATS.map((s) => (
                <div
                  key={s.label}
                  className={`flex h-full min-w-0 flex-col rounded-xl border bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-5 ${BORDER_STYLES[s.color]}`}
                >
                  <div className="flex items-start justify-between gap-2 sm:gap-3">
                    <p className="text-sm leading-snug text-slate-600">
                      {s.label}
                    </p>
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg sm:h-9 sm:w-9 ${CHIP_STYLES[s.color]}`}
                    >
                      <s.icon
                        className="h-4 w-4 sm:h-[18px] sm:w-[18px]"
                        aria-hidden="true"
                      />
                    </span>
                  </div>
                  <p className="mt-auto pt-3 text-3xl font-bold tabular-nums">
                    {s.value}
                  </p>
                  <p className="mt-1.5 text-xs text-slate-400">
                    {d.statUpdated}
                  </p>
                </div>
              ))}
            </section>

            {/* Quick actions */}
            <section aria-label={d.quickActions} className="mt-8">
              <h2 className="text-base font-semibold text-slate-800">
                {d.quickActions}
              </h2>
              <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
                {QUICK_ACTIONS.map((a) => (
                  <button
                    key={a.label}
                    type="button"
                    onClick={() =>
                      a.nav ? handleNav(a.nav, a.label) : comingSoon(a.label)
                    }
                    className="flex flex-col items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-7 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition hover:border-emerald-200 hover:shadow-md"
                  >
                    <span
                      className={`flex h-12 w-12 items-center justify-center rounded-xl ${CHIP_STYLES[a.color]}`}
                    >
                      <a.icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <span className="text-sm font-medium text-slate-700">
                      {a.label}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            {/* Your subjects */}
            <section aria-label={d.yourSubjects} className="mt-8">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-slate-800">
                  {d.yourSubjects}
                </h2>
                {subjects.length > 0 && (
                  <button
                    type="button"
                    onClick={() => handleNav('subjects', d.navSubjects)}
                    className="inline-flex items-center gap-1 text-sm font-medium text-emerald-600 transition hover:text-emerald-700"
                  >
                    {d.viewAll}
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>

              {subjectsLoading ? (
                <div className="mt-3 flex items-center justify-center rounded-2xl border border-slate-200 bg-white py-14 text-slate-400">
                  <Loader2
                    className="h-5 w-5 animate-spin"
                    aria-label={d.statUpdated}
                  />
                </div>
              ) : subjects.length === 0 ? (
                /* Empty state — matches the design exactly */
                <div className="mt-3 flex flex-col items-center rounded-2xl border-2 border-dashed border-slate-300 px-6 py-14 text-center sm:py-16">
                  <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
                    <Sparkles className="h-7 w-7" aria-hidden="true" />
                  </span>
                  <h3 className="mt-5 text-base font-semibold text-slate-800">
                    {d.emptySubjectsTitle}
                  </h3>
                  <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">
                    {d.emptySubjectsDesc}
                  </p>
                  <Button
                    onClick={openCreate}
                    className="mt-6 h-9 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700"
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {d.createSubject}
                  </Button>
                </div>
              ) : (
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {subjects.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => openSubject(s)}
                      className="flex items-center gap-3.5 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition hover:border-emerald-200 hover:shadow-md"
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
                          {d.subjectPdfs(
                            pdfs.filter((p) => p.subjectName === s.name).length
                          )}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/* Recent activity */}
            <section aria-label={d.recentActivity} className="mt-8 pb-10">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-slate-800">
                  {d.recentActivity}
                </h2>
                {activity.length > 0 && (
                  <button
                    type="button"
                    onClick={() => comingSoon(d.recentActivity)}
                    className="inline-flex items-center gap-1 text-sm font-medium text-emerald-600 transition hover:text-emerald-700"
                  >
                    {d.viewAll}
                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>

              {activity.length === 0 ? (
                <div className="mt-3 flex flex-col items-center rounded-2xl border border-slate-200 bg-white px-6 py-12 text-center shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
                  <Sparkles
                    className="h-8 w-8 text-slate-300"
                    aria-hidden="true"
                  />
                  <p className="mt-3 text-sm text-slate-500">{d.noActivity}</p>
                </div>
              ) : (
                <ul className="mt-3 space-y-2.5">
                  {activity.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
                    >
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${CHIP_STYLES[item.color]}`}
                      >
                        {item.kind === 'pdf' ? (
                          <FileText className="h-4 w-4" aria-hidden="true" />
                        ) : item.kind === 'quiz' ? (
                          <HelpCircle className="h-4 w-4" aria-hidden="true" />
                        ) : item.kind === 'flashcards' ? (
                          <Layers className="h-4 w-4" aria-hidden="true" />
                        ) : item.kind === 'revision' ? (
                          <NotebookText className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <Plus className="h-4 w-4" aria-hidden="true" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-slate-700">
                          {item.kind === 'pdf'
                            ? d.activityUploadedPdf(item.name)
                            : item.kind === 'quiz'
                              ? d.activityCompletedQuiz(
                                  item.name || d.quizGeneralQuiz
                                )
                              : item.kind === 'flashcards'
                                ? d.activityGeneratedDeck(
                                    item.name || d.fcGeneralDeck
                                  )
                                : item.kind === 'revision'
                                  ? d.activityGeneratedNote(
                                      item.name || d.revAllDocuments
                                    )
                                  : d.activityCreatedSubject(item.name)}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-slate-400">
                        {formatDate(item.at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          )}
        </main>
      </div>

      {/* ── Mobile bottom tab bar ───────────────────────────── */}
      <MobileTabBar
        active={activeNav}
        onNavigate={(id) =>
          handleNav(
            id,
            NAV_SECTIONS.flatMap((s) => s.items).find((i) => i.id === id)
              ?.label ?? id
          )
        }
      />

      {/* ── Create subject dialog ────────────────────────────── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="font-brand rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">
              {d.createDlgTitle}
            </DialogTitle>
            <DialogDescription className="text-sm text-slate-500">
              {d.createDlgDesc}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="subject-name" className="text-sm">
                {d.dlgNameLabel}
              </Label>
              <Input
                id="subject-name"
                value={subjectName}
                onChange={(e) => {
                  setSubjectName(e.target.value);
                  setNameError(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleCreate();
                  }
                }}
                placeholder={d.dlgNamePlaceholder}
                maxLength={80}
                autoFocus
                aria-invalid={nameError}
                className={nameError ? 'border-rose-400' : undefined}
              />
              {nameError && (
                <p className="text-xs text-rose-600">{d.dlgErrName}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-sm">{d.dlgColorLabel}</Label>
              <div className="flex items-center gap-2.5">
                {SUBJECT_COLORS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setSubjectColor(c.value)}
                    aria-label={c.value}
                    aria-pressed={subjectColor === c.value}
                    className={`h-7 w-7 rounded-full ${c.swatch} transition ${
                      subjectColor === c.value
                        ? 'ring-2 ring-slate-700 ring-offset-2'
                        : 'opacity-80 hover:opacity-100'
                    }`}
                  />
                ))}
              </div>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              className="rounded-lg"
            >
              {d.dlgCancel}
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={creating}
              className="rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {creating && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {d.dlgCreate}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Rename subject dialog ────────────────────────────── */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogContent className="font-brand rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">
              {d.subjRenameDlgTitle}
            </DialogTitle>
            <DialogDescription className="text-sm text-slate-500">
              {d.subjRenameDlgDesc}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5 py-1">
            <Label htmlFor="rename-subject-name" className="text-sm">
              {d.dlgNameLabel}
            </Label>
            <Input
              id="rename-subject-name"
              value={renameName}
              onChange={(e) => {
                setRenameName(e.target.value);
                setRenameError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleRename();
                }
              }}
              placeholder={d.dlgNamePlaceholder}
              maxLength={80}
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
              {d.dlgSave}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete subject confirmation ──────────────────────── */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent className="font-brand rounded-2xl sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-lg font-semibold">
              {d.subjDeleteDlgTitle}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm leading-relaxed">
              {deleteTarget ? d.subjDeleteDlgDesc(deleteTarget.name) : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel className="rounded-lg">
              {d.dlgCancel}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDelete()}
              disabled={deleting}
              className="rounded-lg bg-rose-600 text-white hover:bg-rose-700"
            >
              {deleting && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {d.deleteSubject}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
