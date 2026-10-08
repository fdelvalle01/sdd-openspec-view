import { spawn } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.VSCODE_EXECUTABLE || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe');
await access(executable);
await access(path.join(root, 'dist', 'extension.cjs'));
await access(path.join(root, 'media', 'view.js'));
await mkdir(path.join(root, '.local'), { recursive: true });
const runDirectory = await mkdtemp(path.join(root, '.local', 'host-smoke-'));
const fixture = path.join(runDirectory, 'workspace');
const editorProject = path.join(runDirectory, 'editor-project');
const profile = path.join(runDirectory, 'profile');
const extensions = path.join(runDirectory, 'extensions');
const resultPath = path.join(runDirectory, 'result.json');
await cp(path.join(root, 'demo'), fixture, { recursive: true });
await mkdir(editorProject);
await mkdir(path.join(profile, 'User'), { recursive: true });
await mkdir(extensions);
await writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'workbench.enableExperiments': false,
  'workbench.startupEditor': 'none',
  'window.restoreWindows': 'none',
  'security.workspace.trust.enabled': false,
}, null, 2));

const environment = { ...process.env, OPENSPEC_HOST_FIXTURE: fixture, OPENSPEC_HOST_RESULT: resultPath };
for (const variable of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_CLI', 'VSCODE_PID']) delete environment[variable];
const args = [
  '--new-window',
  '--disable-extensions',
  '--disable-updates',
  '--disable-workspace-trust',
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-gpu',
  `--user-data-dir=${profile}`,
  `--extensions-dir=${extensions}`,
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${path.join(root, 'tests', 'host.cjs')}`,
  editorProject,
];
console.log(`VS Code host smoke: ${runDirectory}`);
const child = spawn(executable, args, { cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-200_000); });
let timedOut = false;
const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
let exitCode;
try {
  exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
} finally {
  clearTimeout(timeout);
  await writeFile(path.join(runDirectory, 'launcher.log'), output);
}
if (timedOut) throw new Error(`VS Code exceeded the 120 second timeout. Logs: ${runDirectory}`);
let result;
try { result = JSON.parse(await readFile(resultPath, 'utf8')); }
catch { throw new Error(`VS Code exited (${exitCode}) without a test report. Logs: ${runDirectory}`); }
for (const check of result.checks) console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}`);
console.log(`Report: ${resultPath}`);
if (exitCode !== 0 || !result.passed) throw new Error(result.error || `VS Code exited with code ${exitCode}.`);
