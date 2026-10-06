'use client';

/**
 * Profile section — the signed-in user's account card, rebuilt 1:1 with the
 * reference design: gradient banner + profile photo (upload via click /
 * remove via the ✕ badge), an "Edit Profile" dialog (name, college,
 * semester), the Google Account linking card, three learning-stat cards and
 * the Account Details table.
 *
 * Everything persists: photo / college / semester go through PATCH
 * /api/profile, name changes flow back into the client session via
 * `onUserChanged` so the sidebar + header avatar update live.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  CalendarDays,
  FileText,
  GraduationCap,
  Link2,
  Loader2,
  Mail,
  Pencil,
  ShieldCheck,
  Trophy,
  User as UserIcon,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { useLanguage } from '@/lib/i18n';
import { initials, type SessionUser } from '@/lib/session';

/** True when the app runs inside an iframe (the sandbox preview panel
 *  does). Google's consent page sends X-Frame-Options: DENY, so inside
 *  a frame the OAuth flow MUST be launched in a real browser tab. */
const RUNS_IN_IFRAME = (() => {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin frame access threw → we are framed
  }
})();

type ProfileData = {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  emailVerified: string | null;
  avatar: string | null;
  college: string | null;
  semester: string | null;
  googleLinked: boolean;
  googleEmail: string | null;
  authProvider: 'email' | 'google';
};

type Stats = {
  subjects: number;
  pdfs: number;
  quizCount: number;
};

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB (matches the photo hint copy)

