import type { Metadata } from "next";
import { Suspense } from "react";

import { AttemptDetailView } from "../../../_components/admin/attempt-detail";
import { LoadingScreen } from "../../../_components/ui";

export const metadata: Metadata = { title: "Attempt" };

export default function AttemptPage({ params }: PageProps<"/admin/attempts/[id]">) {
  return <Suspense fallback={<LoadingScreen />}>{params.then(({ id }) => <AttemptDetailView id={id} />)}</Suspense>;
}
