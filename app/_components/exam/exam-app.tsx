"use client";

import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { useEffect, useState } from "react";

import type { SessionUser, StudentExam } from "@/lib/exam-types";
import { ProctorEngine, type EngineStatus } from "@/lib/proctor/client/engine";
import { releaseKeyboardLock } from "@/lib/proctor/client/environment-monitor";
import { collectClientInfo, stopMedia, type AcquiredMedia } from "@/lib/proctor/client/media";
import type { Baseline } from "@/lib/proctor/client/vision";
import type { EndReason, SessionBootstrap } from "@/lib/proctor/protocol";

import { ApiError, api, errorMessage, useSessionUser } from "../api";
import { AppHeader } from "../app-header";
import { LoadingScreen, Notice } from "../ui";
import { ExamRoom } from "./exam-room";
import { Finished } from "./finished";
import { Intro } from "./intro";
import { SystemCheck } from "./system-check";

export interface ReadyMedia {
  media: AcquiredMedia;
  video: HTMLVideoElement;
  landmarker: FaceLandmarker;
  baseline: Baseline;
}

type Phase =
  | { name: "loading" }
  | { name: "error"; message: string }
  | { name: "intro"; exam: StudentExam }
  | { name: "checks"; exam: StudentExam }
  | { name: "exam"; exam: StudentExam; boot: SessionBootstrap; engine: ProctorEngine; ready: ReadyMedia }
  | { name: "finished"; exam: StudentExam; status: EngineStatus; reason: EndReason | null };

export default function ExamApp({ code }: { code: string }) {
  const { user } = useSessionUser();
  const [phase, setPhase] = useState<Phase>({ name: "loading" });

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api<{ exam: StudentExam }>(`/api/exams/${encodeURIComponent(code)}`)
      .then(({ exam }) => !cancelled && setPhase({ name: "intro", exam }))
      .catch((e) => !cancelled && setPhase({ name: "error", message: errorMessage(e) }));
    return () => {
      cancelled = true;
    };
  }, [user, code]);

  async function startExam(exam: StudentExam, ready: ReadyMedia): Promise<void> {
    let boot: SessionBootstrap;
    try {
      boot = await api<SessionBootstrap>("/api/proctor/session", {
        method: "POST",
        json: { action: "start", examCode: exam.code, client: collectClientInfo(ready.media) },
      });
    } catch (e) {
      if (e instanceof ApiError && e.code === "no_attempts") {
        setPhase({ name: "intro", exam: { ...exam, availability: "no_attempts", attemptsUsed: exam.attemptsAllowed } });
      }
      throw e;
    }
    const engine = await ProctorEngine.start({ boot, ...ready });
    document.documentElement.classList.add("exam-locked");
    setPhase({ name: "exam", exam, boot, engine, ready });
  }

  function finish(status: EngineStatus, reason: EndReason | null): void {
    if (phase.name !== "exam") return;
    phase.engine.dispose();
    stopMedia(phase.ready.media);
    phase.ready.video.remove();
    document.documentElement.classList.remove("exam-locked");
    releaseKeyboardLock();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    setPhase({ name: "finished", exam: phase.exam, status, reason });
  }

  switch (phase.name) {
    case "loading":
      return (
        <>
          <AppHeader user={user as SessionUser | null} />
          <LoadingScreen label="Loading exam…" />
        </>
      );
    case "error":
      return (
        <>
          <AppHeader user={user} />
          <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16">
            <Notice>{phase.message}</Notice>
          </main>
        </>
      );
    case "intro":
      return (
        <>
          <AppHeader user={user} />
          <Intro exam={phase.exam} onContinue={() => setPhase({ name: "checks", exam: phase.exam })} />
        </>
      );
    case "checks":
      return (
        <>
          <AppHeader user={user} />
          <SystemCheck
            exam={phase.exam}
            onBack={() => setPhase({ name: "intro", exam: phase.exam })}
            onStart={(ready) => startExam(phase.exam, ready)}
          />
        </>
      );
    case "exam":
      return <ExamRoom boot={phase.boot} engine={phase.engine} stream={phase.ready.media.stream} onFinished={finish} />;
    case "finished":
      return (
        <>
          <AppHeader user={user} />
          <Finished exam={phase.exam} status={phase.status} reason={phase.reason} />
        </>
      );
  }
}
