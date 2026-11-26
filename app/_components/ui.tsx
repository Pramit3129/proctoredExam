"use client";

import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import type { Severity } from "@/lib/proctor/catalog";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ── Buttons ─────────────────────────────────────────────────────────────────

type Variant = "primary" | "secondary" | "plain" | "danger" | "danger-plain" | "dark";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover shadow-[var(--shadow-sm)]",
  secondary: "bg-surface-3/70 text-foreground hover:bg-surface-3",
  plain: "text-accent hover:bg-accent-soft",
  danger: "bg-danger text-white hover:opacity-90",
  "danger-plain": "text-danger hover:bg-danger-soft",
  dark: "bg-foreground text-white hover:opacity-90",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-10 px-4 text-[15px] gap-2",
  lg: "h-12 px-6 text-[17px] gap-2",
};

/** Classes to make a link look like a Button. */
export function buttonClasses(variant: Variant = "primary", size: Size = "md", className?: string): string {
  return cx(
    "pressable focus-ring inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium whitespace-nowrap",
    SIZES[size],
    VARIANTS[variant],
    className,
  );
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "pressable focus-ring inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-40",
        SIZES[size],
        VARIANTS[variant],
        className,
      )}
    />
  );
}

export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cx(
        "pressable focus-ring inline-flex size-9 items-center justify-center rounded-full text-muted hover:bg-surface-3/70 hover:text-foreground disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

// ── Surfaces ────────────────────────────────────────────────────────────────

export function Card({ className, children, as: As = "div" }: { className?: string; children: ReactNode; as?: "div" | "section" | "article" }) {
  return <As className={cx("rounded-[18px] bg-surface shadow-[var(--shadow-sm)] ring-1 ring-line", className)}>{children}</As>;
}

export function SectionHeader({ title, detail, action }: { title: string; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4 px-1">
      <div className="min-w-0">
        <h2 className="text-headline">{title}</h2>
        {detail && <p className="mt-0.5 text-[13px] text-muted">{detail}</p>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {icon && <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-surface-2 text-subtle">{icon}</div>}
      <p className="text-headline">{title}</p>
      {body && <p className="mt-1 max-w-sm text-[14px] text-muted text-pretty">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, detail, tone }: { label: string; value: ReactNode; detail?: ReactNode; tone?: Tone }) {
  return (
    <Card className="p-4">
      <p className="text-[13px] text-muted">{label}</p>
      <p className={cx("mt-1 text-[28px] font-semibold leading-none tracking-[-0.025em] tabular-nums", tone && TEXT_TONES[tone])}>{value}</p>
      {detail && <p className="mt-1.5 text-[12px] text-subtle">{detail}</p>}
    </Card>
  );
}

// ── Badges ──────────────────────────────────────────────────────────────────

export type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";

const TONES: Record<Tone, string> = {
  neutral: "bg-surface-3/70 text-muted",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  accent: "bg-accent-soft text-accent",
};

const TEXT_TONES: Record<Tone, string> = {
  neutral: "text-foreground",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  accent: "text-accent",
};

export function toneText(tone: Tone): string {
  return TEXT_TONES[tone];
}

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex h-[22px] items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium whitespace-nowrap", TONES[tone], className)}>
      {children}
    </span>
  );
}

const DOT: Record<Tone, string> = {
  neutral: "bg-subtle",
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  accent: "bg-accent",
};

export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <span aria-hidden className="relative inline-flex size-2 shrink-0">
      {pulse && <span className={cx("absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:hidden", DOT[tone])} />}
      <span className={cx("relative inline-block size-2 rounded-full", DOT[tone])} />
    </span>
  );
}

export function severityTone(severity: Severity | string): Tone {
  switch (severity) {
    case "critical":
    case "high":
      return "danger";
    case "medium":
      return "warn";
    case "low":
      return "accent";
    default:
      return "neutral";
  }
}

export function riskTone(level: "low" | "medium" | "high"): Tone {
  return level === "high" ? "danger" : level === "medium" ? "warn" : "ok";
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx("inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none", className)}
    />
  );
}

export function LoadingScreen({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-3 py-24 text-[14px] text-muted" role="status">
      <Spinner /> {label}
    </div>
  );
}

export function Notice({ tone = "danger", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cx("rounded-xl px-3.5 py-2.5 text-[14px] text-pretty", TONES[tone], className)}>
      {children}
    </div>
  );
}

// ── Form controls ───────────────────────────────────────────────────────────

const CONTROL =
  "focus-ring w-full rounded-[10px] border border-line-strong bg-surface px-3 text-[15px] text-foreground placeholder:text-subtle transition-[border-color,box-shadow] duration-150 focus:border-accent disabled:bg-surface-2 disabled:text-muted";

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string, describedBy: string | undefined) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium text-foreground">
        {label}
      </label>
      {children(id, hint || error ? hintId : undefined)}
      {(error || hint) && (
        <p id={hintId} className={cx("mt-1.5 text-[12px]", error ? "text-danger" : "text-muted")}>
          {error || hint}
        </p>
      )}
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(CONTROL, "h-11", className)} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(CONTROL, "min-h-24 py-2.5 leading-relaxed", className)} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cx(CONTROL, "h-11 appearance-none bg-[length:12px] bg-[right_12px_center] bg-no-repeat pr-9", className)} style={{ backgroundImage: CHEVRON }}>
      {children}
    </select>
  );
}

const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none' stroke='%2386868b' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 4.5l3 3 3-3'/%3E%3C/svg%3E")`;

/** iOS-style switch. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-[15px]">{label}</span>
        {description && <span className="mt-0.5 block text-[13px] text-muted text-pretty">{description}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          "focus-ring relative mt-0.5 h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40",
          checked ? "bg-[#34c759]" : "bg-surface-3",
        )}
      >
        <span
          className={cx(
            "absolute top-[2px] left-[2px] size-[27px] rounded-full bg-white shadow-[0_3px_8px_rgba(0,0,0,0.15),0_1px_1px_rgba(0,0,0,0.16)] transition-transform duration-200 ease-[var(--ease-out)] motion-reduce:transition-none",
            checked && "translate-x-5",
          )}
        />
      </button>
    </div>
  );
}

/** Segmented control (tabs). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode }[];
  className?: string;
}) {
  return (
    <div role="tablist" className={cx("inline-flex rounded-[10px] bg-surface-3/70 p-[3px]", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "focus-ring h-8 rounded-[8px] px-3.5 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-150",
            value === o.value ? "bg-surface text-foreground shadow-[0_1px_3px_rgba(0,0,0,0.1),0_1px_1px_rgba(0,0,0,0.04)]" : "text-muted hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Sheet (modal dialog) ────────────────────────────────────────────────────

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  size = "sm",
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md";
  dismissible?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("[data-autofocus], button, input, textarea, select")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissible) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, onClose, dismissible]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-3 sm:items-center sm:p-6">
      <div className="animate-fade absolute inset-0 bg-black/30" onClick={dismissible ? onClose : undefined} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx(
          "animate-sheet relative w-full rounded-[22px] bg-surface p-6 shadow-[var(--shadow-lg)]",
          size === "sm" ? "max-w-[420px]" : "max-w-[560px]",
        )}
      >
        <h2 className="text-title text-[21px]">{title}</h2>
        <div className="mt-2 text-[15px] text-muted">{children}</div>
        {footer && <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{footer}</div>}
      </div>
    </div>
  );
}
