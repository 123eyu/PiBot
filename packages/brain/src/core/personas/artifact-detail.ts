import { artifactDetailPrompts } from "./prompts/artifact-detail.ts";
/** A constructive method for visual work; verification boundaries live in the shared guidance. */
export function artifactCreationMethod(language: "zh" | "en") {
  return artifactDetailPrompts.artifactCreationMethod[language];
}
