type Sections = Readonly<Record<string, Readonly<Record<string, string>>>>;
type Keys<T> = T extends unknown ? keyof T : never;
type TranslationValue<T, K> = T extends unknown ? (K extends keyof T ? T[K] : never) : never;

export function mergeTranslations<const T extends Sections>(sections: T) {
  type Tables = T[keyof T];
  return Object.assign({}, ...Object.values(sections)) as {
    readonly [K in Keys<Tables>]: TranslationValue<Tables, K>;
  };
}
