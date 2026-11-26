import type { Metadata } from "next";
import { Suspense } from "react";

import { ExamLoader } from "../../_components/exam/exam-loader";
import { LoadingScreen } from "../../_components/ui";

export const metadata: Metadata = { title: "Exam" };

export default function ExamPage({ params }: PageProps<"/exam/[code]">) {
  return (
    <Suspense fallback={<LoadingScreen label="Loading exam…" />}>
      {params.then(({ code }) => (
        <ExamLoader code={decodeURIComponent(code).toUpperCase()} />
      ))}
    </Suspense>
  );
}
