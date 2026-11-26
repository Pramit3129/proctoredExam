"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { formatDateTime } from "@/lib/format";
import type { StudentExam } from "@/lib/exam-types";

import { api, errorMessage, useSessionUser } from "../api";
import { AppHeader } from "../app-header";
import { CheckIcon, ChevronRight, ClockIcon, DocIcon } from "../icons";
import { Badge, Card, EmptyState, LoadingScreen, Notice, cx, type Tone } from "../ui";

export function attemptsLeft(exam: StudentExam): number {
  return Math.max(0, exam.attemptsAllowed - exam.attemptsUsed);
}

export function availabilityBadge(exam: StudentExam): { tone: Tone; label: string } {
  switch (exam.availability) {
    case "available":
      return { tone: "accent", label: exam.attemptsUsed > 0 ? "Attempt available" : "Ready" };
    case "upcoming":
      return { tone: "neutral", label: exam.opensAt ? `Opens ${formatDateTime(exam.opensAt)}` : "Upcoming" };
    case "closed":
      return { tone: "neutral", label: "Closed" };
    case "in_progress":
      return { tone: "warn", label: "Open in another window" };
    case "no_attempts":
      return { tone: "ok", label: "Completed" };
  }
}

export function StudentHome() {
  const { user } = useSessionUser();
  const [exams, setExams] = useState<StudentExam[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    api<{ exams: StudentExam[] }>("/api/exams")
      .then((d) => setExams(d.exams))
      .catch((e) => setError(errorMessage(e)));
  }, [user]);

  const firstName = user?.name.split(" ")[0];

  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-10 pb-16 sm:px-6">
        <div className="animate-enter">
          <p className="text-[15px] text-muted">{firstName ? `Hello, ${firstName}` : " "}</p>
          <h1 className="text-display mt-1">Your exams</h1>
        </div>

        {error && <Notice className="mt-8">{error}</Notice>}
        {!exams && !error && <LoadingScreen label="Loading your exams…" />}

        {exams && exams.length === 0 && (
          <Card className="mt-8">
            <EmptyState icon={<DocIcon size={22} />} title="No exams right now" body="When your administrator publishes an exam for you, it will appear here." />
          </Card>
        )}

        {exams && exams.length > 0 && (
          <ul className="mt-8 grid gap-3">
            {exams.map((exam, i) => {
              const badge = availabilityBadge(exam);
              const left = attemptsLeft(exam);
              const done = exam.availability === "no_attempts" || (exam.lastAttempt && exam.lastAttempt.status !== "active" && left === 0);
              return (
                <li key={exam.code} className="animate-enter" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
                  <Link
                    href={`/exam/${encodeURIComponent(exam.code)}`}
                    className="pressable focus-ring group flex items-center gap-4 rounded-[18px] bg-surface p-5 shadow-[var(--shadow-sm)] ring-1 ring-line hover:shadow-[var(--shadow-md)] sm:p-6"
                  >
                    <span
                      className={cx(
                        "hidden size-12 shrink-0 items-center justify-center rounded-[14px] sm:flex",
                        done ? "bg-ok-soft text-ok" : "bg-accent-soft text-accent",
                      )}
                    >
                      {done ? <CheckIcon size={22} strokeWidth={2.2} /> : <DocIcon size={22} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-headline truncate">{exam.title}</h2>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </div>
                      {exam.subtitle && <p className="mt-0.5 truncate text-[14px] text-muted">{exam.subtitle}</p>}
                      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
                        <span className="inline-flex items-center gap-1.5">
                          <ClockIcon size={15} /> {exam.durationMinutes} min
                        </span>
                        <span>{exam.questionCount} questions</span>
                        <span>
                          {left} of {exam.attemptsAllowed} attempt{exam.attemptsAllowed === 1 ? "" : "s"} left
                        </span>
                        {exam.closesAt && exam.availability === "available" && <span>Closes {formatDateTime(exam.closesAt)}</span>}
                      </p>
                    </div>
                    <ChevronRight className="shrink-0 text-subtle transition-transform duration-200 group-hover:translate-x-0.5" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </>
  );
}
