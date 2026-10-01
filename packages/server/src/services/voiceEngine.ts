/**
 * voiceEngine.ts
 *
 * Intelligent multi-step voice command parser for JARVIS V1.
 *
 * Flow:
 *   Raw Transcript → Normalize → Detect Language → Intent Understanding
 *   → Action Plan → VoiceCommandIntent (with payload.steps)
 *
 * Key features:
 *   - Fuzzy transcript normalization (filler words, punctuation, case)
 *   - Full Unicode combining marks (\p{M}) support for Bengali
 *   - Fuzzy application name matching (Bengali + English)
 *   - Multi-step action planning ("Chrome open করে YouTube এ search করো")
 *   - Short-lived execution context across follow-up commands
 *   - Confidence-based clarification requests
 *   - Keyword-matching fallback for simple commands
 */

import { generateUUID, VoiceCommandIntent, ActionStep } from "@jarvis/shared";

// ---------------------------------------------------------------------------
// Short-lived Execution Context
// ---------------------------------------------------------------------------

export interface VoiceExecutionContext {
  currentApplication: string | null;   // e.g. "chrome"
  currentUrl: string | null;            // e.g. "https://youtube.com"
  lastAction: string | null;
  lastTarget: string | null;
  updatedAt: number;
}

const CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _ctx: VoiceExecutionContext = {
  currentApplication: null,
  currentUrl: null,
  lastAction: null,
  lastTarget: null,
  updatedAt: 0,
};

export function getVoiceContext(): VoiceExecutionContext {
  if (Date.now() - _ctx.updatedAt > CONTEXT_TTL_MS) {
    _ctx = { currentApplication: null, currentUrl: null, lastAction: null, lastTarget: null, updatedAt: 0 };
  }
  return _ctx;
}

export function updateVoiceContext(patch: Partial<VoiceExecutionContext>): void {
  _ctx = { ..._ctx, ...patch, updatedAt: Date.now() };
}

export function clearVoiceContext(): void {
  _ctx = { currentApplication: null, currentUrl: null, lastAction: null, lastTarget: null, updatedAt: 0 };
}

// ---------------------------------------------------------------------------
// Transcript Normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes raw speech transcript:
 * - Lowercase + trim
 * - Remove punctuation while preserving Bengali characters + combining vowel marks (\p{M})
 * - Strip conversational greetings / filler words
 * - Normalize whitespace
 */
