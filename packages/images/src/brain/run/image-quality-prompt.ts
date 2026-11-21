import { imageQualityPromptPrompts } from "./prompts/image-quality-prompt.ts";

// Image APIs take one user-level prompt and no system role, so trusted guidance can only be
// ordered before the request; the request (user text or a group assignment) always comes last,
// under its own label, and is never merged into the guidance.

const QUALITY = {
  zh: imageQualityPromptPrompts.QUALITY.zh,
  en: imageQualityPromptPrompts.QUALITY.en,
};

// Rendering requirements for one generation (see also the image-designer role's norms, which a Bot
// owner can edit). Image runs read no skill files, so the brief has exactly one copy: this one.
const BRIEF = {
  zh: [
    imageQualityPromptPrompts.BRIEF.zh.item1,
    imageQualityPromptPrompts.BRIEF.zh.item2,
    imageQualityPromptPrompts.BRIEF.zh.item3,
    imageQualityPromptPrompts.BRIEF.zh.item4,
    imageQualityPromptPrompts.BRIEF.zh.item5,
    imageQualityPromptPrompts.BRIEF.zh.item6,
    imageQualityPromptPrompts.BRIEF.zh.item7,
  ],
  en: [
    imageQualityPromptPrompts.BRIEF.en.item1,
    imageQualityPromptPrompts.BRIEF.en.item2,
    imageQualityPromptPrompts.BRIEF.en.item3,
    imageQualityPromptPrompts.BRIEF.en.item4,
    imageQualityPromptPrompts.BRIEF.en.item5,
    imageQualityPromptPrompts.BRIEF.en.item6,
    imageQualityPromptPrompts.BRIEF.en.item7,
  ],
};

const NORMS_LIMIT = 2_000;

/** The Bot's own norms (user configuration), cut at a line so no rule arrives half-written. */
function normsSection(norms: string | undefined, language: "zh" | "en") {
  const lines = (norms ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length > NORMS_LIMIT) break;
    kept.push(line);
    length += line.length + 1;
  }
  if (!kept.length) return "";
  return `${imageQualityPromptPrompts.normsSection[language]}\n${kept.join("\n")}`;
}

/**
 * One deterministic prompt for a single generation (no extra model call, never a second paid
 * request): quality guidance, the Bot's norms, the brief checklist, then the request.
 */
export function imageQualityPrompt(request: string, language: "zh" | "en", norms?: string) {
  const sections = {
    quality: QUALITY[language],
    norms: normsSection(norms, language),
    brief: BRIEF[language].join("\n"),
    request: `${language === "zh" ? "用户请求：" : "User request:"}\n${request}`,
  };
  const text = Object.values(sections).filter(Boolean).join("\n\n");
  // Lengths only, for the per-generation diagnostic line: does the quality guidance slow services?
  return {
    text,
    lengths: {
      promptChars: text.length,
      requestChars: request.length,
      normsChars: sections.norms.length,
      briefChars: sections.brief.length,
    },
  };
}
