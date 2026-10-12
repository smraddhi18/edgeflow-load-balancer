export function log(level, event, fields = {}) {
  const record = { time: new Date().toISOString(), level, event, ...fields };
  process.stdout.write(`${JSON.stringify(record)}\n`);
}
