// CUA reports packaged applications as either an AUMID or an AppsFolder shell target.
// Accept only that fixed shell namespace, never arbitrary shell targets or path basenames.
const APP_USER_MODEL_ID =
  /^[A-Za-z0-9][A-Za-z0-9.-]{0,139}_[A-Za-z0-9]{1,64}![A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function windowsPackagedAppId(launchPath: string): string | undefined {
  const id = launchPath.replace(/^shell:appsFolder\\/i, "");
  return id.length <= 255 && APP_USER_MODEL_ID.test(id) ? id.toLowerCase() : undefined;
}
