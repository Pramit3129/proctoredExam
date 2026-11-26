import type { Emit } from "./face-monitor";
import { hasMultipleDisplays } from "./media";
import { Sustained } from "./sustained";

type Detail = Record<string, unknown>;

export interface EnvironmentState {
  visible: boolean;
  focused: boolean;
  fullscreen: boolean;
  online: boolean;
}

function fullscreenElement(): Element | null {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

interface KeyboardLock {
  lock?: (keys?: string[]) => Promise<void>;
  unlock?: () => void;
}

function keyboardApi(): KeyboardLock | undefined {
  return (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
}

/**
 * Enters fullscreen and, where supported (Chromium), locks the Escape key so
 * a single accidental tap does not leave fullscreen and submit the exam;
 * holding Escape still exits, as the browser requires.
 */
export async function requestFullscreen(): Promise<void> {
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
  if (!fullscreenElement()) {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" });
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    else throw new Error("Fullscreen is not supported by this browser.");
  }
  await keyboardApi()?.lock?.(["Escape"]).catch(() => undefined);
}

export function releaseKeyboardLock(): void {
  try {
    keyboardApi()?.unlock?.();
  } catch {
    // Not supported.
  }
}

export function isFullscreen(): boolean {
  return fullscreenElement() !== null;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && (target as HTMLInputElement).type === "text");
}

function describeCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.metaKey) parts.push("Cmd");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return parts.join("+");
}

/**
 * Returns a reason if the shortcut must be blocked. Copy/cut/paste are handled
 * by the clipboard listeners instead, so they are logged exactly once.
 */
function restrictedShortcut(e: KeyboardEvent): string | null {
  const key = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (key === "f12") return "devtools";
  if (mod && e.shiftKey && ["i", "j", "c", "k", "m"].includes(key)) return "devtools";
  if (e.metaKey && e.altKey && ["i", "j", "c", "u"].includes(key)) return "devtools";
  if (key === "printscreen") return "screenshot";
  if (e.metaKey && e.shiftKey && ["3", "4", "5", "6"].includes(key)) return "screenshot";
  if (key === "f5" || (mod && key === "r")) return "reload";
  if (mod && ["p"].includes(key)) return "print";
  if (mod && ["s", "o"].includes(key)) return "save/open";
  if (mod && ["u"].includes(key)) return "view-source";
  if (mod && ["f", "g", "h", "j", "d"].includes(key)) return "browser-feature";
  if (mod && ["t", "n", "w", "tab"].includes(key)) return "new-window";
  if (e.altKey && ["arrowleft", "arrowright", "tab"].includes(key)) return "navigation";
  if (key === "f3" || key === "f6" || key === "f7") return "browser-feature";
  return null;
}

/**
 * Tab, focus, fullscreen, display, clipboard, keyboard, print, devtools and
 * network monitoring. Events are cross-checked by polling so a suppressed
 * DOM event does not silently hide a violation.
 */
export class EnvironmentMonitor {
  private readonly cleanup: (() => void)[] = [];
  private pollTimer: number | null = null;
  private blurTimer: number | null = null;
  private readonly baseDpr = window.devicePixelRatio || 1;
  private lastShortcutLog = 0;

  state: EnvironmentState = {
    visible: document.visibilityState === "visible",
    focused: document.hasFocus(),
    fullscreen: isFullscreen(),
    online: navigator.onLine,
  };

  private readonly hidden: Sustained<Detail>;
  private readonly blurred: Sustained<Detail>;
  private readonly notFullscreen: Sustained<Detail>;
  private readonly displays: Sustained<Detail>;
  private readonly resized: Sustained<Detail>;
  private readonly devtools: Sustained<Detail>;
  private readonly offline: Sustained<Detail>;

  constructor(
    private readonly emit: Emit,
    private readonly onChange: (state: EnvironmentState) => void,
  ) {
    const track = (type: Parameters<Emit>[0], minMs: number, clearMs = 0) =>
      new Sustained<Detail>(
        minMs,
        {
          start: (since, detail) => emit(type, { ...detail }, { phase: "start", at: Date.now() - (performance.now() - since) }),
          end: (durationMs, detail) => emit(type, { ...detail }, { phase: "end", durationMs }),
        },
        clearMs,
      );
    this.hidden = track("TAB_HIDDEN", 0);
    this.blurred = track("WINDOW_BLUR", 0);
    this.notFullscreen = track("FULLSCREEN_EXIT", 0);
    this.displays = track("MULTIPLE_DISPLAYS", 0);
    this.resized = track("WINDOW_RESIZED", 1_500, 500);
    this.devtools = track("DEVTOOLS_SUSPECTED", 1_500, 1_000);
    this.offline = track("NETWORK_OFFLINE", 0);
  }

