import path from 'node:path';
import { once } from 'node:events';
import pino from 'pino';

export function createRunLogger({
  runId,
  runDir,
  level = 'info'
}) {
  if (!runId) {
    throw new Error('createRunLogger requires runId');
  }

  if (!runDir) {
    throw new Error('createRunLogger requires runDir');
  }

  const logPath = path.join(runDir, 'run.jsonl');

  const destination = pino.destination({
    dest: logPath,
    mkdir: true,
    sync: false
  });

  const readyPromise = destination.ready
    ? Promise.resolve()
    : once(destination, 'ready');

  const logger = pino(
    {
      level,
      base: {
        runId,
        pid: process.pid
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level(label) {
          return { level: label };
        }
      },
      serializers: {
        err: pino.stdSerializers.err
      }
    },
    destination
  );

  let closePromise = null;

  async function flush() {
    await readyPromise;

    if (!closePromise) {
      closePromise = once(destination, 'close');
      destination.end();
    }

    await closePromise;
  }

  return {
    logger,
    logPath,
    flush
  };
}