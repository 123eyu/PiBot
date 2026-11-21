export declare const MINGIT_VERSION: string;
/** Archive name and pinned SHA-256 per Windows architecture. */
export declare const MINGIT_DIGESTS: Readonly<Record<string, readonly [string, string]>>;
export declare function prepareMinGit(
  desktop: string,
  arch: string,
  binDirectory: string,
): Promise<string>;
