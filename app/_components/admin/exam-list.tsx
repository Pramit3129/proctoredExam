"use client";

import Link from "next/link";
import { useState } from "react";

import { formatDate, formatPercent } from "@/lib/format";
import type { AdminExamSummary } from "@/lib/exam-types";

import { usePoll } from "../hooks/use-poll";
import { DocIcon, PlusIcon } from "../icons";
import { Badge, Card, EmptyState, LoadingScreen, Notice, Toggle, buttonClasses } from "../ui";
import { AdminPage } from "./admin-shell";
import { EXAM_STATUS } from "./labels";
import { RowLink, Td, Th } from "./overview";

export function AdminExamList() {
  const [archived, setArchived] = useState(false);
  const { data, error } = usePoll<{ exams: AdminExamSummary[] }>(`/api/admin/exams${archived ? "?archived=1" : ""}`, 30_000);

  return (
    <AdminPage
      title="Exams"
      actions={
        <Link href="/admin/exams/new" className={buttonClasses("primary")}>
          <PlusIcon size={17} /> New exam
        </Link>
      }
    >
      {error && <Notice className="mb-4">{error}</Notice>}
      {!data && !error && <LoadingScreen />}
      {data && (
        <Card className="overflow-hidden">
          {data.exams.length === 0 ? (
            <EmptyState
              icon={<DocIcon size={22} />}
              title="No exams yet"
              body="Create one from a question paper and answer key."
              action={
                <Link href="/admin/exams/new" className={buttonClasses("primary", "sm")}>
                  Create exam
                </Link>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px]">
                <thead className="border-b border-line">
                  <tr>
                    <Th>Exam</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Questions</Th>
                    <Th className="text-right">Duration</Th>
                    <Th className="text-right">Completed</Th>
                    <Th className="text-right">Average</Th>
                    <Th className="text-right">Flagged</Th>
                    <Th>Created</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.exams.map((e) => (
                    <tr key={e.id} className="hover:bg-surface-2/60">
                      <Td>
                        <RowLink href={`/admin/exams/${e.id}`}>{e.title}</RowLink>
                        <p className="font-mono text-[12px] text-muted">{e.code}</p>
                      </Td>
                      <Td>
                        <Badge tone={EXAM_STATUS[e.status].tone}>{EXAM_STATUS[e.status].label}</Badge>
                        {e.stats.active > 0 && (
                          <Badge tone="accent" className="ml-1.5">
                            {e.stats.active} live
                          </Badge>
                        )}
                      </Td>
                      <Td className="text-right tabular-nums">{e.questionCount}</Td>
                      <Td className="text-right tabular-nums">{e.durationMinutes} min</Td>
                      <Td className="text-right tabular-nums">{e.stats.completed}</Td>
                      <Td className="text-right font-medium tabular-nums">{formatPercent(e.stats.averagePercent)}</Td>
                      <Td className="text-right tabular-nums">{e.stats.flagged > 0 ? <Badge tone="warn">{e.stats.flagged}</Badge> : "0"}</Td>
                      <Td className="whitespace-nowrap text-muted">{formatDate(e.createdAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      <div className="mt-4 max-w-sm px-1">
        <Toggle label="Show archived exams" checked={archived} onChange={setArchived} />
      </div>
    </AdminPage>
  );
}
