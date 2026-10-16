/**
 * dsh-file-menu — Host half.
 *
 * Serves authenticated `/api/dsh-file-menu.*` routes for one delivered
 * workspace file, addressed by the same coordinates the delivery cards use:
 * the owning Session, the `deliverables/presented` event sequence, and the
 * original index inside that event's `files` array.
 *
 * Actions performed here (in the Host process, where the real filesystem and
 * the host desktop live):
 *
 * - `open`      hand the file to its default application
 * - `reveal`    select the file in the platform file manager
 * - `openWith`  raise the platform's own "Open with" chooser for the file
 * - `copyPath`  report the absolute host path for the browser to put on the clipboard
 * - `copy`      put the file itself on the system clipboard (Windows/macOS)
 * - `saveAs`    copy the file into a directory chosen in a native picker
 * - `download`  stream the raw bytes for a browser download
 *
 * The routes live inside Connection's authentication fence, so every request
 * carries the same browser login the delivered-file routes already use.
 */
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, stat as fsStat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';

/** Services this Host half needs before it can serve a file action. */
export const inject = [
	'connection',
	'sessionQuery',
	'sessionController',
	'workspaceFiles',
	'fs',
	'sandboxPolicy'
];

const INFO_PATH = '/api/dsh-file-menu.info';
const ACT_PATH = '/api/dsh-file-menu.act';
const RAW_PATH = '/api/dsh-file-menu.raw';

/** Actions the Host performs itself. */
const HOST_ACTIONS = new Set(['open', 'reveal', 'openWith', 'copy', 'copyPath', 'saveAs']);

const NUMERIC = /^\d+$/;

/**
 * Decode one non-negative integer coordinate.
 * @param value - raw query value.
 * @returns the integer, or undefined when the text is not one.
 */
function coordinate(value) {
	if (value === null || !NUMERIC.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Read the file coordinates out of a request query.
 * @param request - the incoming request.
 * @returns the coordinates, or the 400 response to answer with.
 */
function coordinates(request) {
	const query = new URL(request.url).searchParams;
	const sessionId = query.get('sessionId');
	const seq = coordinate(query.get('seq'));
	const index = coordinate(query.get('index'));
	if (!sessionId || seq === undefined || index === undefined) {
		return new Response('Invalid file coordinates.', { status: 400 });
	}
	return { sessionId, seq, index };
}

/**
 * Resolve the addressed delivered file to a verified absolute host path.
 * Mirrors the shipped delivery-card routes: the declaration comes from the
 * Session log, and the path is resolved through the Session filesystem.
 * @returns the descriptor, or the response to answer with.
 */
async function resolveFile(ctx, request, id, seq, index) {
	request.signal.throwIfAborted();
	const read = await ctx.sessionQuery.readEvent({ sessionId: id, seq, before: 0, after: 0 }, request.signal);
	const { target, session } = read;
	const data = target.type === 'deliverables/presented' ? target.data : undefined;
	const declared = data && Array.isArray(data.files) ? data.files[index] : undefined;
	if (typeof declared?.path !== 'string' || declared.path.trim().length === 0) {
		return new Response('Delivered file not found in this Session result.', { status: 404 });
	}
	const { absolutePath: path, bytes } = await ctx.workspaceFiles.stat(
		{ sessionId: id, workspaceRoot: session.cwd ?? ctx.sandboxPolicy.workspaceRoot },
		declared.path,
		request.signal
	);
	request.signal.throwIfAborted();
	const mapped = ctx.fs.processPathFromHostPath(path);
	if (mapped === undefined || ctx.fs.processPath(await ctx.fs.resolve(mapped, { signal: request.signal })) !== path) {
		return new Response('Path has no verified Host path.', { status: 422 });
	}
	return {
		path,
		name: basename(path),
		directory: dirname(path),
		extension: extname(path).toLowerCase(),
		bytes,
		cwd: session.cwd
	};
}

/**
 * Run one short-lived helper program and resolve with its exit facts.
 * @param argv - the program and its arguments.
 * @param timeoutMs - how long to wait before killing it.
 * @returns exit code and combined output.
 */
function runHelper(argv, timeoutMs = 10_000) {
	return new Promise((resolve) => {
		let settled = false;
		let output = '';
		const done = (exitCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode, output: output.trim() });
		};
		let child;
		try {
			child = spawn(argv[0], argv.slice(1), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		} catch (error) {
			resolve({ exitCode: null, output: error instanceof Error ? error.message : String(error) });
			return;
		}
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {}
			done(null);
		}, timeoutMs);
		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (chunk) => {
			output += chunk;
		});
		child.stderr?.on('data', (chunk) => {
			output += chunk;
		});
		child.on('error', (error) => {
			output += error.message;
			done(null);
		});
		child.on('close', (code) => done(code));
	});
}

