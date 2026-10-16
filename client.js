window.__ModuleLoader__.load({
	id: 'dsh-file-menu',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		const NS = 'dsh-file-menu';
		const INFO_ROUTE = 'api/dsh-file-menu.info';
		const ACT_ROUTE = 'api/dsh-file-menu.act';
		const RAW_ROUTE = 'api/dsh-file-menu.raw';

		/* ------------------------------------------------------------------ *
		 * Strings
		 *
		 * Every visible string lives here once, with its translation beside it,
		 * so the two dictionaries cannot drift apart.
		 * ------------------------------------------------------------------ */

		const STRINGS = {
			'menu.open': ['打开文件', 'Open file'],
			'menu.openWithChooser': ['用其他应用打开…', 'Open with…'],
			'menu.reveal': ['打开文件所在文件夹', 'Open containing folder'],
			'menu.copy': ['复制文件', 'Copy file'],
			'menu.copyPath': ['复制文件路径', 'Copy file path'],
			'menu.saveAs': ['另存为…', 'Save as…'],
			'menu.download': ['下载文件', 'Download file'],
			'menu.copyLink': ['复制下载链接', 'Copy download link'],
			'menu.openLink': ['在新标签页中打开下载链接', 'Open download link in new tab'],
			'menu.infoFailed': ['无法读取文件信息：{reason}', 'Could not read the file: {reason}'],
			'hint.defaultApp': ['默认应用', 'default app'],
			'hint.paste': ['可直接粘贴', 'paste ready'],
			'hint.pickFolder': ['选择文件夹', 'choose folder'],
			'hint.browserDownload': ['浏览器下载', 'browser download'],
			'note.desktopUnavailable': [
				'当前运行环境没有可用的桌面应用，只能使用网页方式（下载、复制链接）。',
				'No desktop application is available here, so only the web actions (download, copy link) can run.'
			],
			'note.sizeUnknown': ['大小未知', 'unknown size'],
			'note.thisFile': ['该文件', 'this file'],
			'status.opened': ['已用默认应用打开 {name}', 'Opened {name} with the default app'],
			'status.chooserOpened': ['已打开系统「打开方式」对话框', 'Opened the system chooser'],
			'status.revealed': ['已在文件管理器中定位', 'Revealed in the file manager'],
			'status.copied': ['文件已复制到剪贴板', 'File copied to the clipboard'],
			'status.copiedPath': ['已复制完整路径', 'Full path copied'],
			'status.copiedLink': ['下载链接已复制', 'Download link copied'],
			'status.started': ['已开始下载', 'Download started'],
			'status.openedTab': ['已在新标签页中打开', 'Opened in a new tab'],
			'status.savedTo': ['已保存到 {path}', 'Saved to {path}'],
			'status.savedBrowser': ['已交给浏览器下载（保存到默认下载目录）', 'Handed to the browser download (saved to the default folder)'],
			'status.saveFallback': ['宿主另存为不可用，已交给浏览器下载', 'Host save-as is unavailable; handed to the browser download'],
			'status.copyFallback': [
				'无法复制文件本体（{reason}），已改为复制文件路径',
				'Could not copy the file itself ({reason}); copied the path instead'
			],
			'status.copyFileFailed': ['无法复制文件本体：{reason}', 'Could not copy the file itself: {reason}'],
			'status.clipboardDenied': ['浏览器拒绝了剪贴板写入', 'The browser refused the clipboard write'],
			'trigger.title': ['更多文件操作（也可直接右键文件卡片）', 'More file actions (or right-click the file card)'],
			'trigger.label': ['更多文件操作', 'More file actions'],
			'meta.title': ['文件右键菜单', 'File Context Menu'],
			'meta.description': [
				'在交付文件卡片上右键，直接打开、复制文件、复制路径、定位文件夹、另存为或下载。',
				'Right-click a delivered file card to open, copy, reveal, save-as or download it.'
			]
		};

		/** Translate one key in the currently active locale, substituting placeholders. */
		let translate = (key) => key;

		function t(key, params) {
			let text = translate(key);
			if (params !== undefined) {
				for (const [name, value] of Object.entries(params)) {
					text = text.split(`{${name}}`).join(String(value));
				}
			}
			return text;
		}

		function dictionaries() {
			const zh = {};
			const en = {};
			for (const [key, [zhText, enText]] of Object.entries(STRINGS)) {
				zh[key] = zhText;
				en[key] = enText;
			}
			return { zh, en };
		}

		/* ------------------------------------------------------------------ *
		 * Shared state
		 *
		 * The card entry and the frame-wide overlay entry are two separate
		 * components in two different slots. This small store is what lets a
		 * right-click on a card drive the menu rendered in the overlay.
		 * ------------------------------------------------------------------ */

		const listeners = new Set();
		let snapshot = { open: false, target: null, x: 0, y: 0 };

		/** Card nodes owned by this plugin, mapped to their file coordinates. */
		const cards = new Map();

		/**
		 * Metadata already fetched for a file, keyed by its coordinates. The menu
		 * paints from this cache on the first frame, so a second right-click on
		 * the same card shows no pending state at all.
		 */
		const infoCache = new Map();

		function emit() {
			for (const listener of listeners) listener();
		}

		function setMenu(next) {
			snapshot = next;
			emit();
		}

		function openMenu(coordinates, x, y) {
			setMenu({ open: true, target: { coordinates }, x, y });
		}

		function closeMenu() {
			if (snapshot.open) setMenu({ open: false, target: null, x: 0, y: 0 });
		}

		function useSnapshot() {
			const [value, setValue] = React.useState(snapshot);
			React.useEffect(() => {
				const listener = () => setValue(snapshot);
				listeners.add(listener);
				setValue(snapshot);
				return () => {
					listeners.delete(listener);
				};
			}, []);
			return value;
		}

		/**
		 * Walk up from a context-menu target to the nearest card this plugin
		 * registered. Only our own nodes are in the map, so the lookup never
		 * inspects unrelated application markup.
		 */
		function coordinatesAt(node) {
			let element = node;
			while (element && element !== document.body) {
				if (element instanceof Element) {
					const found = cards.get(element);
					if (found !== undefined) return found;
					element = element.parentElement;
					continue;
				}
				break;
			}
			return undefined;
		}

		/* ------------------------------------------------------------------ *
		 * Routes, URLs and clipboard
		 * ------------------------------------------------------------------ */

		/** Read the file coordinates carried by the slot's authorized action URL. */
		function coordinatesFrom(actionUrl) {
			if (typeof actionUrl !== 'string' || actionUrl.length === 0) return undefined;
			let parsed;
			try {
				parsed = new URL(actionUrl, document.baseURI);
			} catch {
				return undefined;
			}
			const sessionId = parsed.searchParams.get('sessionId');
			const seq = parsed.searchParams.get('seq');
			const index = parsed.searchParams.get('index');
			if (!sessionId || seq === null || index === null) return undefined;
			return { sessionId, seq, index, key: `${sessionId}:${seq}:${index}` };
		}

		/** Build one of this plugin's route URLs from the coordinates. */
		function routeUrl(route, coordinates, extra) {
			const params = new URLSearchParams({
				sessionId: coordinates.sessionId,
				seq: coordinates.seq,
				index: coordinates.index
			});
			if (extra !== undefined) {
				for (const [name, value] of Object.entries(extra)) params.set(name, value);
			}
			return `${route}?${params.toString()}`;
		}

		function absoluteUrl(relative) {
			try {
				return new URL(relative, document.baseURI).href;
			} catch {
				return relative;
			}
		}

		/** Read a JSON route, turning every failure into a readable reason. */
		async function requestJson(url, init) {
			const response = await fetch(url, init);
			const text = await response.text();
			let payload = null;
			if (text.length > 0) {
				try {
					payload = JSON.parse(text);
				} catch {
					payload = null;
				}
			}
			if (!response.ok) {
				throw new Error(text.trim().length > 0 ? text.trim() : `HTTP ${response.status}`);
			}
			return payload;
		}

		/** Run one Host file action. */
		function runAction(coordinates, action, extra) {
			return requestJson(routeUrl(ACT_ROUTE, coordinates, { action, ...(extra ?? {}) }), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}'
			});
		}

		/**
		 * How many files each route remembers. A long session presents many
		 * cards; without a bound the caches would grow for the whole session.
		 * Insertion order makes eviction free — the oldest key goes first.
		 */
		const CACHE_LIMIT = 200;

		/** Remember one settled payload, dropping the oldest entry when full. */
		function remember(cache, key, payload) {
			if (payload === undefined) return;
			cache.delete(key);
			cache.set(key, payload);
			while (cache.size > CACHE_LIMIT) {
				const oldest = cache.keys().next();
				if (oldest.done === true) break;
				cache.delete(oldest.value);
			}
		}

		/**
		 * Fetch a route's JSON while deduplicating concurrent readers and
		 * remembering the result.
		 *
		 * The menu opens on the first frame from whatever is already in the
		 * cache; a request only ever runs to fill a gap. Two overlapping
		 * fetches for the same key share one promise, so a fast open/close/open
		 * never queues duplicate work. Failures are never cached, so a card
		 * that failed once is retried rather than staying broken.
		 *
		 * @param cache - the Map holding settled payloads for this route.
		 * @param inflight - the Map holding promises currently in flight.
		 * @param key - the coordinates key identifying the file.
		 * @param url - the route URL to read when the cache misses.
		 */
		function readCached(cache, inflight, key, url) {
			const settled = cache.get(key);
			if (settled !== undefined) return Promise.resolve(settled);
			const running = inflight.get(key);
			if (running !== undefined) return running;
			const task = requestJson(url)
				.then((payload) => {
					remember(cache, key, payload);
					return payload;
				})
				.finally(() => {
					inflight.delete(key);
				});
			inflight.set(key, task);
			return task;
		}

		const infoInflight = new Map();

		/**
		 * How many metadata reads may run at once while warming the cards that are
		 * merely on screen. Without a bound, a session opening on dozens of
		 * delivered files would fire every read in the same tick.
		 */
		const PREFETCH_CONCURRENCY = 2;

		/** Reads waiting for a free slot, oldest first. */
		const prefetchQueue = [];

		/** How many prefetch reads are in flight right now. */
		let prefetchRunning = 0;

		/**
		 * Keys already handed to the prefetcher, so a card that scrolls in and out
		 * of view is not asked for again and again. Bounded exactly like the
		 * payload caches; eviction here only costs a repeated read.
		 */
		const prefetched = new Set();

		/** Run one queued task when the browser is next idle. */
		function whenIdle(task) {
			if (typeof window.requestIdleCallback === 'function') {
				window.requestIdleCallback(task, { timeout: 1000 });
				return;
			}
			window.setTimeout(task, 0);
		}

		/** Start queued prefetches until the concurrency bound is reached. */
		function pumpPrefetch() {
			while (prefetchRunning < PREFETCH_CONCURRENCY && prefetchQueue.length > 0) {
				const next = prefetchQueue.shift();
				prefetchRunning += 1;
				whenIdle(() => {
					readCached(infoCache, infoInflight, next.key, next.url)
						// A prefetch is invisible by design: on failure nothing is
						// remembered, and the menu reports it if the user opens it.
						.catch(() => {})
						.finally(() => {
							prefetchRunning -= 1;
							pumpPrefetch();
						});
				});
			}
		}

		/**
		 * Read one file's metadata ahead of any right-click.
		 *
		 * The header (name, size, directory) is the only part of the menu that has
		 * to be asked of the Host. Warming it while the card is merely visible
		 * makes the first right-click behave exactly like every later one: the
		 * header is painted on the same frame as the menu itself.
		 */
		function prefetch(coordinates) {
			if (coordinates === undefined) return;
			const key = coordinates.key;
			if (infoCache.has(key) || infoInflight.has(key) || prefetched.has(key)) return;
			prefetched.add(key);
			while (prefetched.size > CACHE_LIMIT) {
				const oldest = prefetched.keys().next();
				if (oldest.done === true) break;
				prefetched.delete(oldest.value);
			}
			prefetchQueue.push({ key, url: routeUrl(INFO_ROUTE, coordinates) });
			pumpPrefetch();
		}

		/** Copy plain text, preferring the async clipboard API. */
		async function copyText(text) {
			try {
				if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
					await navigator.clipboard.writeText(text);
					return true;
				}
			} catch {
				/* fall through to the legacy path */
			}
			const area = document.createElement('textarea');
			area.value = text;
			area.setAttribute('readonly', '');
			area.style.position = 'fixed';
			area.style.top = '-1000px';
			document.body.appendChild(area);
			area.select();
			let copied = false;
			try {
				copied = document.execCommand('copy');
			} catch {
				copied = false;
			}
			document.body.removeChild(area);
			return copied;
		}

		function mimeForPath(path) {
			if (typeof path !== 'string') return null;
			const dot = path.lastIndexOf('.');
			if (dot < 0) return null;
			const extension = path.slice(dot).toLowerCase();
			if (extension === '.png') return 'image/png';
			if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
			if (extension === '.webp') return 'image/webp';
			if (extension === '.gif') return 'image/gif';
			if (extension === '.svg') return 'image/svg+xml';
			if (extension === '.txt' || extension === '.md' || extension === '.json' || extension === '.csv') return 'text/plain';
			return null;
		}

		/**
		 * Fall back to the browser clipboard, which only carries media types the
		 * platform recognises.
		 */
		async function copyViaBrowser(coordinates) {
			if (typeof window.ClipboardItem !== 'function' || !navigator.clipboard || typeof navigator.clipboard.write !== 'function') {
				return { copied: false, reason: 'the browser has no file clipboard' };
			}
			const mime = mimeForPath(coordinates.path);
			if (mime === null) return { copied: false, reason: 'the browser only accepts images and text files' };
			try {
				const response = await fetch(routeUrl(RAW_ROUTE, coordinates));
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const body = await response.arrayBuffer();
				const item = new window.ClipboardItem({ [mime]: new Blob([body], { type: mime }) });
				await navigator.clipboard.write([item]);
				return { copied: true, how: 'browser' };
			} catch (error) {
				return { copied: false, reason: error instanceof Error ? error.message : String(error) };
			}
		}

		/**
		 * Put the file itself on the clipboard. The Host does this on Windows
		 * and macOS; everywhere else the browser clipboard is tried, and the
		 * caller falls back to copying the path.
		 */
		async function copyFileBody(coordinates) {
			try {
				const result = await runAction(coordinates, 'copy');
				if (result && result.ok === true) return { copied: true, how: 'host' };
			} catch {
				/* the browser path below reports the real reason */
			}
			return copyViaBrowser(coordinates);
		}

		/** Trigger a browser download for the file. */
		function startDownload(coordinates) {
			const anchor = document.createElement('a');
			anchor.href = absoluteUrl(routeUrl(RAW_ROUTE, coordinates));
			anchor.rel = 'noopener';
			anchor.download = typeof coordinates.name === 'string' ? coordinates.name : '';
			anchor.style.display = 'none';
			document.body.appendChild(anchor);
			anchor.click();
			document.body.removeChild(anchor);
		}

		function openInNewTab(url) {
			const opened = window.open(url, '_blank', 'noopener,noreferrer');
			if (opened === null) {
				const anchor = document.createElement('a');
				anchor.href = url;
				anchor.target = '_blank';
				anchor.rel = 'noopener';
				anchor.style.display = 'none';
				document.body.appendChild(anchor);
				anchor.click();
				document.body.removeChild(anchor);
			}
		}

		/* ------------------------------------------------------------------ *
		 * Formatting and icons
		 * ------------------------------------------------------------------ */

		function formatBytes(bytes) {
			if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
			if (bytes < 1024) return `${bytes} B`;
			const units = ['KB', 'MB', 'GB', 'TB'];
			let value = bytes / 1024;
			let unit = 0;
			while (value >= 1024 && unit < units.length - 1) {
				value /= 1024;
				unit += 1;
			}
			return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
		}

		/** A 16px stroke glyph inheriting text color. */
		function icon(paths) {
			return h(
				'svg',
				{
					viewBox: '0 0 24 24',
					width: 16,
					height: 16,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.7,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': true,
					className: 'dfm-ico-svg'
				},
				paths.map((d, index) => h('path', { key: index, d }))
			);
		}

		// Every row carries a glyph; `dots` is the trigger's own.
		const ICONS = {
			open: ['M14 3h7v7', 'M21 3l-9 9', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
			app: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
			folder: ['M3 8a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
			copy: [
				'M9 9V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-4',
				'M5 9h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z'
			],
			path: ['M9 3h6v3H9z', 'M15 4.5h2a2 2 0 0 1 2 2V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h2'],
			saveAs: ['M12 4v10', 'M8 10l4 4 4-4', 'M4 18h16'],
			download: ['M12 4v10', 'M8 10l4 4 4-4', 'M4 18h16'],
			newTab: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14L21 3'],
			link: ['M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1', 'M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1'],
			dots: ['M12 5.5h.01', 'M12 12h.01', 'M12 18.5h.01']
		};

		/* ------------------------------------------------------------------ *
		 * Styles — theme tokens only, own prefix, injected by an effect
		 * ------------------------------------------------------------------ */

		const CSS = `
.dfm-holder{display:inline-flex;align-items:center;flex:none;vertical-align:middle}
.dfm-trigger{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;flex:none;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s ease,color .15s ease,border-color .15s ease}
.dfm-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary)}
.dfm-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dfm-trigger:disabled{opacity:.45;cursor:default}
.dfm-layer{position:fixed;inset:0;z-index:2147483000;pointer-events:auto}
.dfm-scrim{position:absolute;inset:0}
.dfm-menu{position:fixed;min-width:260px;max-width:360px;display:flex;flex-direction:column;padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 14px 36px rgba(0,0,0,.22);font-size:13px;line-height:18px;font-family:-apple-system,"SF Pro Text","PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif;overflow:hidden}
.dfm-head{display:flex;align-items:flex-start;padding:8px 8px 9px;min-width:0;box-sizing:border-box;min-height:52px}
.dfm-headtext{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.dfm-name{font-weight:600;word-break:break-all;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dfm-meta{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;word-break:break-all;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dfm-bar{border-radius:4px;background:var(--dsw-alias-border-l1);opacity:.7;flex:none}
.dfm-bar-name{height:18px;width:62%}
.dfm-bar-meta{height:15px;width:44%}
.dfm-sep{height:1px;margin:5px 6px;flex:none;background:var(--dsw-alias-border-l1)}
.dfm-note{padding:6px 8px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;word-break:break-word}
.dfm-note[data-kind=error]{color:var(--dsw-alias-state-error-primary)}
.dfm-note[data-kind=ok]{color:var(--dsw-alias-state-success-primary)}
.dfm-scroll{display:flex;flex-direction:column;max-height:min(56vh,420px);overflow-y:auto;overscroll-behavior:contain}
.dfm-item{display:flex;align-items:center;gap:9px;width:100%;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}
.dfm-item:hover:not(:disabled),.dfm-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-1));outline:none}
.dfm-item:disabled{opacity:.45;cursor:default}
.dfm-ico{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-secondary)}
.dfm-item:hover:not(:disabled) .dfm-ico,.dfm-item:focus-visible .dfm-ico{color:var(--dsw-alias-brand-primary)}
.dfm-label{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dfm-hint{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;max-width:132px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dfm-ico-svg{display:block}
`;

		/* ------------------------------------------------------------------ *
		 * Card entry: one small button beside the shipped open control, plus the
		 * right-click binding for the whole card.
		 * ------------------------------------------------------------------ */

		/**
		 * Warms the metadata of every card that scrolls into view.
		 *
		 * One observer is shared by all triggers; it looks the card up in the same
		 * registry the right-click lookup uses, so it reads no foreign markup. A
		 * runtime without `IntersectionObserver` simply warms on mount instead —
		 * the read is idempotent, so the difference is only when it happens.
		 */
		const cardObserver =
			typeof IntersectionObserver === 'function'
				? new IntersectionObserver((entries) => {
						for (const entry of entries) {
							if (entry.isIntersecting !== true) continue;
							const found = cards.get(entry.target);
							if (found !== undefined) prefetch(found);
						}
					})
				: null;

		function FileMenuTrigger(props) {
			const coordinates = React.useMemo(() => coordinatesFrom(props.actionUrl), [props.actionUrl]);
			const holder = React.useRef(null);
			const blocked = props.pending === true;

			/**
			 * Register the enclosing card, reached through this component's own
			 * ancestry, so a right-click anywhere on the card opens the menu.
			 */
			React.useEffect(() => {
				if (coordinates === undefined) return undefined;
				const node = holder.current;
				if (node === null) return undefined;
				const card = typeof node.closest === 'function' ? node.closest('[data-presented-file]') : null;
				const scope = card ?? node.parentElement;
				if (scope === null) return undefined;
				cards.set(scope, coordinates);
				// Warm the card as soon as a human could plausibly reach it, so the
				// header is already known by the time anyone right-clicks.
				if (cardObserver === null) {
					prefetch(coordinates);
				} else {
					cardObserver.observe(scope);
				}
				return () => {
					if (cardObserver !== null) cardObserver.unobserve(scope);
					if (cards.get(scope) === coordinates) cards.delete(scope);
				};
			}, [coordinates]);

			if (coordinates === undefined) return null;

			const openAt = (x, y) => {
				if (blocked) return;
				openMenu(coordinates, x, y);
			};

			return h(
				'span',
				{
					ref: holder,
					className: 'dfm-holder',
					// A pointer over the card almost always precedes a right-click, so
					// it re-asks for the header even if the idle pass has not run yet.
					onPointerEnter: () => prefetch(coordinates),
					onContextMenu: (event) => {
						event.preventDefault();
						event.stopPropagation();
						openAt(event.clientX, event.clientY);
					}
				},
				h(
					'button',
					{
						type: 'button',
						className: 'dfm-trigger',
						disabled: blocked,
						title: t('trigger.title'),
						'aria-label': t('trigger.label'),
						'aria-haspopup': 'menu',
						onClick: (event) => {
							event.preventDefault();
							event.stopPropagation();
							const rect = event.currentTarget.getBoundingClientRect();
							openAt(rect.right - 4, rect.bottom + 6);
						}
					},
					icon(ICONS.dots)
				)
			);
		}

		/* ------------------------------------------------------------------ *
		 * Overlay entry: the menu
		 * ------------------------------------------------------------------ */

		function FileMenuLayer() {
			const state = useSnapshot();
			const [info, setInfo] = React.useState(null);
			const [loading, setLoading] = React.useState(false);
			const [busy, setBusy] = React.useState(null);
			const [status, setStatus] = React.useState(null);
			const menuRef = React.useRef(null);
			const [position, setPosition] = React.useState(null);

			const coordinates = state.open && state.target ? state.target.coordinates : null;
			const targetKey = coordinates === null ? null : coordinates.key;

			/**
			 * Load the addressed file's metadata, and drop it when the menu closes.
			 *
			 * The cache is consulted first and seeds state synchronously, so a card
			 * seen before opens with its header already in place. Only a genuine
			 * miss shows the pending row, and nothing here ever blocks the menu
			 * from painting.
			 */
			React.useEffect(() => {
				if (targetKey === null || coordinates === null) {
					setInfo(null);
					setLoading(false);
					setBusy(null);
					setStatus(null);
					return undefined;
				}
				let cancelled = false;
				setBusy(null);
				setStatus(null);
				const cached = infoCache.get(targetKey);
				setInfo(cached === undefined ? null : { ...cached, coordinates });
				setLoading(cached === undefined);
				readCached(infoCache, infoInflight, targetKey, routeUrl(INFO_ROUTE, coordinates))
					.then((payload) => {
						if (cancelled) return;
						setInfo({ ...(payload ?? {}), coordinates });
					})
					.catch((error) => {
						if (cancelled) return;
						setInfo({ failed: error instanceof Error ? error.message : String(error), coordinates });
					})
					.finally(() => {
						if (!cancelled) setLoading(false);
					});
				return () => {
					cancelled = true;
				};
			}, [targetKey]);

			/**
			 * Place the menu at the pointer, then pull it back inside the viewport.
			 *
			 * The first placement is synchronous, with a size estimate, so the menu
			 * is visible in the same frame the right-click happened; the measuring
			 * pass then corrects it against the real box.
			 */
			React.useLayoutEffect(() => {
				if (!state.open) {
					setPosition(null);
					return undefined;
				}
				const place = (width, height) => {
					const margin = 8;
					let left = state.x;
					let top = state.y;
					if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
					if (left < margin) left = margin;
					if (top + height > window.innerHeight - margin) top = state.y - height;
					if (top < margin) top = margin;
					setPosition({ left, top });
				};
				place(320, 360);
				let frame = requestAnimationFrame(() => {
					const node = menuRef.current;
					place(node === null ? 320 : node.offsetWidth, node === null ? 360 : node.offsetHeight);
				});
				return () => cancelAnimationFrame(frame);
			}, [state.open, state.x, state.y, info, status, busy, loading]);

			if (!state.open || coordinates === null) return null;

			const loaded = info !== null && info.failed === undefined;
			const desktop = info !== null && info.failed === undefined ? info.desktop : undefined;
			const rawUrl = absoluteUrl(routeUrl(RAW_ROUTE, coordinates));
			const desktopKnown = desktop !== undefined;
			const desktopAvailable = desktopKnown && desktop.available === true;
			// Until the info payload lands, desktop availability is unknown. Attempt
			// the Host path in that window — a 409 degrades to the browser download —
			// rather than denying the user the native picker.
			const tryHost = desktopKnown ? desktopAvailable : true;
			// Before the measuring pass reports a box, the menu sits exactly at the
			// pointer; the layout effect corrects it before the frame is painted.
			const placed = position ?? { left: state.x, top: state.y };

			const run = async (action, handler) => {
				if (busy !== null) return;
				setBusy(action);
				setStatus(null);
				try {
					const result = await handler();
					setBusy(null);
					if (result === undefined || result.keepOpen === true) {
						if (result && result.status) setStatus(result.status);
						return;
					}
					if (result.status) setStatus(result.status);
					window.setTimeout(closeMenu, 1000);
				} catch (error) {
					setBusy(null);
					setStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
				}
			};

			/**
			 * Read facts the pending info payload may not have delivered yet.
			 *
			 * Actions reference the file by coordinates, so a missing fact only
			 * softens a label or an icon badge; it never blocks the action.
			 */
			const known = infoCache.get(targetKey);
			const knownFact = (field) => {
				if (loaded && info[field] !== undefined && info[field] !== null) return info[field];
				return known === undefined ? undefined : known[field];
			};
			const currentName = () => {
				const name = knownFact('name');
				return typeof name === 'string' ? name : t('note.thisFile');
			};

			const items = [];

			if (info !== null && info.failed !== undefined) {
				// The file could not be resolved at all, so nothing here can work.
				items.push({
					key: 'failed',
					iconPath: ICONS.path,
					label: t('menu.infoFailed', { reason: info.failed }),
					disabled: true
				});
			} else {
				// Every action below is driven by the coordinates alone, so the menu
				// is complete and usable before any metadata arrives.
				items.push({
					key: 'open',
					iconPath: ICONS.open,
					label: t('menu.open'),
					hint: desktopAvailable ? t('hint.defaultApp') : '',
					onSelect: () =>
						run('open', async () => {
							await runAction(coordinates, 'open');
							return { status: { kind: 'ok', text: t('status.opened', { name: currentName() }) } };
						})
				});
				items.push({
					key: 'openWith',
					iconPath: ICONS.app,
					label: t('menu.openWithChooser'),
					onSelect: () =>
						run('openWith', async () => {
							await runAction(coordinates, 'openWith');
							return { status: { kind: 'ok', text: t('status.chooserOpened') } };
						})
				});
				items.push({
					key: 'reveal',
					iconPath: ICONS.folder,
					label: t('menu.reveal'),
					onSelect: () =>
						run('reveal', async () => {
							await runAction(coordinates, 'reveal');
							return { status: { kind: 'ok', text: t('status.revealed') } };
						})
				});
				items.push({ key: 'sep-a', separator: true });
				items.push({
					key: 'copy',
					iconPath: ICONS.copy,
					label: t('menu.copy'),
					hint: t('hint.paste'),
					onSelect: () =>
						run('copy', async () => {
							const known = infoCache.get(targetKey);
							const knownPath = known && typeof known.path === 'string' ? known.path : undefined;
							const result = await copyFileBody({ ...coordinates, path: knownPath });
							if (result.copied) {
								return { keepOpen: true, status: { kind: 'ok', text: t('status.copied') } };
							}
							const copiedPath = knownPath === undefined ? false : await copyText(knownPath);
							return {
								keepOpen: true,
								status: copiedPath
									? { kind: 'error', text: t('status.copyFallback', { reason: result.reason }) }
									: { kind: 'error', text: t('status.copyFileFailed', { reason: result.reason }) }
							};
						})
				});
				items.push({
					key: 'copyPath',
					iconPath: ICONS.path,
					label: t('menu.copyPath'),
					onSelect: () =>
						run('copyPath', async () => {
							let path = infoCache.get(targetKey)?.path;
							try {
								const result = await runAction(coordinates, 'copyPath');
								if (result && typeof result.path === 'string') path = result.path;
							} catch {
								/* fall back to whatever the info payload already reported */
							}
							if (typeof path !== 'string') {
								return { keepOpen: true, status: { kind: 'error', text: t('status.clipboardDenied') } };
							}
							const copied = await copyText(path);
							return {
								keepOpen: true,
								status: copied ? { kind: 'ok', text: t('status.copiedPath') } : { kind: 'error', text: t('status.clipboardDenied') }
							};
						})
				});
				items.push({ key: 'sep-b', separator: true });
				items.push({
					key: 'saveAs',
					iconPath: ICONS.saveAs,
					label: t('menu.saveAs'),
					hint: desktopAvailable ? t('hint.pickFolder') : t('hint.browserDownload'),
					onSelect: () =>
						run('saveAs', async () => {
							if (desktopAvailable) {
								try {
									const result = await runAction(coordinates, 'saveAs');
									if (result && result.ok === true) {
										return { status: { kind: 'ok', text: t('status.savedTo', { path: result.savedTo }) } };
									}
									if (result && result.reason === 'no-picker') {
										startDownload(coordinates);
										return { status: { kind: 'ok', text: t('status.savedBrowser') } };
									}
								} catch {
									startDownload(coordinates);
									return { status: { kind: 'ok', text: t('status.saveFallback') } };
								}
							}
							startDownload(coordinates);
							return { status: { kind: 'ok', text: t('status.savedBrowser') } };
						})
				});
				items.push({
					key: 'download',
					iconPath: ICONS.download,
					label: t('menu.download'),
					hint: formatBytes(knownFact('size')),
					onSelect: () =>
						run('download', async () => {
							startDownload(coordinates);
							return { status: { kind: 'ok', text: t('status.started') } };
						})
				});
				items.push({ key: 'sep-c', separator: true });
				items.push({
					key: 'copyLink',
					iconPath: ICONS.link,
					label: t('menu.copyLink'),
					onSelect: () =>
						run('copyLink', async () => {
							const copied = await copyText(rawUrl);
							return {
								keepOpen: true,
								status: copied ? { kind: 'ok', text: t('status.copiedLink') } : { kind: 'error', text: t('status.clipboardDenied') }
							};
						})
				});
				items.push({
					key: 'openLink',
					iconPath: ICONS.newTab,
					label: t('menu.openLink'),
					onSelect: () =>
						run('openLink', async () => {
							openInNewTab(rawUrl);
							return { status: { kind: 'ok', text: t('status.openedTab') } };
						})
				});
			}

			const rows = [];
			for (const item of items) {
				if (item.separator === true) {
					rows.push(h('div', { key: item.key, className: 'dfm-sep' }));
					continue;
				}
				rows.push(
					h(
						'button',
						{
							key: item.key,
							type: 'button',
							className: 'dfm-item',
							role: 'menuitem',
							disabled: item.disabled === true || busy !== null,
							title: item.label,
							onClick: item.onSelect
						},
						h('span', { className: 'dfm-ico' }, icon(item.iconPath)),
						h('span', { className: 'dfm-label' }, item.label),
						item.hint ? h('span', { className: 'dfm-hint' }, item.hint) : null
					)
				);
			}

			const headerName = knownFact('name');
			const headerPath = knownFact('path');
			const headerDirectory = knownFact('directory');
			const header =
				typeof headerName === 'string'
					? h(
							'div',
							{ className: 'dfm-head' },
							h(
								'div',
								{ className: 'dfm-headtext' },
								h('div', { className: 'dfm-name', title: headerPath }, headerName),
								h(
									'div',
									{ className: 'dfm-meta', title: headerPath },
									`${formatBytes(knownFact('size')) || t('note.sizeUnknown')} · ${headerDirectory ?? ''}`
								)
							)
						)
					: h(
							// Stand-in for the header, holding exactly its height. The menu is
							// already usable here, so nothing should shift when the real
							// name arrives a moment later.
							'div',
							{ className: 'dfm-head', 'aria-hidden': true },
							h(
								'div',
								{ className: 'dfm-headtext' },
								h('div', { className: 'dfm-bar dfm-bar-name' }),
								h('div', { className: 'dfm-bar dfm-bar-meta' })
							)
						);

			const desktopNotice =
				loaded && desktop !== undefined && desktop.available === false
					? h('div', { className: 'dfm-note' }, t('note.desktopUnavailable'))
					: null;

			const statusRow = status === null ? null : h('div', { className: 'dfm-note', 'data-kind': status.kind }, status.text);

			return h(
				'div',
				{ className: 'dfm-layer' },
				h('div', {
					className: 'dfm-scrim',
					onClick: closeMenu,
					onContextMenu: (event) => {
						event.preventDefault();
						closeMenu();
					}
				}),
				h(
					'div',
					{
						ref: menuRef,
						className: 'dfm-menu',
						role: 'menu',
						style: { left: `${placed.left}px`, top: `${placed.top}px` },
						onContextMenu: (event) => event.preventDefault()
					},
					header,
					desktopNotice,
					h('div', { className: 'dfm-scroll' }, rows),
					statusRow
				)
			);
		}

		const clientInject = ['slots', 'locale'];

		/**
		 * Browser half: register the dictionaries, bind right-clicks on delivery
		 * file cards, and render the menu in the frame-wide overlay.
		 */
		function apply(ctx) {
			ctx.effect(() => {
				const bound = ctx.locale.bind(NS);
				translate = (key) => bound(key);
				return () => {
					translate = (key) => key;
				};
			}, 'dsh-file-menu: translate');

			ctx.effect(() => ctx.locale.register(NS, dictionaries()), 'dsh-file-menu: dictionaries');

			ctx.effect(() => {
				const style = document.createElement('style');
				style.dataset.plugin = NS;
				style.dataset.pluginCss = NS;
				style.textContent = CSS;
				document.head.appendChild(style);
				return () => style.remove();
			}, 'dsh-file-menu: styles');

			// A right-click on any card carrying one of our triggers opens the menu.
			ctx.effect(() => {
				const onContextMenu = (event) => {
					if (event.defaultPrevented) return;
					const found = coordinatesAt(event.target);
					if (found === undefined) return;
					event.preventDefault();
					event.stopPropagation();
					openMenu(found, event.clientX, event.clientY);
				};
				const onKeyDown = (event) => {
					if (event.key === 'Escape') closeMenu();
				};
				const onPointerDown = (event) => {
					if (!snapshot.open) return;
					const node = event.target;
					if (node instanceof Element && (node.closest('.dfm-menu') !== null || node.closest('.dfm-trigger') !== null)) {
						return;
					}
					closeMenu();
				};
				const onReflow = () => closeMenu();
				document.addEventListener('contextmenu', onContextMenu, true);
				document.addEventListener('keydown', onKeyDown, true);
				document.addEventListener('pointerdown', onPointerDown, true);
				window.addEventListener('resize', onReflow);
				window.addEventListener('scroll', onReflow, true);
				return () => {
					document.removeEventListener('contextmenu', onContextMenu, true);
					document.removeEventListener('keydown', onKeyDown, true);
					document.removeEventListener('pointerdown', onPointerDown, true);
					window.removeEventListener('resize', onReflow);
					window.removeEventListener('scroll', onReflow, true);
				};
			}, 'dsh-file-menu: right-click binding');

			ctx.slots.inject('deliverables.file.actions', () =>
				ctx.slots.register(
					{ name: 'deliverables.file.actions', id: 'dsh-file-menu', order: 10, locale: NS },
					FileMenuTrigger
				)
			);

			ctx.slots.inject('shell.overlay', () =>
				ctx.slots.register({ name: 'shell.overlay', id: 'dsh-file-menu.menu', order: 60, locale: NS }, FileMenuLayer)
			);
		}

		return { name: 'dsh-file-menu', inject: clientInject, apply };
	}
});
