import type { Emit } from "./face-monitor";
import { Sustained } from "./sustained";

/**
 * Anti-tamper checks. None of these make the browser trustworthy (nothing
 * can), but each one forces a cheater to do more work, and every bypass that
 * is detected is recorded server-side where the candidate cannot remove it.
 */

type Getter = () => unknown;

interface ApiCheck {
  name: string;
  get: () => unknown;
  /** Name the native implementation reports, e.g. "addEventListener" or "get hidden". */
  expected: string;
}

function getterOf(proto: object | undefined, prop: string): Getter | undefined {
  return proto ? (Object.getOwnPropertyDescriptor(proto, prop)?.get as Getter | undefined) : undefined;
}

const API_CHECKS: ApiCheck[] = [
  { name: "Document.hidden", get: () => getterOf(Document.prototype, "hidden"), expected: "get hidden" },
  { name: "Document.visibilityState", get: () => getterOf(Document.prototype, "visibilityState"), expected: "get visibilityState" },
  { name: "Document.fullscreenElement", get: () => getterOf(Document.prototype, "fullscreenElement"), expected: "get fullscreenElement" },
  { name: "Document.hasFocus", get: () => Document.prototype.hasFocus, expected: "hasFocus" },
  { name: "EventTarget.addEventListener", get: () => EventTarget.prototype.addEventListener, expected: "addEventListener" },
  { name: "EventTarget.removeEventListener", get: () => EventTarget.prototype.removeEventListener, expected: "removeEventListener" },
  { name: "EventTarget.dispatchEvent", get: () => EventTarget.prototype.dispatchEvent, expected: "dispatchEvent" },
  { name: "Event.stopPropagation", get: () => Event.prototype.stopPropagation, expected: "stopPropagation" },
  { name: "Event.stopImmediatePropagation", get: () => Event.prototype.stopImmediatePropagation, expected: "stopImmediatePropagation" },
  { name: "Event.preventDefault", get: () => Event.prototype.preventDefault, expected: "preventDefault" },
  { name: "window.requestAnimationFrame", get: () => window.requestAnimationFrame, expected: "requestAnimationFrame" },
  { name: "window.setTimeout", get: () => window.setTimeout, expected: "setTimeout" },
  { name: "window.setInterval", get: () => window.setInterval, expected: "setInterval" },
  { name: "Date.now", get: () => Date.now, expected: "now" },
  { name: "Performance.now", get: () => Performance.prototype.now, expected: "now" },
  { name: "Element.requestFullscreen", get: () => Element.prototype.requestFullscreen, expected: "requestFullscreen" },
  { name: "MediaDevices.getUserMedia", get: () => MediaDevices.prototype.getUserMedia, expected: "getUserMedia" },
  { name: "MediaDevices.enumerateDevices", get: () => MediaDevices.prototype.enumerateDevices, expected: "enumerateDevices" },
  { name: "MediaStreamTrack.getSettings", get: () => MediaStreamTrack.prototype.getSettings, expected: "getSettings" },
  { name: "HTMLCanvasElement.toBlob", get: () => HTMLCanvasElement.prototype.toBlob, expected: "toBlob" },
  { name: "CanvasRenderingContext2D.drawImage", get: () => CanvasRenderingContext2D.prototype.drawImage, expected: "drawImage" },
  { name: "CanvasRenderingContext2D.getImageData", get: () => CanvasRenderingContext2D.prototype.getImageData, expected: "getImageData" },
  { name: "window.fetch", get: () => window.fetch, expected: "fetch" },
  { name: "SubtleCrypto.sign", get: () => SubtleCrypto.prototype.sign, expected: "sign" },
  { name: "Function.toString", get: () => Function.prototype.toString, expected: "toString" },
];

/** Own properties on `document` that shadow the prototype — the classic "always visible" hack. */
const SHADOWABLE = ["hidden", "visibilityState", "hasFocus", "webkitHidden", "webkitVisibilityState", "fullscreenElement"];

const AUTOMATION_GLOBALS = /^(cdc_|\$cdc_|__webdriver|__driver|__selenium|__fxdriver|_selenium|_Selenium_IDE|callSelenium|__playwright|__pw_|__puppeteer|callPhantom|_phantom|__nightmare|domAutomation)/;

const ALLOWED_INJECTED_TAGS = new Set(["NEXTJS-PORTAL", "NEXT-ROUTE-ANNOUNCER", "STYLE", "LINK", "META", "TITLE", "NOSCRIPT", "TEMPLATE"]);

function normalise(source: string): string {
  return source.replace(/\s+/g, " ").trim();
}

export class IntegrityMonitor {
  private timer: number | null = null;
  private rafHandle: number | null = null;
  private lastRafAt = performance.now();
  private lastTickAt = performance.now();
  private observer: MutationObserver | null = null;
  private pristineToString: (this: unknown) => string;
  private frame: HTMLIFrameElement | null = null;
  private readonly reported = new Set<string>();
  private readonly spoof: Sustained<Record<string, unknown>>;

  constructor(private readonly emit: Emit) {
    this.pristineToString = Function.prototype.toString;
    this.spoof = new Sustained(
      2_500,
      {
        start: (since, detail) => emit("VISIBILITY_SPOOF", { ...detail }, { phase: "start", at: Date.now() - (performance.now() - since) }),
        end: (durationMs, detail) => emit("VISIBILITY_SPOOF", { ...detail }, { phase: "end", durationMs }),
      },
      1_000,
    );
  }

