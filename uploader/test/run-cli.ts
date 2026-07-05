import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const uploaderRoot = fileURLToPath(new URL('..', import.meta.url));

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `node --import tsx src/cli.ts <args>` exactly the way production runs it
 * (docker compose exec app node --import tsx src/cli.ts …). stdin is closed
 * immediately, so any prompt sees EOF — tests for the interactive path rely on that.
 * Not a .test.ts file: shared by cli.test.ts and pg.integration.test.ts.
 */
export function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
      cwd: uploaderRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** process.env without DATABASE_URL, for exercising the missing-env guard. */
export function envWithoutDatabaseUrl(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  return env;
}
