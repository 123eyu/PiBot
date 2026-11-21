import type { Configuration } from "electron-builder";

declare const prepare: Exclude<Configuration["beforePack"], string | undefined>;
export default prepare;
