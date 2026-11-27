import type { Subprocess } from 'bun';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');

export interface Instance {
  name: string;
  url: string;
  process: Subprocess;
  /** Resolve com o código de saída. */
  exited: Promise<number>;
  logs(): string;
  /** SIGTERM (graceful) ou SIGKILL (crash). */
  stop(signal?: 'SIGTERM' | 'SIGKILL'): Promise<number>;
}

let nextPort = 41_000 + Math.floor(Math.random() * 10_000);

/** Sobe um processo de SO real e separado rodando src/main.ts (uma instância completa da aplicação). */
export async function spawnInstance(name: string, env: Record<string, string>, waitReady = true): Promise<Instance> {
  const port = nextPort++;
  const child = Bun.spawn([process.execPath, 'run', join(ROOT, 'src', 'main.ts')], {
    cwd: ROOT,
    env: { ...process.env, ...env, PORT: String(port), INSTANCE_ID: name },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let output = '';
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk);
  };
  void collect(child.stdout as ReadableStream<Uint8Array>);
  void collect(child.stderr as ReadableStream<Uint8Array>);

  const instance: Instance = {
    name,
    url: `http://127.0.0.1:${port}`,
    process: child,
    exited: child.exited,
    logs: () => output,
    async stop(signal = 'SIGTERM') {
      child.kill(signal);
      return child.exited;
    },
  };

  if (waitReady) {
    const deadline = Date.now() + 20_000;
    while (true) {
      if (child.exitCode !== null) throw new Error(`${name} exited early:\n${output}`);
      try {
        const res = await fetch(`${instance.url}/health/ready`);
        if (res.status === 200) break;
      } catch {
        // ainda não está escutando
      }
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error(`${name} not ready in time:\n${output}`);
      }
      await Bun.sleep(100);
    }
  }
  return instance;
}
