import type { Metadata } from "next";

import { AdminExamList } from "../../_components/admin/exam-list";

export const metadata: Metadata = { title: "Exams" };

export default function AdminExamsPage() {
  return <AdminExamList />;
}