/**
 * Put the file itself on the system clipboard so it can be pasted elsewhere.
 * @param path - absolute host path of the file.
 * @returns whether the platform clipboard accepted it, with a reason otherwise.
 */
async function copyFileToClipboard(path) {
	if (process.platform === 'win32') {
		const script = `Set-Clipboard -LiteralPath ${JSON.stringify(path)}`;
		const result = await runHelper(['powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-Command', script]);
		if (result.exitCode === 0) return { copied: true };
		const fallback = await runHelper(['pwsh', '-NoProfile', '-NonInteractive', '-STA', '-Command', script]);
		if (fallback.exitCode === 0) return { copied: true };
		return { copied: false, reason: result.output || fallback.output || 'Set-Clipboard failed' };
	}
	if (process.platform === 'darwin') {
		const script = `set the clipboard to (POSIX file ${JSON.stringify(path)})`;
		const result = await runHelper(['osascript', '-e', script]);
		if (result.exitCode === 0) return { copied: true };
		return { copied: false, reason: result.output || 'osascript failed' };
	}
	return { copied: false, reason: 'The file clipboard is only available on Windows and macOS.' };
}

/**
 * Raise the operating system's own "Open with" chooser for one file.
 *
 * This exists because the Shell's handler enumeration can fail outright on
 * some extensions: `SHAssocEnumHandlers` returns a handler whose `GetName`
 * raises `E_FAIL` for .docx and .xlsx on machines with certain Office
 * installs, which aborts the whole sweep. The chooser below is the same
 * dialog Explorer shows, so the user can still pick an application even when
 * the list cannot be enumerated. The dialog outlives this request, so the
 * process is detached and never awaited.
 *
 * @param path - absolute host path of the file.
 * @returns whether the chooser was started, with a reason otherwise.
 */
