import type { Metadata } from "next";

import { AdminShell } from "../_components/admin/admin-shell";

export const metadata: Metadata = { title: { default: "Admin", template: "%s · Admin" } };

export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return <AdminShell>{children}</AdminShell>;
}
