import { enSections } from "../../packages/i18n/src/en.ts";
import { zhSections } from "../../packages/i18n/src/zh.ts";

let duplicates = 0;
for (const [language, sections] of Object.entries({ zh: zhSections, en: enSections })) {
  const seen = new Map<string, string>();
  for (const [section, translations] of Object.entries(sections)) {
    for (const key of Object.keys(translations)) {
      const previous = seen.get(key);
      if (previous !== undefined) {
        console.error(`i18n ${language}: duplicate key "${key}" in ${previous} and ${section}`);
        duplicates++;
      } else {
        seen.set(key, section);
      }
    }
  }
}
if (duplicates > 0) process.exitCode = 1;
