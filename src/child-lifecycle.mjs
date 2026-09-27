/** Keep the official child tied to its supervisor without holding natural process exit open. */
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(1), 3000).unref();
  if (process.listenerCount('SIGTERM') > 0) process.emit('SIGTERM');
  else process.exit(1);
}
if (process.send) {
  process.on('message', message => {
    if (message?.type === 'codex-bridge-stop') stop();
  });
  process.on('disconnect', stop);
  process.channel?.unref();
}
