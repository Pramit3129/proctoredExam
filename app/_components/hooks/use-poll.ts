"use client";

import { useEffect, useState } from "react";

/** Fetches JSON and re-fetches every `intervalMs` while `active`. */
export function usePoll<T>(url: string, intervalMs: number, active = true): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const load = async () => {
      try {
        const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error((body as { message?: string }).message ?? `Request failed (${res.status})`);
        setData(body as T);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
      if (!cancelled && active) timer = window.setTimeout(load, intervalMs);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [url, intervalMs, active, nonce]);

  return { data, error, reload: () => setNonce((n) => n + 1) };
}
