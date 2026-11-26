"use client";

import dynamic from "next/dynamic";

import { LoadingScreen } from "../ui";

/** The exam is entirely browser-driven (camera, fullscreen, WASM), so it renders client-side only. */
const ExamApp = dynamic(() => import("./exam-app"), {
  ssr: false,
  loading: () => <LoadingScreen label="Loading exam…" />,
});

export function ExamLoader({ code }: { code: string }) {
  return <ExamApp code={code} />;
}
