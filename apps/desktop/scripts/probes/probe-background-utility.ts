// Self-created utility PID only. No SDK, DB, key or OS service is opened.
process.on("message", (value: { type?: string }) => {
  if (value.type === "stop") setTimeout(() => process.exit(0), 40);
});
