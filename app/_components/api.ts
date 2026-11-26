"use client";

import { useEffect, useState } from "react";

import type { SessionUser } from "@/lib/exam-types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Sends the user to sign in, returning here afterwards. */
export function redirectToLogin(): void {
  const next = `${window.location.pathname}${window.location.search}`;
  // A full navigation on purpose: it drops all client state from the old session.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

/** Same-origin JSON fetch. Throws ApiError with the server's message. */
export async function api<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...rest,
    headers: json !== undefined ? { "content-type": "application/json", ...headers } : headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  if (!res.ok) {
    if (res.status === 401 && body?.error === "unauthenticated") redirectToLogin();
    throw new ApiError(res.status, body?.error ?? "error", body?.message ?? `Request failed (${res.status}).`);
  }
  return body as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The signed-in user; redirects to sign-in when there is none. */
export function useSessionUser(options: { requireAdmin?: boolean } = {}): { user: SessionUser | null; forbidden: boolean } {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const requireAdmin = options.requireAdmin ?? false;
  useEffect(() => {
    let cancelled = false;
    api<{ user: SessionUser | null }>("/api/auth/me")
      .then(({ user: u }) => {
        if (cancelled) return;
        if (!u) return redirectToLogin();
        if (requireAdmin && !u.isAdmin) setForbidden(true);
        setUser(u);
      })
      .catch(() => !cancelled && redirectToLogin());
    return () => {
      cancelled = true;
    };
  }, [requireAdmin]);
  return { user, forbidden };
}

export async function signOut(): Promise<void> {
  await api("/api/auth/logout", { method: "POST", json: {} }).catch(() => undefined);
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign("/login");
}

/** Only same-site relative paths are accepted as post-login destinations. */
export function safeNext(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  return value;
}
