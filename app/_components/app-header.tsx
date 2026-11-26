"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import type { SessionUser } from "@/lib/exam-types";

import { signOut } from "./api";
import { AppMark, LogoutIcon } from "./icons";
import { IconButton, cx } from "./ui";

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "")).toUpperCase() || "?";
}

export function Avatar({ name, size = 30 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-b from-[#a1a1a6] to-[#86868b] font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials(name)}
    </span>
  );
}

export function AppHeader({ user, children, wide }: { user: SessionUser | null; children?: ReactNode; wide?: boolean }) {
  return (
    <header className="material sticky top-0 z-30 border-b border-line">
      <div className={cx("mx-auto flex h-14 w-full items-center gap-4 px-4 sm:px-6", wide ? "max-w-[1400px]" : "max-w-5xl")}>
        <Link href="/" className="focus-ring flex items-center gap-2.5 rounded-lg">
          <AppMark size={26} />
          <span className="text-[17px] font-semibold tracking-[-0.02em]">Exams</span>
        </Link>
        <div className="flex-1">{children}</div>
        {user?.isAdmin && (
          <Link href="/admin" className="focus-ring rounded-full px-3 py-1.5 text-[14px] text-accent hover:bg-accent-soft">
            Admin
          </Link>
        )}
        {user && (
          <div className="flex items-center gap-2.5">
            <div className="hidden text-right sm:block">
              <p className="max-w-[200px] truncate text-[13px] font-medium leading-tight">{user.name}</p>
              <p className="max-w-[200px] truncate text-[12px] leading-tight text-muted">{user.email}</p>
            </div>
            <Avatar name={user.name} />
            <IconButton label="Sign out" onClick={() => void signOut()}>
              <LogoutIcon />
            </IconButton>
          </div>
        )}
      </div>
    </header>
  );
}
