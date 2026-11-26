"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { formatDateTime } from "@/lib/format";
import type { StudentExam } from "@/lib/exam-types";

import { CameraIcon, CheckIcon, ClockIcon, ExpandIcon, FlagIcon, ShieldIcon, WarningIcon } from "../icons";
import { attemptsLeft, availabilityBadge } from "../student/student-home";
import { Badge, Button, Card, Notice, cx } from "../ui";

function Rule({ icon, title, children, tone = "accent" }: { icon: ReactNode; title: string; children: ReactNode; tone?: "accent" | "danger" }) {
  return (
    <li className="flex gap-4 px-5 py-4">
      <span
        className={cx(
          "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[10px]",
          tone === "danger" ? "bg-danger-soft text-danger" : "bg-accent-soft text-accent",
        )}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[15px] font-medium">{title}</p>
        <p className="mt-0.5 text-[14px] text-muted text-pretty">{children}</p>
      </div>
    </li>
  );
}

export function Intro({ exam, onContinue }: { exam: StudentExam; onContinue: () => void }) {
  const [consent, setConsent] = useState(false);
  const left = attemptsLeft(exam);
  const badge = availabilityBadge(exam);
  const canStart = exam.availability === "available";

  let blocked: string | null = null;
  if (exam.availability === "no_attempts") {
    blocked = "You have used all your attempts for this exam. Your administrator will share results. Contact them if you need another attempt.";
  } else if (exam.availability === "upcoming") {
    blocked = exam.opensAt ? `This exam opens ${formatDateTime(exam.opensAt)}.` : "This exam has not opened yet.";
  } else if (exam.availability === "closed") {
    blocked = "This exam is closed.";
  } else if (exam.availability === "in_progress") {
    blocked = null;
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-10 pb-16 sm:px-6">
      <Link href="/" className="focus-ring rounded text-[14px] text-accent hover:underline">
        ‹ All exams
      </Link>
      <div className="mt-6 grid gap-8 lg:grid-cols-[1.15fr_1fr]">
        <section className="animate-enter">
          <Badge tone={badge.tone}>{badge.label}</Badge>
          <h1 className="text-display mt-3 text-balance">{exam.title}</h1>
          {exam.subtitle && <p className="mt-2 text-[17px] text-muted text-pretty">{exam.subtitle}</p>}
          <dl className="mt-6 grid grid-cols-3 gap-3">
            {[
              ["Duration", `${exam.durationMinutes} min`],
              ["Questions", String(exam.questionCount)],
              ["Attempts left", `${left} of ${exam.attemptsAllowed}`],
            ].map(([k, v]) => (
              <Card key={k} className="px-4 py-3">
                <dt className="text-[12px] text-muted">{k}</dt>
                <dd className="mt-0.5 text-[20px] font-semibold tracking-[-0.02em] tabular-nums">{v}</dd>
              </Card>
            ))}
          </dl>
          {(exam.description || exam.instructions) && (
            <div className="mt-6 space-y-3 text-[15px] leading-relaxed text-muted text-pretty">
              {exam.description && <p>{exam.description}</p>}
              {exam.instructions && <p className="whitespace-pre-line">{exam.instructions}</p>}
            </div>
          )}
        </section>

        <section className="animate-enter space-y-4" style={{ animationDelay: "60ms" }}>
          <Card>
            <p className="text-eyebrow px-5 pt-4 text-muted">Before you begin</p>
            <ul className="divide-y divide-line">
              <Rule icon={<ExpandIcon size={18} />} title="Full screen, the whole time" tone="danger">
                The exam opens in full screen. <strong className="font-medium text-foreground">Leaving full screen submits your exam immediately</strong>{" "}
                and uses up this attempt.
              </Rule>
              {exam.strictFocus && (
                <Rule icon={<WarningIcon size={18} />} title="Stay on this window" tone="danger">
                  Switching to another tab or app, closing or reloading the page, or locking your screen also submits the exam.
                </Rule>
              )}
              <Rule icon={<CameraIcon size={18} />} title="Camera and microphone on">
                Face position and voice activity are analysed on your device. Video and audio are not recorded; only timestamped events are
                stored for review.
              </Rule>
              <Rule icon={<CheckIcon size={18} />} title="Answers save as you go">
                Every answer is saved the moment you choose it. Unanswered questions score zero.
              </Rule>
              <Rule icon={<FlagIcon size={18} />} title="Results come later">
                You won&apos;t see a score when you finish. Your administrator will release results.
              </Rule>
              <Rule icon={<ClockIcon size={18} />} title="Timed">
                The timer starts when the exam opens and the exam submits itself when time is up.
              </Rule>
            </ul>
          </Card>

          {blocked ? (
            <Notice tone="neutral">{blocked}</Notice>
          ) : (
            <Card className="p-5">
              {exam.availability === "in_progress" && (
                <Notice tone="warn" className="mb-4">
                  This exam is open in another window. Starting here will submit that attempt.
                </Notice>
              )}
              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 size-[18px] shrink-0 accent-[var(--accent)]"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span className="text-[14px] text-pretty">
                  I agree to camera, microphone and browser monitoring for the length of this exam, and I understand that leaving full screen
                  submits my exam.
                </span>
              </label>
              <Button size="lg" className="mt-5 w-full" disabled={!consent || (!canStart && exam.availability !== "in_progress")} onClick={onContinue}>
                <ShieldIcon size={18} /> Continue to system check
              </Button>
            </Card>
          )}
        </section>
      </div>
    </main>
  );
}
