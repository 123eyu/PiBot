import type { Configuration } from "electron-builder";

export declare const linuxLauncher: string;
export declare const appRun: string;
declare const install: Exclude<NonNullable<Configuration["afterPack"]>, string>;
export default install;
