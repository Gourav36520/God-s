const pad = (n: number) => String(n).padStart(2, "0");

function timestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export const logger = {
  info: (msg: string, ...args: unknown[]) =>
    console.log(`[${timestamp()}] INFO  ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) =>
    console.warn(`[${timestamp()}] WARN  ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) =>
    console.error(`[${timestamp()}] ERROR ${msg}`, ...args),
  debug: (msg: string, ...args: unknown[]) =>
    console.debug(`[${timestamp()}] DEBUG ${msg}`, ...args),
};
