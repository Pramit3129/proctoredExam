import type { Metadata } from "next";
import { Suspense } from "react";

import { ExamDetail } from "../../../_components/admin/exam-detail";
import { LoadingScreen } from "../../../_components/ui";

export const metadata: Metadata = { title: "Exam" };

export default function AdminExamPage({ params }: PageProps<"/admin/exams/[id]">) {
  return <Suspense fallback={<LoadingScreen />}>{params.then(({ id }) => <ExamDetail id={id} />)}</Suspense>;
}