export default function ProfileView({
  user,
  onUserChanged,
}: {
  user: SessionUser;
  onUserChanged: (user: SessionUser) => void;
}) {
  const { toast } = useToast();
  const { t } = useLanguage();
  const d = t.dashboard;

  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  /* Edit dialog */
  const [editOpen, setEditOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [collegeDraft, setCollegeDraft] = useState('');
  const [semesterDraft, setSemesterDraft] = useState('');
  const [nameError, setNameError] = useState(false);
  const [saving, setSaving] = useState(false);

  /* Photo upload */
  const fileRef = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);

  /* Google link availability check */
  const [googleChecking, setGoogleChecking] = useState(false);

  /* Load profile + stats */
  useEffect(() => {
    let cancelled = false;
    const q = encodeURIComponent(user.email);
    (async () => {
      try {
        const [pRes, sRes] = await Promise.all([
          fetch(`/api/profile?email=${q}`),
          fetch(`/api/progress?email=${q}`),
        ]);
        const pJson = (await pRes.json().catch(() => null)) as {
          ok?: boolean;
          profile?: ProfileData;
        } | null;
        const sJson = (await sRes.json().catch(() => null)) as {
          ok?: boolean;
          progress?: Stats;
        } | null;
        if (cancelled) return;
        if (pRes.ok && pJson?.ok && pJson.profile) {
          setProfile(pJson.profile);
          // Keep the session identity in sync (e.g. photo changed on another
          // tab, or the session predates the avatar feature).
          const fresh = pJson.profile;
          if (fresh.name !== user.name || (fresh.avatar ?? undefined) !== user.avatar) {
            onUserChanged({
              name: fresh.name,
              email: user.email,
              avatar: fresh.avatar ?? undefined,
            });
          }
        } else {
          toast({ title: d.pfLoadFailed, variant: 'destructive' });
        }
        if (sRes.ok && sJson?.ok && sJson.progress) setStats(sJson.progress);
      } catch {
        if (!cancelled) {
          toast({ title: d.pfLoadFailed, variant: 'destructive' });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user.email]);

  /* ── Profile photo ──────────────────────────────────────────── */

  const applyAvatar = useCallback(
    async (dataUrl: string | null) => {
      if (avatarBusy) return;
      const prev = profile?.avatar ?? null;
      if (prev === dataUrl) return;
      setAvatarBusy(true);
      setProfile((p) => (p ? { ...p, avatar: dataUrl } : p)); // optimistic
      try {
        const res = await fetch('/api/profile', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: user.email, avatar: dataUrl }),
        });
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          profile?: ProfileData;
        } | null;
        if (res.ok && json?.ok && json.profile) {
          setProfile(json.profile);
          onUserChanged({
            name: json.profile.name,
            email: user.email,
            avatar: json.profile.avatar ?? undefined,
          });
          toast({ title: dataUrl ? d.pfPhotoSaved : d.pfPhotoRemoved });
        } else {
          setProfile((p) => (p ? { ...p, avatar: prev } : p)); // revert
          toast({ title: d.pfPhotoFailed, variant: 'destructive' });
        }
      } catch {
        setProfile((p) => (p ? { ...p, avatar: prev } : p)); // revert
        toast({ title: d.pfPhotoFailed, variant: 'destructive' });
      } finally {
        setAvatarBusy(false);
      }
    },
    [avatarBusy, profile?.avatar, user.email, onUserChanged, toast, d]
  );

  /** Read the picked file, center-crop to 256×256 and upload as JPEG.
   *  (Canvas resize keeps the stored data URL small; animated GIFs keep
   *  only their first frame — accepted trade-off for a 2 MB input limit.) */
  const handleFile = useCallback(
    (file: File | undefined | null) => {
      if (!file) return;
      if (!ALLOWED_TYPES.includes(file.type)) {
        toast({ title: d.pfPhotoBadType, variant: 'destructive' });
        return;
      }
      if (file.size > MAX_BYTES) {
        toast({ title: d.pfPhotoTooBig, variant: 'destructive' });
        return;
      }
      const url = URL.createObjectURL(file);
      const img = new window.Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const S = 256;
        const canvas = document.createElement('canvas');
        canvas.width = S;
        canvas.height = S;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          toast({ title: d.pfPhotoFailed, variant: 'destructive' });
          return;
        }
        const scale = Math.max(S / img.naturalWidth, S / img.naturalHeight);
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        ctx.drawImage(img, (S - w) / 2, (S - h) / 2, w, h);
        void applyAvatar(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        toast({ title: d.pfPhotoFailed, variant: 'destructive' });
      };
      img.src = url;
    },
    [applyAvatar, toast, d]
  );

  /* ── Edit dialog ────────────────────────────────────────────── */

  const openEdit = () => {
    setNameDraft(profile?.name ?? user.name);
    setCollegeDraft(profile?.college ?? '');
    setSemesterDraft(profile?.semester ?? '');
    setNameError(false);
    setEditOpen(true);
  };

  const saveDetails = useCallback(async () => {
    const name = nameDraft.trim();
    if (!name) {
      setNameError(true);
      return;
    }
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: user.email,
          name,
          college: collegeDraft.trim(),
          semester: semesterDraft.trim(),
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        profile?: ProfileData;
      } | null;
      if (res.ok && json?.ok && json.profile) {
        setProfile(json.profile);
        onUserChanged({
          name: json.profile.name,
          email: user.email,
          avatar: json.profile.avatar ?? undefined,
        });
        setEditOpen(false);
        toast({ title: d.pfSavedTitle, description: d.pfSavedDesc });
      } else {
        toast({ title: d.pfLoadFailed, variant: 'destructive' });
      }
    } catch {
      toast({ title: d.pfLoadFailed, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }, [
    nameDraft,
    collegeDraft,
    semesterDraft,
    saving,
    user.email,
    onUserChanged,
    toast,
    d,
  ]);

  /* ── Google account link / unlink ───────────────────────────── */

  const handleGoogleLink = useCallback(async () => {
    if (googleChecking) return;
    setGoogleChecking(true);
    try {
      /* origin is REQUIRED by /api/auth/google/url — without it the
       * route 400s (invalidOrigin) and linking always failed. */
      const res = await fetch(
        `/api/auth/google/url?origin=${encodeURIComponent(window.location.origin)}`
      );
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        configured?: boolean;
        url?: string | null;
      } | null;
      if (json?.ok && json.configured && json.url) {
        /* Google's consent page sends X-Frame-Options: DENY — it cannot
         * render inside the preview-panel iframe. In a frame we open
         * the flow in a real tab and poll /api/profile until the link
         * lands; top-level keeps the classic same-tab navigation. */
        if (RUNS_IN_IFRAME) {
          /* no 'noopener': the bridge page relays the signed payload
           * back to this frame through window.opener (same-origin). */
          const popup = window.open(json.url, '_blank');
          if (!popup) {
            toast({
              title: d.pfGoogleUnavailableTitle,
              description: d.pfGoogleUnavailableDesc,
            });
            return;
          }
          const started = Date.now();
          while (Date.now() - started < 120_000) {
            await new Promise((r) => setTimeout(r, 2500));
            try {
              const chk = await fetch(
                `/api/profile?email=${encodeURIComponent(user.email)}`
              );
              const cj = (await chk.json().catch(() => null)) as {
                ok?: boolean;
                profile?: ProfileData;
              } | null;
              if (cj?.ok && cj.profile?.googleLinked) {
                setProfile(cj.profile);
                toast({
                  title: d.pfGoogleConnectedAs(
                    cj.profile.googleEmail ?? user.email
                  ),
                });
                return;
              }
            } catch {
              /* transient — keep polling until the deadline */
            }
          }
          return; // deadline reached — user can retry manually
        }
        window.location.href = json.url;
        return;
      }
      toast({
        title: d.pfGoogleUnavailableTitle,
        description: d.pfGoogleUnavailableDesc,
      });
    } catch {
      toast({
        title: d.pfGoogleUnavailableTitle,
        description: d.pfGoogleUnavailableDesc,
      });
    } finally {
      setGoogleChecking(false);
    }
  }, [googleChecking, toast, d, user.email]);

  const handleGoogleUnlink = useCallback(async () => {
    if (googleChecking) return;
    setGoogleChecking(true);
    try {
      const res = await fetch('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, googleUnlink: true }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        profile?: ProfileData;
      } | null;
      if (res.ok && json?.ok && json.profile) {
        setProfile(json.profile);
        toast({ title: d.pfSavedTitle, description: d.pfSavedDesc });
      } else {
        toast({ title: d.pfLoadFailed, variant: 'destructive' });
      }
    } catch {
      toast({ title: d.pfLoadFailed, variant: 'destructive' });
    } finally {
      setGoogleChecking(false);
    }
  }, [googleChecking, user.email, toast, d]);

  /* ── Derived render data ────────────────────────────────────── */

  const displayName = profile?.name ?? user.name;
  const avatar = profile ? (profile.avatar ?? null) : (user.avatar ?? null);
  const memberSince = profile ? formatDate(profile.createdAt, false) : null;

  const INFO: {
    icon: typeof Mail;
    label: string;
    value: string | null;
  }[] = [
    { icon: Mail, label: d.pfEmail, value: user.email },
    { icon: GraduationCap, label: d.pfCollege, value: profile?.college ?? null },
    { icon: CalendarDays, label: d.pfSemester, value: profile?.semester ?? null },
    { icon: ShieldCheck, label: d.pfRole, value: d.pfStudent },
  ];

  const STAT_CARDS: {
    icon: typeof BookOpen;
    tint: string;
    value: number | undefined;
    label: string;
  }[] = [
    {
      icon: BookOpen,
      tint: 'bg-blue-50 text-blue-600',
      value: stats?.subjects,
      label: d.pfStatSubjects,
    },
    {
      icon: FileText,
      tint: 'bg-rose-50 text-rose-600',
      value: stats?.pdfs,
      label: d.pfStatPdfsUploaded,
    },
    {
      icon: Trophy,
      tint: 'bg-amber-50 text-amber-600',
      value: stats?.quizCount,
      label: d.pfStatQuizzesTaken,
    },
  ];

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <h1 className="sr-only">{d.pfTitle}</h1>
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          handleFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      {loading ? (
        <div className="mt-2 flex items-center justify-center rounded-2xl border border-slate-200 bg-white py-14 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (
        <>
          {/* ── Identity card ─────────────────────────────────── */}
          <section
            aria-label={d.pfTitle}
            className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
          >
            <div
              className="h-24 bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 sm:h-28"
              aria-hidden="true"
            />
            <div className="px-5 pb-6 sm:px-6">
              {/* Avatar + Edit Profile button */}
              <div className="flex items-start justify-between gap-3">
                <div className="relative -mt-12 h-24 w-24 shrink-0">
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    aria-label={d.pfPhotoChange}
                    aria-haspopup="dialog"
                    className="block h-24 w-24 overflow-hidden rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-md ring-2 ring-white transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 hover:brightness-95"
                  >
                    {avatar ? (
                      <img
                        src={avatar}
                        alt={d.pfPhotoChange}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-2xl font-semibold text-white">
                        {initials(displayName)}
                      </span>
                    )}
                  </button>
                  {avatar && !avatarBusy && (
                    <button
                      type="button"
                      onClick={() => void applyAvatar(null)}
                      aria-label={d.pfPhotoRemove}
                      className="absolute -right-2 -top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-rose-500 text-white shadow-md transition hover:bg-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400 focus-visible:ring-offset-2"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}
                  {avatarBusy && (
                    <span
                      className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-slate-900/40"
                      aria-hidden="true"
                    >
                      <Loader2 className="h-5 w-5 animate-spin text-white" />
                    </span>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openEdit}
                  className="mt-2 shrink-0 gap-1.5 rounded-lg border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  {d.pfEditProfile}
                </Button>
              </div>

              <p className="mt-2.5 text-xs text-slate-400">{d.pfPhotoHint}</p>

              <h2 className="mt-3 text-xl font-bold tracking-tight text-slate-900">
                {displayName}
              </h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                  {d.pfStudent}
                </span>
                {memberSince && (
                  <span className="text-xs text-slate-500">
                    {d.pfMemberSince(memberSince)}
                  </span>
                )}
              </div>

              {/* Contact / academic info grid */}
              <div className="mt-5 border-t border-slate-100 pt-5">
                <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                  {INFO.map((item) => (
                    <div key={item.label} className="flex items-center gap-3">
                      <span
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                          item.value
                            ? 'bg-blue-50 text-blue-600'
                            : 'bg-slate-100 text-slate-400'
                        }`}
                      >
                        <item.icon
                          className="h-[18px] w-[18px]"
                          aria-hidden="true"
                        />
                      </span>
                      <span className="min-w-0">
                        <dt className="text-xs text-slate-400">{item.label}</dt>
                        <dd
                          className={`truncate text-sm font-medium ${
                            item.value ? 'text-slate-800' : 'text-slate-400'
                          }`}
                        >
                          {item.value || d.pfNotSet}
                        </dd>
                      </span>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </section>

          {/* ── Google Account ────────────────────────────────── */}
          <section
            aria-label={d.pfGoogleAccount}
            className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-6"
          >
            <div className="flex items-center gap-2.5">
              <GoogleIcon className="h-5 w-5 shrink-0" />
              <h2 className="text-base font-semibold text-slate-800">
                {d.pfGoogleAccount}
              </h2>
            </div>
            <div className="mt-4 flex items-center gap-3.5 rounded-xl bg-slate-50 p-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white shadow-[0_1px_3px_rgba(15,23,42,0.12)]">
                {profile?.googleLinked ? (
                  <GoogleIcon className="h-5 w-5" />
                ) : (
                  <UserIcon
                    className="h-5 w-5 text-slate-400"
                    aria-hidden="true"
                  />
                )}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-slate-800">
                  {profile?.googleLinked
                    ? d.pfGoogleConnectedAs(profile.googleEmail ?? user.email)
                    : d.pfGoogleNotConnected}
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  {profile?.googleLinked
                    ? d.pfGoogleConnectedDesc
                    : d.pfGoogleNotConnectedDesc}
                </span>
              </span>
            </div>
            <div className="mt-4">
              {profile?.googleLinked ? (
                <Button
                  variant="outline"
                  onClick={() => void handleGoogleUnlink()}
                  disabled={googleChecking}
                  className="rounded-lg text-sm"
                >
                  {googleChecking && (
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  )}
                  {d.pfUnlinkGoogle}
                </Button>
              ) : (
                <Button
                  onClick={() => void handleGoogleLink()}
                  disabled={googleChecking}
                  className="gap-2 rounded-lg bg-emerald-600 text-sm text-white hover:bg-emerald-700"
                >
                  {googleChecking ? (
                    <Loader2
                      className="h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Link2 className="h-4 w-4" aria-hidden="true" />
                  )}
                  {d.pfLinkGoogle}
                </Button>
              )}
            </div>
          </section>

          {/* ── Learning stats ────────────────────────────────── */}
          <section aria-label={d.pfStats} className="mt-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {STAT_CARDS.map((card) => (
                <div
                  key={card.label}
                  className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]"
                >
                  <span
                    className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${card.tint}`}
                  >
                    <card.icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-2xl font-bold leading-tight tabular-nums text-slate-800">
                      {card.value ?? '—'}
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {card.label}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </section>

          {/* ── Account details ───────────────────────────────── */}
          <section
            aria-label={d.pfAccountDetails}
            className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-6"
          >
            <div className="flex items-center gap-2">
              <UserIcon
                className="h-4 w-4 text-slate-500"
                aria-hidden="true"
              />
              <h2 className="text-base font-semibold text-slate-800">
                {d.pfAccountDetails}
              </h2>
            </div>
            <ul className="mt-4 divide-y divide-slate-100">
              <li className="flex items-center justify-between gap-3 py-3">
                <span className="text-sm text-slate-600">{d.pfUserId}</span>
                <code className="max-w-[14rem] truncate rounded-md bg-slate-100 px-2 py-1 font-mono text-xs text-slate-600 sm:max-w-[18rem]">
                  {profile?.id}
                </code>
              </li>
              <li className="flex items-center justify-between gap-3 py-3">
                <span className="text-sm text-slate-600">
                  {d.pfAuthProvider}
                </span>
                <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                  {profile?.authProvider === 'google'
                    ? d.pfAuthGoogle
                    : d.pfAuthEmailPw}
                </span>
              </li>
              <li className="flex items-center justify-between gap-3 py-3">
                <span className="text-sm text-slate-600">
                  {d.pfAccountCreated}
                </span>
                <span className="text-sm font-medium text-slate-800">
                  {profile ? formatDate(profile.createdAt, true) : '—'}
                </span>
              </li>
              <li className="flex items-center justify-between gap-3 py-3">
                <span className="text-sm text-slate-600">
                  {d.pfAccountType}
                </span>
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                  {d.pfStudent}
                </span>
              </li>
            </ul>
          </section>
        </>
      )}

      {/* ── Edit Profile dialog ─────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{d.pfEditProfile}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pf-name">{d.pfNameLabel}</Label>
              <Input
                id="pf-name"
                value={nameDraft}
                onChange={(e) => {
                  setNameDraft(e.target.value);
                  setNameError(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void saveDetails();
                  }
                }}
                maxLength={80}
                aria-invalid={nameError}
                className={nameError ? 'border-rose-400' : undefined}
                autoFocus
              />
              {nameError && (
                <p className="text-xs text-rose-600">{d.pfErrName}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-college">{d.pfCollegeLabel}</Label>
              <Input
                id="pf-college"
                value={collegeDraft}
                onChange={(e) => setCollegeDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void saveDetails();
                  }
                }}
                placeholder={d.pfCollegePh}
                maxLength={120}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pf-semester">{d.pfSemesterLabel}</Label>
              <Input
                id="pf-semester"
                value={semesterDraft}
                onChange={(e) => setSemesterDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void saveDetails();
                  }
                }}
                placeholder={d.pfSemesterPh}
                maxLength={40}
              />
            </div>
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setEditOpen(false)}
              disabled={saving}
              className="rounded-lg"
            >
              {d.dlgCancel}
            </Button>
            <Button
              onClick={() => void saveDetails()}
              disabled={saving}
              className="rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {saving && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              {d.pfSave}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Multicolour Google "G" (inline so it needs no asset + works offline). */
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"
      />
    </svg>
  );
}

/** Locale-aware date: "August 2026" (`withDay=false`) or "August 31, 2026". */
function formatDate(iso: string, withDay: boolean): string {
  try {
    return new Date(iso).toLocaleDateString(
      undefined,
      withDay
        ? { month: 'long', day: 'numeric', year: 'numeric' }
        : { month: 'long', year: 'numeric' }
    );
  } catch {
    return iso;
  }
}
