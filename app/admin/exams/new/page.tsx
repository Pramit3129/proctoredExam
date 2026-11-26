import type { Metadata } from "next";

import { ExamCreate } from "../../../_components/admin/exam-create";

export const metadata: Metadata = { title: "New exam" };

export default function NewExamPage() {
  return <ExamCreate />;
}