function openWithChooser(path) {
	if (process.platform !== 'win32') {
		return { started: false, reason: 'The system chooser is only wired up on Windows.' };
	}
	try {
		const child = spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', path], {
			detached: true,
			stdio: 'ignore',
			windowsHide: false
		});
		// A detached dialog has no reader left for its failures: `spawn` reports
		// a missing binary as an asynchronous 'error' event, and an unheard
		// 'error' would take the whole Host process down. Swallow it here.
		child.on('error', () => {});
		child.unref();
		return { started: true };
	} catch (error) {
		return { started: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Ask the host for a destination directory through the native picker.
 * @returns the chosen directory, or undefined when no picker is available.
 */
async function pickDirectory(ctx, signal) {
	const picker = ctx.get('directoryPicker');
	const capability = picker?.capability?.();
	if (capability?.kind !== 'native') return undefined;
	const chosen = await capability.pick(signal);
	return typeof chosen === 'string' && chosen.length > 0 ? chosen : undefined;
}

/** Answer a GET with JSON and no caching. */
function json(value, status = 200) {
	return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

/** Answer with an empty body and no caching. */
function empty(status) {
	return new Response(null, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * Report what this file is and which actions this deployment can perform.
 * @returns the metadata the browser half builds its menu from.
 */
async function handleInfo(ctx, request) {
	const found = coordinates(request);
	if (found instanceof Response) return found;
	const { sessionId, seq, index } = found;
	try {
		const file = await resolveFile(ctx, request, sessionId, seq, index);
		if (file instanceof Response) return file;
		const desktop = ctx.sessionController.workspaceDesktop();
		let size = file.bytes;
		if (typeof size !== 'number') {
			try {
				size = (await fsStat(file.path)).size;
			} catch {
				size = undefined;
			}
		}
		return json({
			name: file.name,
			path: file.path,
			directory: file.directory,
			extension: file.extension,
			size: size ?? null,
			desktop: { name: desktop.name, available: desktop.available, fileManager: desktop.fileManager },
			platform: process.platform,
			capabilities: {
				open: desktop.available,
				reveal: desktop.available && desktop.fileManager !== null,
				copy: process.platform === 'win32' || process.platform === 'darwin',
				download: true,
				saveAs: true
			}
		});
	} catch (error) {
		request.signal.throwIfAborted();
		return new Response(`File unavailable: ${error instanceof Error ? error.message : String(error)}`, { status: 404 });
	}
}

/**
 * Perform one file action.
 * @returns the action's JSON result.
 */
async function handleAct(ctx, request) {
	const found = coordinates(request);
	if (found instanceof Response) return found;
	const { sessionId, seq, index } = found;
	const query = new URL(request.url).searchParams;
	const action = query.get('action') ?? '';
	if (!HOST_ACTIONS.has(action)) return new Response(`Unknown file action: ${action}`, { status: 400 });
	let file;
	try {
		const resolved = await resolveFile(ctx, request, sessionId, seq, index);
		if (resolved instanceof Response) return resolved;
		file = resolved;
	} catch (error) {
		request.signal.throwIfAborted();
		return new Response(`File unavailable: ${error instanceof Error ? error.message : String(error)}`, { status: 404 });
	}
	if (action === 'copyPath') return json({ ok: true, action, path: file.path });
	if (action === 'openWith') {
		if (!ctx.sessionController.workspaceDesktop().available) {
			return new Response('Host desktop unavailable.', { status: 409 });
		}
		const started = openWithChooser(file.path);
		if (!started.started) return new Response(`Could not open the chooser: ${started.reason}`, { status: 500 });
		return json({ ok: true, action, path: file.path });
	}
	if (action === 'open' || action === 'reveal') {
		if (!ctx.sessionController.workspaceDesktop().available) {
			return new Response('Host desktop unavailable.', { status: 409 });
		}
		try {
			await ctx.sessionController.openWorkspacePath(
				action === 'reveal' ? { path: file.path, action: 'reveal' } : { path: file.path },
				request.signal
			);
			return json({ ok: true, action, path: file.path });
		} catch (error) {
			request.signal.throwIfAborted();
			return new Response(`Could not ${action === 'reveal' ? 'reveal' : 'open'} the file: ${error instanceof Error ? error.message : String(error)}`, { status: 500 });
		}
	}
	if (action === 'copy') {
		const result = await copyFileToClipboard(file.path);
		if (!result.copied) return new Response(`Could not copy the file: ${result.reason}`, { status: 500 });
		return json({ ok: true, action, path: file.path, name: file.name });
	}
	// saveAs
	let destination;
	try {
		destination = await pickDirectory(ctx, request.signal);
	} catch (error) {
		request.signal.throwIfAborted();
		return new Response(`Could not choose a destination: ${error instanceof Error ? error.message : String(error)}`, { status: 500 });
	}
	if (destination === undefined) return json({ ok: false, action, reason: 'no-picker', path: file.path, name: file.name });
	const target = join(destination, file.name);
	try {
		await copyFile(file.path, target);
		return json({ ok: true, action, source: file.path, savedTo: target, name: file.name });
	} catch (error) {
		return new Response(`Could not save the file: ${error instanceof Error ? error.message : String(error)}`, { status: 500 });
	}
}

/**
 * Stream the raw bytes so the browser can download the file, or open the
 * download URL in a new tab.
 * @returns the file with a download disposition.
 */
async function handleRaw(ctx, request) {
	const found = coordinates(request);
	if (found instanceof Response) return found;
	const { sessionId, seq, index } = found;
	try {
		const file = await resolveFile(ctx, request, sessionId, seq, index);
		if (file instanceof Response) return file;
		let size = file.bytes;
		if (typeof size !== 'number') size = (await fsStat(file.path)).size;
		const asciiName = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
		// Stream instead of buffering: delivered files can be installers of
		// hundreds of megabytes, and the whole point is not to hold them in
		// memory twice (once here, once in the browser).
		const body = Readable.toWeb(createReadStream(file.path));
		return new Response(body, {
			status: 200,
			headers: {
				'content-type': 'application/octet-stream',
				'content-length': String(size),
				'cache-control': 'no-store',
				'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`
			}
		});
	} catch (error) {
		request.signal.throwIfAborted();
		return new Response(`File unavailable: ${error instanceof Error ? error.message : String(error)}`, { status: 404 });
	}
}

/**
 * Register the file-menu routes inside Connection's authentication fence.
 * @param ctx - Host context carrying Session lookup, the filesystem and the desktop opener.
 */
export function apply(ctx) {
	const lifetime = new AbortController();
	const pending = new Set();
	ctx.effect(() => async () => {
		lifetime.abort();
		await Promise.allSettled(pending);
	});
	const routes = [
		[INFO_PATH, ['GET'], handleInfo],
		[ACT_PATH, ['POST'], handleAct],
		[RAW_PATH, ['GET'], handleRaw]
	];
	for (const [path, methods, handler] of routes) {
		ctx.connection.fetch.register({
			path,
			methods: [...methods],
			requestBody: 'buffered',
			fetch: (request) => {
				const task = handler(ctx, new Request(request, { signal: AbortSignal.any([request.signal, lifetime.signal]) }));
				pending.add(task);
				task.then(
					() => pending.delete(task),
					() => pending.delete(task)
				);
				return task;
			}
		});
	}
}
