import { chainInput, type WireEvent } from "../protocol";

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** HMAC-SHA256 hash chain matching the server's verification in lib/server/sessions.ts (ingestBatch). */
export class EventChain {
  private constructor(private readonly key: CryptoKey) {}

  static async create(chainKeyBase64Url: string): Promise<EventChain> {
    const key = await crypto.subtle.importKey(
      "raw",
      base64UrlToBytes(chainKeyBase64Url),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return new EventChain(key);
  }

  /** HMAC of an arbitrary message, e.g. the re-sync proof. */
  async sign(message: string): Promise<string> {
    return toHex(await crypto.subtle.sign("HMAC", this.key, new TextEncoder().encode(message)));
  }

  async link(prevHash: string, event: Omit<WireEvent, "h">): Promise<string> {
    const signature = await crypto.subtle.sign("HMAC", this.key, new TextEncoder().encode(chainInput(prevHash, event)));
    return toHex(signature);
  }
}
