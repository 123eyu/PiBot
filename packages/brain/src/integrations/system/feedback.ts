/** Only user-authored feedback and public build facts enter the URL; never pass an app snapshot. */
export function feedbackIssueUrl(input: {
  repository: string;
  title: string;
  description: string;
  version: string;
  platform: string;
}): string {
  const url = new URL(`https://github.com/${input.repository}/issues/new`);
  url.searchParams.set("title", input.title);
  url.searchParams.set(
    "body",
    `Pi Bot v${input.version.split(":")[0]}\nOS: ${input.platform}\n\n${input.description}`,
  );
  return url.href;
}
