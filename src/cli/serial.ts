// CLI handlers share client, ban-list, and output state. Keep the entire command
// lifecycle (including connect/disconnect) exclusive in persistent MCP servers.
export function serialCommands(maxPending = 16): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (pending >= maxPending) throw new Error("Too many pending Tellatio commands");
    pending++;
    const task = tail.then(fn);
    tail = task.catch(() => {});
    try { return await task; } finally { pending--; }
  };
}
