import { startSite } from "../site-server.mjs";

const site = await startSite("secret", Number(process.argv[2] ?? 0), process.argv[3]);
console.log(JSON.stringify({ ready: true, url: site.url }));
for (const s of ["SIGTERM", "SIGINT"]) process.once(s, () => void site.stop());
