"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";

import { signOut, useSessionUser } from "../api";
import { Avatar } from "../app-header";
import { AppMark, DocIcon, GridIcon, LogoutIcon, PlusIcon, UsersIcon } from "../icons";
import { EmptyState, buttonClasses, cx } from "../ui";

const NAV = [
  { href: "/admin", label: "Overview", icon: GridIcon, exact: true },
  { href: "/admin/exams", label: "Exams", icon: DocIcon, exact: false },
  { href: "/admin/exams/new", label: "New exam", icon: PlusIcon, exact: true },
] as const;

function isActive(pathname: string, href: string, exact: boolean): boolean {
  if (exact) return pathname === href;
  return pathname === href || (pathname.startsWith(`${href}/`) && !pathname.startsWith("/admin/exams/new"));
}

function NavLinks({ pathname, layout }: { pathname: string | null; layout: "side" | "top" }) {
  return (
    <>
      {NAV.map(({ href, label, icon: Icon, exact }) => {
        const active = pathname !== null && isActive(pathname, href, exact);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cx(
              "focus-ring flex items-center gap-2.5 rounded-[10px] text-[14px] font-medium transition-colors duration-150",
              layout === "side" ? "h-9 px-3" : "h-8 shrink-0 px-3",
              active ? "bg-surface text-foreground shadow-[var(--shadow-sm)]" : "text-muted hover:bg-black/[0.04] hover:text-foreground",
            )}
          >
            <Icon size={17} className={active ? "text-accent" : undefined} />
            {label}
          </Link>
        );
      })}
    </>
  );
}

function ActiveNav({ layout }: { layout: "side" | "top" }) {
  return <NavLinks pathname={usePathname()} layout={layout} />;
}

/** Admin chrome: sidebar on desktop, top bar on small screens. Only users with an admin role get in. */
export function AdminShell({ children }: { children: ReactNode }) {
  // Page content always renders (it shows its own loading state, and every admin
  // API call checks the role on the server), so the static shell stays useful.
  const { user, forbidden } = useSessionUser({ requireAdmin: true });

  if (forbidden) {
    return (
      <main className="flex flex-1 items-center justify-center px-4">
        <EmptyState
          icon={<UsersIcon size={22} />}
          title="Administrators only"
          body="Your account doesn't have access to the exam dashboard."
          action={
            <Link href="/" className={buttonClasses("secondary")}>
              Go to my exams
            </Link>
          }
        />
      </main>
    );
  }

  return (
    <div className="flex min-h-dvh flex-1">
      <aside className="sticky top-0 hidden h-dvh w-[248px] shrink-0 flex-col border-r border-line bg-[#f0f0f3]/80 px-3 py-4 md:flex">
        <Link href="/admin" className="focus-ring mb-6 flex items-center gap-2.5 rounded-lg px-2">
          <AppMark size={28} />
          <div className="leading-tight">
            <p className="text-[15px] font-semibold tracking-[-0.015em]">Exams</p>
            <p className="text-[12px] text-muted">Admin</p>
          </div>
        </Link>
        <nav className="flex flex-col gap-0.5" aria-label="Admin">
          <Suspense fallback={<NavLinks pathname={null} layout="side" />}>
            <ActiveNav layout="side" />
          </Suspense>
        </nav>
        <div className="mt-auto space-y-1">
          <Link href="/" className="focus-ring flex h-9 items-center rounded-[10px] px-3 text-[14px] text-muted hover:bg-black/[0.04] hover:text-foreground">
            Student view
          </Link>
          <div className="flex items-center gap-2.5 rounded-[12px] px-2 py-2">
            {user ? <Avatar name={user.name} size={32} /> : <span className="size-8 rounded-full bg-surface-3" />}
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[13px] font-medium">{user?.name ?? "\u00a0"}</p>
              <p className="truncate text-[12px] text-muted">{user?.email ?? "\u00a0"}</p>
            </div>
            <button
              type="button"
              aria-label="Sign out"
              title="Sign out"
              onClick={() => void signOut()}
              className="focus-ring flex size-8 items-center justify-center rounded-full text-muted hover:bg-black/[0.05] hover:text-foreground"
            >
              <LogoutIcon size={17} />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="material sticky top-0 z-30 border-b border-line md:hidden">
          <div className="flex h-12 items-center gap-2 px-4">
            <AppMark size={24} />
            <nav className="flex flex-1 gap-1 overflow-x-auto" aria-label="Admin">
              <Suspense fallback={<NavLinks pathname={null} layout="top" />}>
                <ActiveNav layout="top" />
              </Suspense>
            </nav>
            <button type="button" aria-label="Sign out" onClick={() => void signOut()} className="focus-ring rounded-full p-1.5 text-muted">
              <LogoutIcon size={17} />
            </button>
          </div>
        </header>
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
}

export function AdminPage({
  title,
  subtitle,
  actions,
  back,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-[1180px] px-4 pt-8 pb-16 sm:px-8 md:pt-10">
      {back && (
        <Link href={back.href} className="focus-ring mb-3 inline-block rounded text-[14px] text-accent hover:underline">
          ‹ {back.label}
        </Link>
      )}
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-display text-balance">{title}</h1>
          {subtitle && <div className="mt-1.5 text-[15px] text-muted">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </main>
  );
}
