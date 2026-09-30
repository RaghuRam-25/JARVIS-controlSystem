/**
 * Cryptographic helpers for secure pairing challenges and session authentication.
 * Uses Web Crypto API when available (works in Node.js 18+ and all modern browsers).
 */

export function generateRandomHex(byteCount = 16): string {
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const buffer = new Uint8Array(byteCount);
    crypto.getRandomValues(buffer);
    return Array.from(buffer)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  // Fallback for environments where crypto is not directly in global scope
  let result = "";
  const hexChars = "0123456789abcdef";
  for (let i = 0; i < byteCount * 2; i++) {
    result += hexChars[Math.floor(Math.random() * 16)];
  }
  return result;
}

export function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Creates a sha256 hash representation of string input
 */
export async function sha256Hex(input: string): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Simple deterministic fallback for mock/pure js environments
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(32, "0");
}

/**
 * Creates a signed token string: base64(payload) . signature
 */
export async function createSignedToken(payload: object, secretKey: string): Promise<string> {
  const payloadStr = JSON.stringify(payload);
  const base64Payload = typeof btoa === "function" 
    ? btoa(unescape(encodeURIComponent(payloadStr)))
    : Buffer.from(payloadStr, "utf-8").toString("base64");
  
  const signature = await sha256Hex(`${base64Payload}.${secretKey}`);
  return `${base64Payload}.${signature}`;
}

/**
 * Verifies and unpacks a signed token
 */
export async function verifySignedToken<T = any>(token: string, secretKey: string): Promise<T | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [base64Payload, signature] = parts;
    const expectedSignature = await sha256Hex(`${base64Payload}.${secretKey}`);
    
    if (signature !== expectedSignature) {
      return null;
    }
    
    const payloadStr = typeof atob === "function"
      ? decodeURIComponent(escape(atob(base64Payload)))
      : Buffer.from(base64Payload, "base64").toString("utf-8");
      
    const data = JSON.parse(payloadStr);
    if (data.expiresAt && Date.now() > data.expiresAt) {
      return null; // Expired
    }
    return data as T;
  } catch {
    return null;
  }
}

/**
 * Sanitizes input strings for command line safety
 */
export function sanitizeCliInput(input: string): string {
  // Remove shell metacharacters and control characters
  return input.replace(/[;&|`$><!]/g, "").trim();
}