function normalize(text: string): string {
  let t = text.toLowerCase().trim();

  // Strip leading wake words/greetings only (at start of command)
  t = t.replace(/^(?:hey\s+jarvis|ok\s+jarvis|jarvis|hello\s+jarvis)\s+/gi, "");
  t = t.replace(/^(?:হাই\s+জার্ভিস|জার্ভিস|হ্যালো\s+জার্ভিস)\s+/gu, "");

  // Remove punctuation except letters, combining marks (vital for Bengali), digits, spaces, basic symbols
  t = t.replace(/[^\p{L}\p{M}\p{N}\s.:/_-]/gu, " ");

  // Strip conversational politeness words (English)
  const fillersEn = ["please", "kindly", "just", "bhai", "bro"];
  for (const f of fillersEn) {
    t = t.replace(new RegExp(`\\b${f}\\b`, "gi"), " ");
  }

  // Strip conversational fillers (Bengali)
  const fillersBn = ["একটু", "প্লিজ", "ভাই", "দয়া করে"];
  for (const f of fillersBn) {
    t = t.replace(new RegExp(f, "gu"), " ");
  }

  // Normalize whitespace
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function hasBengali(text: string): boolean {
  return /[\u0980-\u09FF]/.test(text);
}

function detectLanguage(text: string): "en" | "bn" {
  return hasBengali(text) ? "bn" : "en";
}

// ---------------------------------------------------------------------------
// Fuzzy Application Resolver
// ---------------------------------------------------------------------------

export interface AppInfo {
  appId: string;        // used in automation (e.g. "chrome", "code", "notepad")
  displayName: string;
  aliases: string[];    // all known aliases (en + bn lowercase)
  launchCmd: string;    // Windows launch command
  windowClass?: string; // for focus-by-class fallback
}

export const APP_REGISTRY: AppInfo[] = [
  {
    appId: "chrome",
    displayName: "Google Chrome",
    aliases: [
      "chrome", "chrom", "chorme", "chroem", "chromee", "gorgle chrome", "google chrome",
      "ক্রোম", "ক্রোমটা", "ক্রোমে", "গুগল ক্রোম", "browser", "ব্রাউজার",
    ],
    launchCmd: "start chrome",
    windowClass: "Chrome_WidgetWin_1",
  },
  {
    appId: "code",
    displayName: "VS Code",
    aliases: [
      "vscode", "vs code", "visual studio code", "code editor", "vs cod",
      "ভিএস কোড", "ভিএসকোড", "কোড এডিটর", "ভিএস কোডে",
    ],
    launchCmd: "start code",
  },
  {
    appId: "antigravity",
    displayName: "Antigravity IDE",
    aliases: [
      "antigravity", "anti gravity", "agy", "অ্যান্টিগ্র্যাভিটি", "এন্টিগ্রাভিটি",
    ],
    launchCmd: "start antigravity",
  },
  {
    appId: "powershell",
    displayName: "PowerShell Terminal",
    aliases: [
      "terminal", "powershell", "power shell", "cmd", "command prompt",
      "টার্মিনাল", "পাওয়ারশেল",
    ],
    launchCmd: "start powershell",
  },
  {
    appId: "notepad",
    displayName: "Notepad",
    aliases: ["notepad", "নোটপ্যাড", "text editor"],
    launchCmd: "start notepad",
  },
  {
    appId: "explorer",
    displayName: "File Explorer",
    aliases: ["explorer", "file explorer", "files", "ফাইল এক্সপ্লোরার", "এক্সপ্লোরার"],
    launchCmd: "start explorer",
  },
  {
    appId: "edge",
    displayName: "Microsoft Edge",
    aliases: ["edge", "microsoft edge", "এজ"],
    launchCmd: "start msedge",
  },
  {
    appId: "spotify",
    displayName: "Spotify",
    aliases: ["spotify", "স্পটিফাই"],
    launchCmd: "start spotify",
  },
];

/** Simple Levenshtein distance for fuzzy matching */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export interface AppMatch {
  app: AppInfo;
  confidence: number; // 0..1
}

export function resolveApp(token: string): AppMatch | null {
  const t = token.toLowerCase().trim();
  if (!t) return null;

  let bestMatch: AppMatch | null = null;

  for (const app of APP_REGISTRY) {
    for (const alias of app.aliases) {
      // Exact match
      if (t === alias) return { app, confidence: 1.0 };

      // Contains match
      if (t.includes(alias) || alias.includes(t)) {
        const conf = Math.min(alias.length, t.length) / Math.max(alias.length, t.length);
        if (!bestMatch || conf > bestMatch.confidence) {
          bestMatch = { app, confidence: Math.max(conf, 0.8) };
        }
        continue;
      }

      // Levenshtein fuzzy
      const dist = levenshtein(t, alias);
      const maxLen = Math.max(t.length, alias.length);
      const conf = 1 - dist / maxLen;
      if (conf >= 0.65 && (!bestMatch || conf > bestMatch.confidence)) {
        bestMatch = { app, confidence: conf };
      }
    }
  }

  return bestMatch;
}

// ---------------------------------------------------------------------------
// URL / Site Resolver
// ---------------------------------------------------------------------------

export interface SiteInfo {
  name: string;
  url: string;
  searchUrl?: string;  // %s = query
  aliases: string[];
}

export const SITE_REGISTRY: SiteInfo[] = [
  {
    name: "YouTube",
    url: "https://www.youtube.com",
    searchUrl: "https://www.youtube.com/results?search_query=%s",
    aliases: [
      "youtube", "yt", "ইউটিউব", "ইউটিউবে", "ইউটিউবটা", "ইউটিউবে গিয়ে", "ইউটিউবে গিয়ে", "you tube"
    ],
  },
  {
    name: "Google",
    url: "https://www.google.com",
    searchUrl: "https://www.google.com/search?q=%s",
    aliases: ["google", "গুগল", "গুগলে", "গুগলটা"],
  },
  {
    name: "GitHub",
    url: "https://github.com",
    searchUrl: "https://github.com/search?q=%s",
    aliases: ["github", "git hub", "গিটহাব", "গিটহাবে"],
  },
  {
    name: "ChatGPT",
    url: "https://chat.openai.com",
    aliases: ["chatgpt", "chat gpt", "openai", "চ্যাটজিপিটি"],
  },
  {
    name: "Gmail",
    url: "https://mail.google.com",
    aliases: ["gmail", "google mail", "জিমেইল", "জিমেইলে"],
  },
  {
    name: "Facebook",
    url: "https://www.facebook.com",
    aliases: ["facebook", "fb", "ফেসবুক", "ফেসবুকে"],
  },
  {
    name: "Twitter",
    url: "https://twitter.com",
    aliases: ["twitter", "x", "টুইটার", "টুইটারে"],
  },
];

export function resolveSite(token: string): SiteInfo | null {
  const t = token.toLowerCase().trim();
  for (const site of SITE_REGISTRY) {
    for (const alias of site.aliases) {
      if (t === alias) return site;
      if (alias.length <= 3) {
        if (new RegExp(`(?:^|\\s)${alias}(?:\\s|$)`, "i").test(t)) return site;
      } else {
        if (t.includes(alias)) return site;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Context Reference Detector
// ---------------------------------------------------------------------------

/** Returns true if the text refers to current context ("এখন", "এখানে", etc.) */
function isContextReference(text: string): boolean {
  const contextWords = [
    "এখন", "এখানে", "এটাতে", "ওই", "সেটায়", "সেখানে",
    "there", "here", "this", "current", "same", "now",
  ];
  for (const w of contextWords) {
    if (text.includes(w)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Multi-Step Intent Extractor
// ---------------------------------------------------------------------------

/**
 * Detects open/launch intent tokens in the normalized text.
 * Returns { match, rest } or null.
 */
function extractOpenApp(norm: string): { match: AppMatch; rest: string } | null {
  const openTriggers = [
    "খোলো", "খুলে দাও", "খুলে", "খুলো", "চালাও", "চালু করো", "চালু কর", "চালু",
    "ওপেন করো", "ওপেন করে", "ওপেন কর", "ওপেন", "open karo", "open koro",
    "open", "launch", "start", "run",
  ];

  let text = norm;

  // 1. Try `<app> <trigger> <rest>` (e.g. "chrome খুলে youtube এ যাও", "chrome open করে...")
  for (const trigger of openTriggers) {
    const patBefore = new RegExp(`(?:^|\\s*)([a-zA-Z0-9\u0980-\u09FF]+(?:\\s+[a-zA-Z0-9\u0980-\u09FF]+)?)\\s+${trigger}(?:\\s+(?:and|then|এবং|তারপর|,)?\\s*(.*)|$)`, "i");
    const m = text.match(patBefore);
    if (m) {
      const candidate = m[1].trim();
      const appMatch = resolveApp(candidate);
      if (appMatch && appMatch.confidence >= 0.65) {
        const rest = (m[2] || "").trim();
        return { match: appMatch, rest };
      }
    }
  }

  // 2. Try `<trigger> <app> <rest>` (e.g. "open chrome and go to youtube")
  for (const trigger of openTriggers) {
    const patAfter = new RegExp(`(?:^|\\s*)${trigger}\\s+([a-zA-Z0-9\u0980-\u09FF]+(?:\\s+[a-zA-Z0-9\u0980-\u09FF]+)?)(?:\\s+(?:and|then|এবং|তারপর|,)?\\s*(.*)|$)`, "i");
    const m = text.match(patAfter);
    if (m) {
      const candidate = m[1].trim();
      const appMatch = resolveApp(candidate);
      if (appMatch && appMatch.confidence >= 0.65) {
        const rest = (m[2] || "").trim();
        return { match: appMatch, rest };
      }
    }
  }

  // 3. Direct alias matching across known apps
  for (const app of APP_REGISTRY) {
    for (const alias of app.aliases) {
      if (norm.startsWith(alias) || norm.includes(` ${alias}`) || norm.endsWith(alias)) {
        const rest = norm.replace(alias, "").replace(/\s+/g, " ").trim();
        return { match: { app, confidence: 0.9 }, rest };
      }
    }
  }

  return null;
}

/**
 * Extracts URL navigation steps + search steps from remaining normalized text.
 */
function extractNavigationSteps(norm: string): ActionStep[] {
  const steps: ActionStep[] = [];
  if (!norm || norm.length === 0) return steps;

  let text = norm;

  // 1. Check for known site references (YouTube, Google, etc.)
  for (const site of SITE_REGISTRY) {
    for (const alias of site.aliases) {
      let matched = false;
      if (alias.length <= 3) {
        matched = new RegExp(`(?:^|\\s)${alias}(?:\\s|$)`, "i").test(text);
      } else {
        matched = text.includes(alias);
      }

      if (matched) {
        // Check if there is also a search phrase attached
        const searchPattern = /(?:search|সার্চ\s*করো|সার্চ\s*কর|সার্চ|খোঁজো|খুজো|গিয়ে|গিয়ে|এ\s+গিয়ে|এ\s+গিয়ে)\s+(?:for\s+)?(.+)/i;
        const searchMatch = text.match(searchPattern);

        let query = "";
        if (searchMatch) {
          query = searchMatch[1]
            .replace(/search|সার্চ\s*করো|সার্চ|খোঁজো|খুজো|করো|কর/gi, "")
            .replace(/[""']/g, "")
            .trim();
        }

        if (query.length > 0) {
          const searchUrl = site.searchUrl
            ? site.searchUrl.replace("%s", encodeURIComponent(query))
            : `https://www.google.com/search?q=${encodeURIComponent(query)}`;

          steps.push({
            action: "open_url",
            url: site.url,
            target: site.name,
            description: `Navigate to ${site.name}`,
          });
          steps.push({
            action: "search",
            query,
            url: searchUrl,
            description: `Search for "${query}" on ${site.name}`,
          });
        } else {
          steps.push({
            action: "open_url",
            url: site.url,
            target: site.name,
            description: `Navigate to ${site.name}`,
          });
        }

        return steps;
      }
    }
  }

  // 2. Generic Search triggers:
  // Check suffix: "<query> search করো" / "<query> search"
  const suffixSearchMatch = text.match(/(.+?)\s+(?:search\s*করো|সার্চ\s*করো|search\s*কর|সার্চ\s*কর|সার্চ|খোঁজো|খুজো|search)$/i);
  // Check prefix: "search (for) <query>" / "সার্চ করো <query>"
  const prefixSearchMatch = text.match(/(?:search\s*for|search|find|সার্চ\s*করো|সার্চ\s*কর|সার্চ|খোঁজো|খুজো)\s+(.+)$/i);

  const genericSearchMatch = suffixSearchMatch || prefixSearchMatch;

  if (genericSearchMatch) {
    let query = genericSearchMatch[1].replace(/[""']/g, "").trim();
    // Strip context keywords from beginning of query ("এখানে", "এখন", "here", "there")
    query = query.replace(/^(?:এখন|এখানে|সেখানে|there|here|in\s+this|on\s+this)\s+/gi, "").trim();
    query = query.replace(/(?:search|সার্চ\s*করো|সার্চ|খোঁজো|করো|কর)$/gi, "").trim();

    if (query.length > 0) {
      const ctx = getVoiceContext();
      let searchUrl: string;
      if (ctx.currentUrl) {
        const curSite = SITE_REGISTRY.find((s) => ctx.currentUrl?.includes(s.url.replace("https://", "").replace("www.", "")));
        searchUrl = curSite?.searchUrl
          ? curSite.searchUrl.replace("%s", encodeURIComponent(query))
          : `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      } else {
        searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      }

      steps.push({
        action: "search",
        query,
        url: searchUrl,
        description: `Search for "${query}"`,
      });
      return steps;
    }
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Main Parser
// ---------------------------------------------------------------------------

export class VoiceIntentParser {
  /**
   * Parses untrusted raw speech transcripts (English or Bengali) into
   * structured VoiceCommandIntent with multi-step action plans.
   */
  public parseTranscript(rawText: string, lang: string = "auto"): VoiceCommandIntent {
    const id = generateUUID();
    const now = Date.now();
    const detectedLang = lang === "auto" ? detectLanguage(rawText) : (lang as "en" | "bn");

    const norm = normalize(rawText);
    const ctx = getVoiceContext();

    // ── 1. Dangerous Command Detection (file delete, shutdown) ────────────────
    const fileDeleteMatch = norm.match(/(?:delete|remove)\s+(?:file|folder)\s+(.+)/i) ||
      norm.match(/(?:ফাইল|ফোল্ডার)\s+(?:ডিলিট|মুছে\s*ফেলো|রিমুভ)\s+(?:করো\s+)?(.+)/i);
    if (fileDeleteMatch) {
      return {
        id,
        type: "CODE_OPERATION",
        rawTranscript: rawText,
        language: detectedLang,
        confidence: 0.9,
        requiresExplicitApproval: true,
        riskLevel: "critical",
        summary: `DELETE file/folder: "${fileDeleteMatch[1].trim()}"`,
        payload: { operation: "delete", path: fileDeleteMatch[1].trim() },
        timestamp: now,
      };
    }

    // ── 2. Install extension ─────────────────────────────────────────────────
    const extMatch = norm.match(/install\s+(?:vscode\s+|vs\s*code\s+)?extension\s+([a-z0-9.\-_]+)/i) ||
      norm.match(/এক্সটেনশন\s+ইন্সটল\s+করো\s+([a-z0-9.\-_]+)/i);
    if (extMatch) {
      const extensionId = extMatch[1].trim();
      return {
        id,
        type: "INSTALL_EXTENSION",
        rawTranscript: rawText,
        language: detectedLang,
        confidence: 0.92,
        requiresExplicitApproval: true,
        riskLevel: "high",
        summary: `Install VS Code Extension: "${extensionId}"`,
        payload: { extensionId },
        timestamp: now,
      };
    }

    // ── 3. Terminal command ───────────────────────────────────────────────────
    const runCmdMatch = norm.match(/(?:open\s+terminal\s+(?:and\s+)?run|run\s+command|execute)\s+(.+)/i) ||
      norm.match(/(?:কমান্ড\s+চালাও|টার্মিনালে\s+রান\s+করো)\s+(.+)/i);
    if (runCmdMatch) {
      const command = runCmdMatch[1].trim();
      const isDangerous = /(rm\s+-rf|del\s+\/f|format|drop\s+database|shutdown)/i.test(command);
      return {
        id,
        type: "RUN_COMMAND",
        rawTranscript: rawText,
        language: detectedLang,
        confidence: 0.95,
        requiresExplicitApproval: true,
        riskLevel: isDangerous ? "critical" : "high",
        summary: `Run Command: "${command}"`,
        payload: { command, shell: "powershell.exe" },
        timestamp: now,
      };
    }

    // ── 4. Antigravity prompt injection ──────────────────────────────────────
    const agMatch = norm.match(/(?:antigravity\s+prompt|ask\s+agent\s+to)\s+(.+)/i) ||
      norm.match(/(?:অ্যান্টিগ্র্যাভিটি|antigravity)\s+প্রম্পট\s+দাও\s+(.+)/i);
    if (agMatch) {
      const promptText = agMatch[1].trim();
      return {
        id,
        type: "ANTIGRAVITY_PROMPT",
        rawTranscript: rawText,
        language: detectedLang,
        confidence: 0.92,
        requiresExplicitApproval: false,
        riskLevel: "medium",
        summary: `Send Prompt to Antigravity: "${promptText}"`,
        payload: { prompt: promptText, submit: true },
        timestamp: now,
      };
    }

    // ── 5. Open project ───────────────────────────────────────────────────────
    const openProjMatch = norm.match(/open\s+(?:project|workspace|folder)\s+(.+)/i) ||
      norm.match(/(?:প্রজেক্ট|ওয়ার্কস্পেস)\s+খোলো\s+(.+)/i);
    if (openProjMatch) {
      const projectName = openProjMatch[1].trim();
      return {
        id,
        type: "OPEN_PROJECT",
        rawTranscript: rawText,
        language: detectedLang,
        confidence: 0.9,
        requiresExplicitApproval: false,
        riskLevel: "low",
        summary: `Open Project: "${projectName}"`,
        payload: { projectName },
        timestamp: now,
      };
    }

    // ── 6. Context-only follow-up commands ("এখন YouTube এ যাও", "এখানে Python search করো")
    if (isContextReference(norm) && (ctx.currentApplication || ctx.currentUrl)) {
      const steps = extractNavigationSteps(norm);
      if (steps.length > 0 && ctx.currentApplication) {
        steps.unshift({
          action: "open_or_focus",
          target: ctx.currentApplication,
          description: `Focus ${ctx.currentApplication}`,
        });

        return this.buildMultiStepIntent(
          id, rawText, detectedLang, now, steps,
          `Continue in ${ctx.currentApplication}: ${steps.map((s) => s.description).join(" → ")}`
        );
      }
    }

    // ── 7. Multi-step: App + Navigation + Search ──────────────────────────────
    const appResult = extractOpenApp(norm);
    if (appResult) {
      const { match: appMatch, rest } = appResult;
      const steps: ActionStep[] = [];

      // Step 1: open/focus app
      steps.push({
        action: "open_or_focus",
        target: appMatch.app.appId,
        description: `Open/focus ${appMatch.app.displayName}`,
      });

      // Step 2+: navigation / search from the rest of the transcript
      const navSteps = extractNavigationSteps(rest);
      steps.push(...navSteps);

      // If only "open app" was detected with high confidence — simple open
      if (steps.length === 1 && appMatch.confidence >= 0.80) {
        return {
          id,
          type: "OPEN_APP",
          rawTranscript: rawText,
          language: detectedLang,
          confidence: appMatch.confidence,
          requiresExplicitApproval: false,
          riskLevel: "low",
          summary: `Launch ${appMatch.app.displayName}`,
          payload: {
            appName: appMatch.app.appId,
            displayName: appMatch.app.displayName,
            steps,
          },
          timestamp: now,
        };
      }

      // Multi-step plan
      if (steps.length >= 1) {
        const confidence = Math.min(appMatch.confidence, 0.95);
        const summary = steps.map((s) => s.description).join(" → ");

        if (confidence < 0.65) {
          return {
            id,
            type: "CLARIFICATION_NEEDED",
            rawTranscript: rawText,
            language: detectedLang,
            confidence,
            requiresExplicitApproval: false,
            riskLevel: "low",
            summary: `Not sure which app — did you mean "${appMatch.app.displayName}"?`,
            payload: { suggestions: [appMatch.app.displayName] },
            timestamp: now,
          };
        }

        return this.buildMultiStepIntent(id, rawText, detectedLang, now, steps, summary, confidence);
      }
    }

    // ── 8. Pure YouTube / media intent (no explicit app mentioned) ────────────
    if (
      norm.includes("youtube") ||
      norm.includes("ইউটিউব") ||
      norm.includes("ইউটিউবে")
    ) {
      let query = "";
      const searchMatch = norm.match(/(?:search|play|খোঁজো|চালাও|খুজো|সার্চ\s*করো|সার্চ)\s+(.+)/i) ||
        norm.match(/(?:গিয়ে|গিয়ে|এ)\s+(.+?)(?:\s+search|\s+সার্চ|\s+চালাও|$)/i);

      if (searchMatch) {
        query = searchMatch[1]
          .replace(/youtube|ইউটিউবে?|open|play|search|চালাও|করো|গান|ভিডিও/gi, "")
          .trim();
      }

      const url = query
        ? `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
        : "https://www.youtube.com";

      const steps: ActionStep[] = [
        { action: "open_or_focus", target: "chrome", description: "Open/focus Chrome" },
        { action: "open_url", url, target: "YouTube", description: query ? `Search YouTube: "${query}"` : "Open YouTube" },
      ];

      return this.buildMultiStepIntent(
        id,
        rawText,
        detectedLang,
        now,
        steps,
        query ? `Open YouTube and search: "${query}"` : "Open YouTube",
        0.95,
        "BROWSER_YOUTUBE"
      );
    }

    // ── 9. Unknown fallback ───────────────────────────────────────────────────
    return {
      id,
      type: "UNKNOWN",
      rawTranscript: rawText,
      language: detectedLang,
      confidence: 0.3,
      requiresExplicitApproval: false,
      riskLevel: "low",
      summary: `Unrecognized command: "${rawText}"`,
      payload: { raw: rawText },
      timestamp: now,
    };
  }

  private buildMultiStepIntent(
    id: string,
    rawText: string,
    language: "en" | "bn",
    timestamp: number,
    steps: ActionStep[],
    summary: string,
    confidence = 0.9,
    forceType?: string,
  ): VoiceCommandIntent {
    const type = (forceType || (steps.length === 1 ? "OPEN_APP" : "MULTI_STEP_PLAN")) as any;
    return {
      id,
      type,
      rawTranscript: rawText,
      language,
      confidence,
      requiresExplicitApproval: false,
      riskLevel: "low",
      summary,
      payload: { steps },
      timestamp,
    };
  }
}

export const voiceEngine = new VoiceIntentParser();
