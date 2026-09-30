import { generateUUID, VoiceCommandIntent } from "@jarvis/shared";

export class VoiceIntentParser {
  /**
   * Parses untrusted raw speech transcripts (English or Bengali) into structured VoiceCommandIntent
   */
  public parseTranscript(rawText: string, lang = "auto"): VoiceCommandIntent {
    const text = rawText.trim();
    const lower = text.toLowerCase();
    const id = generateUUID();
    const now = Date.now();

    // 1. YouTube & Media Commands (EN & BN)
    // Matches: "open youtube and play lo-fi", "ইউটিউবে সার্চ করো গান", "play coding music on youtube"
    const youtubeEnMatch = lower.match(/(?:open\s+youtube\s+(?:and\s+)?(?:search|play)?|play\s+(.+?)\s+on\s+youtube|search\s+youtube\s+for\s+(.+))/i);
    const youtubeBnMatch = lower.match(/(?:ইউটিউব|youtube)(?:\s+খোলো|\s+ওপেন\s+করো|\s+এ\s+সার্চ\s+করো|\s+এ\s+গান\s+চালাও|\s+চালাও)(?:\s+(.+))?/i);
    
    if (youtubeEnMatch || youtubeBnMatch || lower.includes("youtube") || lower.includes("ইউটিউব")) {
      let query = "";
      if (youtubeEnMatch) {
        query = youtubeEnMatch[1] || youtubeEnMatch[2] || lower.replace(/open\s+youtube|play|search|on\s+youtube/gi, "").trim();
      } else if (youtubeBnMatch) {
        query = (youtubeBnMatch[1] || lower.replace(/ইউটিউব|খোলো|ওপেন|করো|গান|চালাও|সার্চ/gi, "")).trim();
      }

      return {
        id,
        type: "BROWSER_YOUTUBE",
        rawTranscript: text,
        language: lang === "auto" ? (/[^\x00-\x7F]/.test(text) ? "bn" : "en") : (lang as any),
        confidence: 0.95,
        requiresExplicitApproval: false,
        riskLevel: "low",
        summary: query ? `Open YouTube and search: "${query}"` : "Open YouTube Homepage",
        payload: {
          query,
          autoplay: true,
          url: query ? `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}` : "https://www.youtube.com",
        },
        timestamp: now,
      };
    }

    // 2. Install VS Code Extension (Requires Explicit Approval)
    // Matches: "install extension ms-python.python", "এক্সটেনশন ইন্সটল করো prisma"
    const extEnMatch = lower.match(/install\s+(?:vscode\s+|vs\s*code\s+)?extension\s+([a-z0-9\.\-_]+)/i);
    const extBnMatch = lower.match(/এক্সটেনশন\s+ইন্সটল\s+করো\s+([a-z0-9\.\-_]+)/i);

    if (extEnMatch || extBnMatch) {
      const extensionId = (extEnMatch ? extEnMatch[1] : extBnMatch![1]).trim();
      return {
        id,
        type: "INSTALL_EXTENSION",
        rawTranscript: text,
        language: extBnMatch ? "bn" : "en",
        confidence: 0.92,
        requiresExplicitApproval: true,
        riskLevel: "high",
        summary: `Install VS Code Extension: "${extensionId}"`,
        payload: {
          extensionId,
        },
        timestamp: now,
      };
    }

    // 3. File / Code Deletion or Editing (Requires Explicit Approval - Critical Risk)
    // Matches: "delete file src/index.ts", "ফাইল ডিলিট করো app.js", "edit code in package.json"
    const fileDeleteMatch = lower.match(/(?:delete|remove)\s+(?:file|folder|code)\s+(.+)/i) ||
                           lower.match(/(?:ফাইল|ফোল্ডার)\s+(?:ডিলিট|মুছে\s+ফেলো|রিমুভ)\s+(?:করো\s+)?(.+)/i);
    if (fileDeleteMatch) {
      const targetPath = fileDeleteMatch[1].trim();
      return {
        id,
        type: "CODE_OPERATION",
        rawTranscript: text,
        language: /[^\x00-\x7F]/.test(text) ? "bn" : "en",
        confidence: 0.9,
        requiresExplicitApproval: true,
        riskLevel: "critical",
        summary: `DELETE file/folder: "${targetPath}"`,
        payload: {
          operation: "delete",
          path: targetPath,
        },
        timestamp: now,
      };
    }

    // 4. Antigravity Agent Prompt Injection
    // Matches: "antigravity prompt fix the auth bug", "অ্যান্টিগ্র্যাভিটিতে প্রম্পট দাও build a navbar", "ask agent to refactor"
    const agPromptEn = lower.match(/(?:antigravity\s+prompt|ask\s+agent\s+to|send\s+prompt\s+to\s+agent)\s+(.+)/i);
    const agPromptBn = lower.match(/(?:অ্যান্টিগ্র্যাভিটি|antigravity)(?:\s+তে)?\s+প্রম্পট\s+দাও\s+(.+)/i);

    if (agPromptEn || agPromptBn) {
      const promptText = (agPromptEn ? agPromptEn[1] : agPromptBn![1]).trim();
      return {
        id,
        type: "ANTIGRAVITY_PROMPT",
        rawTranscript: text,
        language: agPromptBn ? "bn" : "en",
        confidence: 0.92,
        requiresExplicitApproval: false,
        riskLevel: "medium",
        summary: `Send Prompt to Antigravity: "${promptText}"`,
        payload: {
          prompt: promptText,
          submit: true,
        },
        timestamp: now,
      };
    }

    // 5. Open Project in VS Code / Antigravity
    // Matches: "open project control", "প্রজেক্ট খোলো my-app", "open workspace backend"
    const openProjEn = lower.match(/open\s+(?:project|workspace|folder)\s+(.+)/i);
    const openProjBn = lower.match(/(?:প্রজেক্ট|ওয়ার্কস্পেস)\s+খোলো\s+(.+)/i) || lower.match(/(.+)\s+প্রজেক্ট\s+ওপেন\s+করো/i);

    if (openProjEn || openProjBn) {
      const projectName = (openProjEn ? openProjEn[1] : (openProjBn![1] || openProjBn![2])).trim();
      return {
        id,
        type: "OPEN_PROJECT",
        rawTranscript: text,
        language: openProjBn ? "bn" : "en",
        confidence: 0.9,
        requiresExplicitApproval: false,
        riskLevel: "low",
        summary: `Open Project: "${projectName}"`,
        payload: {
          projectName,
        },
        timestamp: now,
      };
    }

    // 6. Run Terminal Command
    // Matches: "open terminal and run cd backend and npm run dev", "run command npm test", "কমান্ড চালাও npm run build"
    const runCmdEn = lower.match(/(?:open\s+terminal\s+(?:and\s+)?run|run\s+command|run\s+in\s+terminal|execute)\s+(.+)/i);
    const runCmdBn = lower.match(/(?:কমান্ড\s+চালাও|টার্মিনালে\s+রান\s+করো)\s+(.+)/i);

    if (runCmdEn || runCmdBn) {
      const command = (runCmdEn ? runCmdEn[1] : runCmdBn![1]).trim();
      const isDangerous = /(rm\s+-rf|del\s+\/f|format|drop\s+database|shutdown)/i.test(command);
      return {
        id,
        type: "RUN_COMMAND",
        rawTranscript: text,
        language: runCmdBn ? "bn" : "en",
        confidence: 0.95,
        requiresExplicitApproval: true, // Always show approval preview for terminal executions
        riskLevel: isDangerous ? "critical" : "high",
        summary: `Run Command: "${command}"`,
        payload: {
          command,
          shell: "powershell.exe",
        },
        timestamp: now,
      };
    }

    // 7. Open Application (VS Code, Antigravity, Terminal, Chrome, Edge)
    // Matches: "open vs code", "ভিএস কোড খোলো", "launch antigravity", "অ্যান্টিগ্র্যাভিটি খোলো"
    const openAppEn = lower.match(/(?:open|launch)\s+(vs\s*code|visual\s+studio\s+code|antigravity|chrome|browser|terminal|powershell|notepad|calculator)/i);
    const openAppBn = lower.match(/(ভিএস\s*কোড|অ্যান্টিগ্র্যাভিটি|ব্রাউজার|টার্মিনাল|ক্রোম|নোটপ্যাড)\s+(?:খোলো|চালাও|ওপেন\s+করো)/i);

    if (openAppEn || openAppBn) {
      const rawApp = (openAppEn ? openAppEn[1] : openAppBn![1]).toLowerCase();
      let appName = "code";
      let displayName = "VS Code";

      if (rawApp.includes("antigravity") || rawApp.includes("অ্যান্টিগ্র্যাভিটি")) {
        appName = "antigravity";
        displayName = "Antigravity IDE";
      } else if (rawApp.includes("terminal") || rawApp.includes("powershell") || rawApp.includes("টার্মিনাল")) {
        appName = "powershell";
        displayName = "PowerShell Terminal";
      } else if (rawApp.includes("chrome") || rawApp.includes("browser") || rawApp.includes("ব্রাউজার") || rawApp.includes("ক্রোম")) {
        appName = "chrome";
        displayName = "Web Browser";
      } else if (rawApp.includes("notepad") || rawApp.includes("নোটপ্যাড")) {
        appName = "notepad";
        displayName = "Notepad";
      }

      return {
        id,
        type: "OPEN_APP",
        rawTranscript: text,
        language: openAppBn ? "bn" : "en",
        confidence: 0.95,
        requiresExplicitApproval: false,
        riskLevel: "low",
        summary: `Launch Application: ${displayName}`,
        payload: {
          appName,
          displayName,
        },
        timestamp: now,
      };
    }

    // Fallback: Unknown Command
    return {
      id,
      type: "UNKNOWN",
      rawTranscript: text,
      language: /[^\x00-\x7F]/.test(text) ? "bn" : "en",
      confidence: 0.3,
      requiresExplicitApproval: false,
      riskLevel: "low",
      summary: `Unrecognized command: "${text}"`,
      payload: {
        raw: text,
      },
      timestamp: now,
    };
  }
}

export const voiceEngine = new VoiceIntentParser();
