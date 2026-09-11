// Throwaway native-hook probe. No Lucid queue or delivery acknowledgement.
// Invoke with an absolute, agent-created temporary directory as argv[2].
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const root = process.argv[2];
if (!root?.startsWith('/')) throw new Error('An absolute probe directory is required');
const event = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(`${root}/events.ndjson`, `${JSON.stringify({
  event: event.hook_event_name,
  sessionId: event.session_id,
  cwd: event.cwd,
  hookPid: process.pid,
  parentPid: process.ppid,
  stopHookActive: event.stop_hook_active,
})}\n`);

if (event.hook_event_name === 'Stop' && !existsSync(`${root}/consumed`)) {
  writeFileSync(`${root}/listening`, 'ready');
  const end = Date.now() + 45_000;
  while (Date.now() < end && !existsSync(`${root}/feedback.txt`)) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (existsSync(`${root}/feedback.txt`)) {
    writeFileSync(`${root}/consumed`, 'yes');
    console.log(JSON.stringify({
      decision: 'block',
      reason: readFileSync(`${root}/feedback.txt`, 'utf8'),
    }));
  } else {
    console.log('{}');
  }
} else {
  console.log('{}');
}
