"use client";

import Link from "next/link";

import type { StudentExam } from "@/lib/exam-types";
import type { EngineStatus } from "@/lib/proctor/client/engine";
import type { EndReason } from "@/lib/proctor/protocol";

import { CheckIcon, WarningIcon } from "../icons";
import { buttonClasses } from "../ui";

const REASON_COPY: Partial<Record<EndReason, string>> = {
  fullscreen_exit: "Your exam was submitted automatically because you left full screen.",
  tab_hidden: "Your exam was submitted automatically because you switched away from the exam window.",
  page_left: "Your exam was submitted automatically because the exam page was closed or reloaded.",
  time_up: "Time ran out, so your exam was submitted automatically.",
  abandoned: "Your exam was submitted automatically after the connection was lost for too long.",
};

/** Shown after every ending. Never shows a score: results are for administrators. */
export function Finished({ exam, status, reason }: { exam: StudentExam; status: EngineStatus; reason: EndReason | null }) {
  const terminated = status === "terminated";
  const lost = status === "lost";
  const note = terminated
    ? "Your administrator ended this exam session."
    : lost
      ? "This exam session could not be verified, so it was closed. Your answers up to this point were saved."
      : reason
        ? (REASON_COPY[reason] ?? null)
        : null;

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="animate-enter w-full max-w-[460px] text-center">
        <span
          className={`mx-auto flex size-[72px] items-center justify-center rounded-full ${terminated || lost ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok"}`}
        >
          {terminated || lost ? <WarningIcon size={34} /> : <CheckIcon size={36} strokeWidth={2.4} />}
        </span>
        <h1 className="text-display mt-6 text-balance">{terminated ? "Exam ended" : "Thank you for completing the exam"}</h1>
        <p className="mt-3 text-[17px] text-muted text-pretty">
          Your responses to <span className="text-foreground">{exam.title}</span> have been recorded. Results will be shared by your administrator.
        </p>
        {note && <p className="mx-auto mt-5 max-w-sm rounded-[14px] bg-surface-3/60 px-4 py-3 text-[14px] text-muted text-pretty">{note}</p>}
        <Link href="/" className={buttonClasses("primary", "lg", "mt-8")}>
          Back to my exams
        </Link>
      </div>
    </main>
  );
}
