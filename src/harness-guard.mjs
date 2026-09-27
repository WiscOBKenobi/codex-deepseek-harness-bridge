/** Restrict model tools to ordinary text files in one task workspace. This is not OS isolation. */
import { lstatSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, dirname, parse, sep } from 'node:path';

export const name = 'codex-bridge-guard';
export const inject = ['tools'];
const ALLOWED_TOOLS = Object.freeze(['read', 'write', 'edit']);
const MAX_OUTPUT_FILES = 200;
const MAX_OUTPUT_DEPTH = 12;

function within(root, path) {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part));
}

/** Reject symlinks/junctions and hardlinked files in every existing path component. */
export function inspectPlainPath(path, { allowMissing = false, directory = false } = {}) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let cursor = root;
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  for (let index = 0; index <= segments.length; index++) {
    if (index > 0) cursor = join(cursor, segments[index - 1]);
    let info;
    try { info = lstatSync(cursor); }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') return absolute;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error('Links and junctions are not allowed.');
    if (!info.isDirectory() && !info.isFile()) throw new Error('Only ordinary files and directories are allowed.');
    if (info.isFile() && info.nlink !== 1) throw new Error('Hardlinked files are not allowed.');
    if (index < segments.length && !info.isDirectory()) throw new Error('A parent is not a directory.');
    if (directory && index === segments.length && !info.isDirectory()) throw new Error('Expected a directory.');
    if (relative(cursor, realpathSync.native(cursor)) !== '') throw new Error('Path aliases are not allowed.');
  }
  return absolute;
}

/** Validate task roots before launch and before every guarded call. */
export function validateWorkspace(workspace) {
  const root = inspectPlainPath(workspace, { directory: true });
  inspectPlainPath(join(root, 'input'), { directory: true });
  inspectPlainPath(join(root, 'output'), { directory: true });
  return root;
}

function resolveToolPath(workspace, raw) {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 4096) throw new Error('A nonempty file_path is required.');
  if (/[\x00-\x1f]/u.test(raw) || /^(?:\\\\|\/\/|[a-z]+:\/\/)/iu.test(raw)) throw new Error('Device, URL, and network paths are not allowed.');
  const strippedDrive = raw.replace(/^[a-z]:[\\/]/iu, '');
  if (strippedDrive.includes(':')) throw new Error('Alternate streams and drive-relative paths are not allowed.');
  const parts = strippedDrive.split(/[\\/]/u);
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') continue;
    if (/[. ]$/u.test(part) || /[<>:"|?*]/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) {
      throw new Error('Ambiguous or reserved filename is not allowed.');
    }
  }
  const path = resolve(workspace, raw);
  if (!within(workspace, path)) throw new Error('Path is outside the task workspace.');
  inspectPlainPath(path, { allowMissing: true });
  return path;
}

function outputSize(root) {
  let bytes = 0;
  let files = 0;
  const visit = (dir, depth = 0) => {
    if (depth > MAX_OUTPUT_DEPTH) throw new Error('Output directory depth limit reached.');
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      inspectPlainPath(path);
      const info = lstatSync(path);
      if (info.isDirectory()) visit(path, depth + 1);
      else {
        bytes += info.size;
        files++;
        if (files > MAX_OUTPUT_FILES) throw new Error('Output file count limit reached.');
      }
    }
  };
  visit(root);
  return { bytes, files };
}

/** Return an execution guard; denied calls count toward the per-run tool budget. */
export function createToolGuard({ workspace, maxToolCalls, maxInputBytes, maxOutputBytes }) {
  const root = validateWorkspace(workspace);
  for (const [label, value] of Object.entries({ maxToolCalls, maxInputBytes, maxOutputBytes })) {
    if (!Number.isSafeInteger(value) || value < (label === 'maxToolCalls' ? 0 : 1)) throw new Error(label + ' has an invalid limit.');
  }
  let calls = 0;
  return execution => {
    calls++;
    if (maxToolCalls > 0 && calls > maxToolCalls) return 'Bridge policy: tool-call limit reached.';
    if (!ALLOWED_TOOLS.includes(execution?.name)) return 'Bridge policy: only read, write, and edit are allowed.';
    try {
      validateWorkspace(root);
      const args = execution.arguments;
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
      if (args.sandbox_permissions !== undefined && args.sandbox_permissions !== 'use_default') throw new Error('Permission escalation is not allowed.');
      const target = resolveToolPath(root, args.file_path);
      const input = join(root, 'input');
      const output = join(root, 'output');
      const writing = execution.name !== 'read';
      if (writing ? !within(output, target) : !(within(input, target) || within(output, target))) {
        throw new Error(writing ? 'Writes are allowed only under output/.' : 'Reads are allowed only under input/ and output/.');
      }
      let info;
      try { info = lstatSync(target); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (info && !info.isFile()) throw new Error('The target must be an ordinary file.');
      if (!writing) {
        if (info && info.size > (within(input, target) ? maxInputBytes : maxOutputBytes)) throw new Error('Input file size limit reached.');
        return undefined;
      }
      const parentDepth = relative(output, dirname(target)).split(sep).filter(Boolean).length;
      if (parentDepth > MAX_OUTPUT_DEPTH) throw new Error('Output directory depth limit reached.');
      const current = outputSize(output);
      let nextBytes;
      if (execution.name === 'write') {
        if (typeof args.content !== 'string') throw new Error('Write content must be text.');
        nextBytes = Buffer.byteLength(args.content);
      } else {
        if (!info || info.size > maxOutputBytes) throw new Error('Edit target is missing or exceeds the size limit.');
        if (typeof args.old_string !== 'string' || args.old_string === '' || typeof args.new_string !== 'string') throw new Error('Edit requires literal old_string and new_string.');
        const before = readFileSync(target, 'utf8');
        const after = args.replace_all ? before.split(args.old_string).join(args.new_string) : before.replace(args.old_string, () => args.new_string);
        nextBytes = Buffer.byteLength(after);
      }
      if (current.bytes - (info?.size ?? 0) + nextBytes > maxOutputBytes) throw new Error('Total output byte limit reached.');
      if (!info && current.files >= MAX_OUTPUT_FILES) throw new Error('Output file count limit reached.');
      return undefined;
    } catch (error) {
      const detail = error?.code ? 'File path validation failed (' + error.code + ').' : error.message;
      return 'Bridge policy: ' + detail;
    }
  };
}

/** Mount an irreversible guard and hide other tools before an agent receives its task. */
export function apply(ctx, config) {
  const guard = createToolGuard(config);
  ctx.tools.guard(guard);
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: ALLOWED_TOOLS });
  });
  process.stdout.write(JSON.stringify({ type: 'bridge_guard', version: 1, tools: ALLOWED_TOOLS }) + '\n');
}