  start(): void {
    const on = <K extends keyof WindowEventMap>(
      target: Window | Document,
      type: K | string,
      fn: (e: Event) => void,
      options: AddEventListenerOptions = { capture: true },
    ) => {
      target.addEventListener(type, fn, options);
      this.cleanup.push(() => target.removeEventListener(type, fn, options));
    };

    on(document, "visibilitychange", () => this.evaluate("visibilitychange"));
    on(window, "blur", () => {
      // A tab switch fires blur first; wait a moment so it is recorded once, as TAB_HIDDEN.
      if (this.blurTimer !== null) window.clearTimeout(this.blurTimer);
      this.blurTimer = window.setTimeout(() => this.evaluate("blur"), 200);
    });
    on(window, "focus", () => this.evaluate("focus"));
    on(document, "fullscreenchange", () => this.evaluate("fullscreenchange"));
    on(document, "webkitfullscreenchange", () => this.evaluate("fullscreenchange"));
    on(window, "resize", () => this.evaluate("resize"));
    on(window, "online", () => this.evaluate("online"));
    on(window, "offline", () => this.evaluate("offline"));

    const screenWithEvents = screen as Screen & EventTarget;
    if (typeof screenWithEvents.addEventListener === "function") {
      const fn = () => this.evaluate("screenchange");
      screenWithEvents.addEventListener("change", fn);
      this.cleanup.push(() => screenWithEvents.removeEventListener("change", fn));
    }

    for (const type of ["copy", "cut", "paste"] as const) {
      on(document, type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.emit("CLIPBOARD_BLOCKED", { action: type });
      });
    }
    on(document, "drop", (e) => {
      e.preventDefault();
      this.emit("CLIPBOARD_BLOCKED", { action: "drop" });
    });
    on(document, "dragover", (e) => e.preventDefault());
    on(document, "dragstart", (e) => e.preventDefault());
    on(document, "contextmenu", (e) => {
      e.preventDefault();
      this.emit("CONTEXT_MENU_BLOCKED", {});
    });
    on(document, "selectstart", (e) => {
      if (!isEditable(e.target)) e.preventDefault();
    });
    on(window, "beforeprint", () => this.emit("PRINT_ATTEMPT", {}));
    on(window, "keydown", (e) => this.onKey(e as KeyboardEvent));
    on(window, "keyup", (e) => {
      // PrintScreen only reports keyup on Windows.
      if ((e as KeyboardEvent).key === "PrintScreen") this.logShortcut(e as KeyboardEvent, "screenshot");
    });

    this.pollTimer = window.setInterval(() => this.evaluate("poll"), 1_000);
    this.evaluate("start");
  }

  stop(): void {
    for (const fn of this.cleanup.splice(0)) fn();
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    if (this.blurTimer !== null) window.clearTimeout(this.blurTimer);
    this.pollTimer = null;
    const now = performance.now();
    for (const s of [this.hidden, this.blurred, this.notFullscreen, this.displays, this.resized, this.devtools, this.offline]) {
      s.flush(now);
    }
  }

  private onKey(e: KeyboardEvent): void {
    const reason = restrictedShortcut(e);
    if (reason) {
      e.preventDefault();
      e.stopPropagation();
      if (reason !== "screenshot" || e.type === "keydown") this.logShortcut(e, reason);
      return;
    }
    // Select-all outside answer fields would select the whole exam page.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !isEditable(e.target)) e.preventDefault();
  }

  private logShortcut(e: KeyboardEvent, reason: string): void {
    const now = performance.now();
    if (now - this.lastShortcutLog < 500) return;
    this.lastShortcutLog = now;
    this.emit("SHORTCUT_BLOCKED", { combo: describeCombo(e), reason });
  }

  private evaluate(trigger: string): void {
    const now = performance.now();
    const visible = document.visibilityState === "visible";
    const focused = document.hasFocus();
    const fullscreen = isFullscreen();
    const online = navigator.onLine;
    const detail = trigger === "poll" ? { detectedBy: "poll" } : {};

    this.hidden.update(!visible, now, detail);
    // Blur while hidden is part of the tab switch, not a separate violation.
    this.blurred.update(visible && !focused, now, detail);
    this.notFullscreen.update(!fullscreen, now, {});
    this.offline.update(!online, now, {});

    const extended = hasMultipleDisplays();
    this.displays.update(extended === true, now, {});

    if (!fullscreen) {
      const narrow = window.innerWidth < screen.availWidth * 0.8 || window.innerHeight < screen.availHeight * 0.7;
      this.resized.update(narrow, now, {
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        screen: `${screen.availWidth}x${screen.availHeight}`,
      });
    } else {
      this.resized.update(false, now);
    }

    // In fullscreen the viewport should cover the screen. A large shortfall
    // means something is docked inside the window: almost always DevTools.
    if (fullscreen && visible) {
      const zoom = (window.devicePixelRatio || 1) / this.baseDpr;
      const widthGap = screen.width - window.innerWidth * zoom;
      const heightGap = screen.height - window.innerHeight * zoom;
      this.devtools.update(widthGap > 160 || heightGap > 160, now, {
        widthGap: Math.round(widthGap),
        heightGap: Math.round(heightGap),
      });
    } else {
      this.devtools.update(false, now);
    }

    const next: EnvironmentState = { visible, focused, fullscreen, online };
    if (
      next.visible !== this.state.visible ||
      next.focused !== this.state.focused ||
      next.fullscreen !== this.state.fullscreen ||
      next.online !== this.state.online
    ) {
      this.state = next;
      this.onChange(next);
    }
  }
}
