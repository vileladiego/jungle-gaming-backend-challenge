import { spawn, type ChildProcess } from 'node:child_process';

export interface TrackedProcess {
  label: string;
  child: ChildProcess;
  pid: number;
  logs: string;
}

export class ProcessRegistry {
  private readonly tracked: TrackedProcess[] = [];

  constructor(private readonly cwd: string) {}

  spawn(script: string, env: NodeJS.ProcessEnv, label: string): TrackedProcess {
    const child = spawn(process.execPath, [script], {
      cwd: this.cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error(`${label} did not receive a pid`);
    }
    const tracked: TrackedProcess = { label, child, pid, logs: '' };
    const append = (chunk: Buffer): void => {
      tracked.logs += chunk.toString('utf8');
      if (tracked.logs.length > 80_000) {
        tracked.logs = tracked.logs.slice(-40_000);
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    this.tracked.push(tracked);
    return tracked;
  }

  async stopAll(): Promise<void> {
    const current = this.tracked.splice(0);
    await Promise.all(current.map((tracked) => stopProcess(tracked, 'SIGTERM')));
  }

  async stop(tracked: TrackedProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<number | null> {
    const index = this.tracked.indexOf(tracked);
    if (index >= 0) {
      this.tracked.splice(index, 1);
    }
    return stopProcess(tracked, signal);
  }

  pids(): number[] {
    return this.tracked.map((tracked) => tracked.pid);
  }

  killSync(): void {
    for (const tracked of this.tracked) {
      signalGroup(tracked.pid, 'SIGKILL');
    }
  }
}

export async function stopProcess(tracked: TrackedProcess, signal: NodeJS.Signals): Promise<number | null> {
  if (tracked.child.exitCode !== null || tracked.child.signalCode !== null) {
    return tracked.child.exitCode;
  }
  signalGroup(tracked.pid, signal);
  try {
    return await waitForExit(tracked.child, 8_000);
  } catch {
    signalGroup(tracked.pid, 'SIGKILL');
    return waitForExit(tracked.child, 3_000);
  }
}

export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process already exited.
    }
  }
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('child process did not exit'));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