  start(): void {
    // A fresh same-origin realm gives an unpatched Function.prototype.toString
    // unless an extension also patches every frame, which costs it more effort.
    try {
      const frame = document.createElement("iframe");
      frame.dataset.proctorOwned = "true";
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none";
      document.body.appendChild(frame);
      const realm = frame.contentWindow as (Window & typeof globalThis) | null;
      if (realm) this.pristineToString = realm.Function.prototype.toString;
      this.frame = frame;
    } catch {
      // Keep the current-realm toString.
    }

    const raf = () => {
      this.lastRafAt = performance.now();
      this.rafHandle = window.requestAnimationFrame(raf);
    };
    this.rafHandle = window.requestAnimationFrame(raf);

    this.observeDom();
    this.check();
    this.timer = window.setInterval(() => this.check(), 1_000);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    if (this.rafHandle !== null) window.cancelAnimationFrame(this.rafHandle);
    this.observer?.disconnect();
    this.frame?.remove();
    this.spoof.flush(performance.now());
  }

  private once(key: string, fn: () => void): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    fn();
  }

  private isPristine(fn: unknown, expectedName: string): boolean {
    if (typeof fn !== "function") return false;
    let source: string;
    try {
      source = normalise(this.pristineToString.call(fn));
    } catch {
      return false;
    }
    // Native functions stringify as `function name() { [native code] }`. Bound
    // functions and Proxies around natives lose the name, so they fail too.
    return source === `function ${expectedName}() { [native code] }`;
  }

  private check(): void {
    const now = performance.now();
    const tickDelay = now - this.lastTickAt;
    this.lastTickAt = now;

    if (navigator.webdriver) {
      this.once("webdriver", () => this.emit("AUTOMATION_DETECTED", { signal: "navigator.webdriver" }));
    }
    for (const key of [...Object.getOwnPropertyNames(window), ...Object.getOwnPropertyNames(document)]) {
      if (AUTOMATION_GLOBALS.test(key)) {
        this.once(`automation:${key}`, () => this.emit("AUTOMATION_DETECTED", { signal: key.slice(0, 60) }));
      }
    }

    for (const api of API_CHECKS) {
      let fn: unknown;
      try {
        fn = api.get();
      } catch {
        continue;
      }
      if (fn === undefined) continue; // API not present in this browser
      if (!this.isPristine(fn, api.expected)) {
        this.once(`api:${api.name}`, () => this.emit("API_TAMPERING", { api: api.name, kind: "overridden" }));
      }
    }
    for (const prop of SHADOWABLE) {
      if (Object.prototype.hasOwnProperty.call(document, prop)) {
        this.once(`shadow:${prop}`, () => this.emit("API_TAMPERING", { api: `document.${prop}`, kind: "shadowed" }));
      }
    }

    // rAF only runs while the page is actually being rendered. If the page
    // claims to be visible but rendering has stopped for seconds, visibility
    // is being spoofed. Skip when our own timer was delayed (busy main thread
    // or a debugger pause) because then rAF is delayed too.
    const claimsVisible = document.visibilityState === "visible";
    const rafStalledFor = now - this.lastRafAt;
    if (tickDelay < 2_000) {
      this.spoof.update(claimsVisible && rafStalledFor > 2_000, now, { renderStalledMs: Math.round(rafStalledFor) });
    }
  }

  private observeDom(): void {
    const ownOrigin = location.origin;
    const isOwned = (el: Element) => el.closest("[data-proctor-owned],[data-proctor-root]") !== null;
    const inspect = (el: Element) => {
      if (isOwned(el)) return;
      const tag = el.tagName;
      if (tag === "SCRIPT") {
        const src = (el as HTMLScriptElement).src;
        if (!src || new URL(src, location.href).origin === ownOrigin) return;
        this.report(tag, `script ${new URL(src).host}`);
        return;
      }
      if (tag === "IFRAME" || tag === "FRAME" || tag === "OBJECT" || tag === "EMBED") {
        this.report(tag, (el as HTMLIFrameElement).src?.slice(0, 120) || "inline frame");
        return;
      }
      if (ALLOWED_INJECTED_TAGS.has(tag)) return;
      // Framework streaming placeholders are hidden containers; so is anything that cannot be seen.
      if (el instanceof HTMLElement && el.hidden) return;
      const parent = el.parentElement;
      const topLevel = parent === document.body || parent === document.documentElement;
      if (topLevel || tag.includes("-") || el.shadowRoot) {
        this.report(tag, el.id ? `#${el.id}` : (el.className?.toString().slice(0, 60) ?? ""));
      }
    };
    this.observer = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => {
          if (node instanceof Element) inspect(node);
        });
      }
    });
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    // Elements injected before monitoring began.
    for (const el of [...Array.from(document.body.children), ...Array.from(document.documentElement.children)]) {
      if (el !== document.body && el !== document.head) inspect(el);
    }
  }

  private report(tag: string, detail: string): void {
    this.once(`dom:${tag}:${detail}`, () => this.emit("DOM_INJECTION", { element: tag.toLowerCase(), detail }));
  }
}
