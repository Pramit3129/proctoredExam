"use client";

import { useState, type FormEvent } from "react";

import type { SessionUser } from "@/lib/exam-types";

import { api, errorMessage, safeNext } from "../api";
import { AppMark } from "../icons";
import { Button, Field, Input, Notice, Spinner } from "../ui";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { user } = await api<{ user: SessionUser }>("/api/auth/login", { method: "POST", json: { email, password } });
      const next = safeNext(new URLSearchParams(window.location.search).get("next"));
      const fallback = user.isAdmin ? "/admin" : "/";
      window.location.assign(next && (user.isAdmin || !next.startsWith("/admin")) ? next : fallback);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="animate-enter w-full max-w-[380px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <AppMark size={52} />
          <h1 className="text-title mt-5">Sign in to Exams</h1>
          <p className="mt-1.5 text-[15px] text-muted">Use the same email and password as your learning portal.</p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-[22px] bg-surface p-6 shadow-[var(--shadow-md)] ring-1 ring-line" noValidate>
          <Field label="Email">
            {(id, describedBy) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="email"
                inputMode="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-autofocus
              />
            )}
          </Field>
          <Field label="Password">
            {(id, describedBy) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                type="password"
                autoComplete="current-password"
                required
                maxLength={200}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            )}
          </Field>
          {error && <Notice>{error}</Notice>}
          <Button type="submit" size="lg" className="w-full" disabled={busy || !email.trim() || !password}>
            {busy && <Spinner />} Sign in
          </Button>
        </form>
        <p className="mt-6 text-center text-[13px] text-subtle">Forgot your password? Reset it in the learning portal.</p>
      </div>
    </main>
  );
}
