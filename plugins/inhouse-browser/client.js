/**
 * Client half of the In-house Browser bundle.
 *
 * Registers a full-size page in the Web UI:
 *   - `main` (keyed)            → the browser page itself
 *   - `sidebar.panellist` (list) → the sidebar icon that selects that panel
 *
 * The page is a plain-JS React surface. Styling uses only `--dsw-alias-*`
 * theme tokens so it follows light/dark and font-size settings, and all
 * visible text comes from the Client locale service.
 */
window.__ModuleLoader__.load({
  id: '@local/inhouse-browser',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const NS = 'inhouse-browser';
    const PANEL_ID = 'inhouse-browser';
    const STORAGE_KEY = 'dsh.inhouse-browser.v1';
    /** Framing-friendly metasearch endpoint; replaces the address bar text that is not a URL. */
    const SEARCH_URL = 'https://searx.be/search?q=';
    const MAX_TABS = 10;
    const MAX_HISTORY = 80;
    const MAX_BOOKMARKS = 24;
    const MAX_STACK = 60;
    const EMBED_TIMEOUT_MS = 4500;

    const QUICK_LINKS = [
      { label: 'Wikipedia', url: 'https://en.m.wikipedia.org' },
      { label: 'DeepSeek', url: 'https://www.deepseek.com' },
      { label: 'Internet Archive', url: 'https://archive.org' },
      { label: 'SearXNG', url: 'https://searx.be' },
      { label: 'Marginalia Search', url: 'https://search.marginalia.nu' },
      { label: 'Example', url: 'https://example.com' },
    ];

    const EN = {
      'panel.label': 'Browser',
      'tab.newTab': 'New tab',
      'tab.close': 'Close tab',
      'action.back': 'Back',
      'action.forward': 'Forward',
      'action.reload': 'Reload',
      'action.home': 'New tab',
      'action.bookmark': 'Bookmark this page',
      'action.removeBookmark': 'Remove bookmark',
      'action.history': 'History',
      'action.openExternal': 'Open in system browser',
      'action.go': 'Go',
      'address.placeholder': 'Search or enter an address',
      'hint.blocked':
        'This site may refuse to be embedded. Open it in your system browser instead.',
      'start.title': 'In-house Browser',
      'start.subtitle': 'Enter an address above, or pick a starting point.',
      'start.quick': 'Start here',
      'start.recent': 'Recently visited',
      'start.empty': 'Nothing visited yet.',
      'start.note':
        'Pages render in an embedded frame. Some sites send headers that forbid embedding — use the external-open button when a page stays blank.',
      'history.title': 'History',
      'history.clear': 'Clear',
      'history.empty': 'No history yet.',
    };

    /* ------------------------------------------------------------------ */
    /* URL handling                                                        */
    /* ------------------------------------------------------------------ */

    const URL_WITH_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
    const OPAQUE_SCHEME_RE = /^(javascript|data|file|blob|about|vbscript|mailto|tel|chrome|resource):/i;
    const HOSTISH_RE = /^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i;
    const LOCALISH_RE = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?([/?#].*)?$/i;

    /**
     * Turn address-bar text into a navigable http(s) URL.
     * Bare hosts get a scheme, anything else becomes a search.
     */
    function normalizeUrl(raw) {
      const text = String(raw == null ? '' : raw).trim();
      if (!text) return null;
      if (OPAQUE_SCHEME_RE.test(text)) return null; // not embeddable, and never executed here
      if (URL_WITH_SCHEME_RE.test(text)) {
        const url = safeUrl(text);
        if (url) return url;
        return text.includes(' ') ? safeUrl(SEARCH_URL + encodeURIComponent(text)) : null;
      }
      if (LOCALISH_RE.test(text)) return safeUrl('http://' + text);
      if (HOSTISH_RE.test(text) && !text.includes(' ')) return safeUrl('https://' + text);
      return safeUrl(SEARCH_URL + encodeURIComponent(text));
    }

    function safeUrl(candidate) {
      try {
        const parsed = new URL(candidate);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
      } catch {
        return null;
      }
    }

    function hostOf(url) {
      try {
        return new URL(url).host.replace(/^www\./, '');
      } catch {
        return url;
      }
    }

    function pathOf(url) {
      try {
        const parsed = new URL(url);
        const tail = parsed.pathname === '/' ? '' : parsed.pathname;
        return hostOf(url) + tail + parsed.search;
      } catch {
        return url;
      }
    }

    function monogram(text) {
      const cleaned = String(text || '?').replace(/^www\./, '');
      return cleaned.charAt(0).toUpperCase() || '?';
    }

    /* ------------------------------------------------------------------ */
    /* Local persistence                                                   */
    /* ------------------------------------------------------------------ */

    function newTab() {
      return { id: 'tab-' + Math.random().toString(36).slice(2, 9), stack: [], pos: -1 };
    }

    function isHttpUrl(value) {
      return typeof value === 'string' && /^https?:\/\//i.test(value);
    }

    function readTab(candidate) {
      if (!candidate || typeof candidate !== 'object') return null;
      if (typeof candidate.id !== 'string' || !candidate.id) return null;
      const stack = Array.isArray(candidate.stack) ? candidate.stack.filter(isHttpUrl).slice(-MAX_STACK) : [];
      const pos = Number.isInteger(candidate.pos)
        ? Math.max(-1, Math.min(candidate.pos, stack.length - 1))
        : stack.length - 1;
      return { id: candidate.id, stack, pos };
    }

    function loadState() {
      const fresh = newTab();
      const fallback = { tabs: [fresh], activeId: fresh.id, bookmarks: [], history: [] };
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return fallback;
        const data = JSON.parse(raw);
        const tabs = (Array.isArray(data && data.tabs) ? data.tabs : [])
          .map(readTab)
          .filter(Boolean)
          .slice(0, MAX_TABS);
        if (tabs.length === 0) return fallback;
        const activeId = tabs.some((tab) => tab.id === data.activeId) ? data.activeId : tabs[0].id;
        const bookmarks = (Array.isArray(data.bookmarks) ? data.bookmarks : [])
          .filter((item) => item && isHttpUrl(item.url))
          .map((item) => ({ url: item.url, label: String(item.label || hostOf(item.url)) }))
          .slice(0, MAX_BOOKMARKS);
        const history = (Array.isArray(data.history) ? data.history : [])
          .filter((item) => item && isHttpUrl(item.url))
          .map((item) => ({ url: item.url, at: Number(item.at) || Date.now() }))
          .slice(0, MAX_HISTORY);
        return { tabs, activeId, bookmarks, history };
      } catch {
        return fallback;
      }
    }

    function saveState(state) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        /* storage may be unavailable; the page still works for this session */
      }
    }

    /* ------------------------------------------------------------------ */
    /* Icons                                                               */
    /* ------------------------------------------------------------------ */

    function Icon({ children, size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        children,
      );
    }

    const IconBack = () => h(Icon, null, h('path', { d: 'M10 3.5 5.5 8 10 12.5' }));
    const IconForward = () => h(Icon, null, h('path', { d: 'M6 3.5 10.5 8 6 12.5' }));
    const IconReload = () =>
      h(Icon, null, h('path', { d: 'M13 8a5 5 0 1 1-1.7-3.75' }), h('path', { d: 'M13 2.6V5.4h-2.8' }));
    const IconStar = ({ filled }) =>
      h(
        Icon,
        null,
        h('path', {
          d: 'M8 2.4l1.72 3.5 3.86.56-2.79 2.72.66 3.84L8 11.22l-3.45 1.8.66-3.84L2.42 6.46l3.86-.56z',
          fill: filled ? 'currentColor' : 'none',
        }),
      );
    const IconHistory = () =>
      h(Icon, null, h('circle', { cx: 8, cy: 8, r: 5.3 }), h('path', { d: 'M8 4.8V8l2.2 1.4' }));
    const IconExternal = () =>
      h(
        Icon,
        null,
        h('path', { d: 'M9.6 2.6H13.4v3.8' }),
        h('path', { d: 'M13.4 2.6 7.6 8.4' }),
        h('path', { d: 'M11.8 9.6v2.9a.9.9 0 0 1-.9.9H3.5a.9.9 0 0 1-.9-.9V5a.9.9 0 0 1 .9-.9h2.9' }),
      );
    const IconPlus = () => h(Icon, null, h('path', { d: 'M8 3.5v9' }), h('path', { d: 'M3.5 8h9' }));
    const IconClose = ({ size = 12 }) =>
      h(Icon, { size }, h('path', { d: 'M4.6 4.6l6.8 6.8' }), h('path', { d: 'M11.4 4.6l-6.8 6.8' }));

    function PanelIcon({ size = 20, active = false }) {
      const stroke = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor';
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          stroke,
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('circle', { cx: 10, cy: 10, r: 7 }),
        h('ellipse', { cx: 10, cy: 10, rx: 3.1, ry: 7 }),
        h('path', { d: 'M3 10h14' }),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Styles (component-local, theme tokens only)                         */
    /* ------------------------------------------------------------------ */

    const CSS = `
.ib-root { display:flex; flex-direction:column; height:100%; min-height:0; width:100%;
  background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary);
  font-family:inherit; font-size:13px; box-sizing:border-box; }
.ib-root *, .ib-root *::before, .ib-root *::after { box-sizing:border-box; }

.ib-tabs { display:flex; align-items:flex-end; gap:2px; padding:8px 12px 0; overflow-x:auto;
  scrollbar-width:none; flex:none; }
.ib-tabs::-webkit-scrollbar { display:none; }
.ib-tab { display:flex; align-items:center; gap:6px; max-width:200px; min-width:118px;
  padding:6px 6px 6px 10px; border-radius:8px 8px 0 0; border:1px solid transparent;
  background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer;
  font:inherit; text-align:left; }
.ib-tab:hover { background:var(--dsw-alias-bg-layer-2); }
.ib-tab[data-active='true'] { background:var(--dsw-alias-bg-layer-1);
  border-color:var(--dsw-alias-border-l1); border-bottom-color:transparent;
  color:var(--dsw-alias-label-primary); }
.ib-tab-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap; font-size:12px; }
.ib-tab-close { display:inline-flex; align-items:center; justify-content:center; width:18px;
  height:18px; padding:0; border:none; border-radius:4px; background:transparent;
  color:inherit; opacity:.55; cursor:pointer; flex:none; }
.ib-tab-close:hover { opacity:1; background:var(--dsw-alias-bg-overlay); }
.ib-tab-add { display:inline-flex; align-items:center; justify-content:center; width:26px;
  height:26px; margin:0 0 2px 4px; padding:0; border:none; border-radius:6px;
  background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; flex:none; }
.ib-tab-add:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }

.ib-toolbar { position:relative; display:flex; align-items:center; gap:4px; padding:6px 12px;
  border-top:1px solid var(--dsw-alias-border-l1);
  border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1); flex:none; }
.ib-iconbtn { display:inline-flex; align-items:center; justify-content:center; width:28px;
  height:28px; padding:0; border:none; border-radius:6px; background:transparent;
  color:var(--dsw-alias-label-secondary); cursor:pointer; flex:none; }
.ib-iconbtn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary); }
.ib-iconbtn:disabled { opacity:.35; cursor:default; }
.ib-iconbtn[data-on='true'] { color:var(--dsw-alias-brand-primary); }
.ib-iconbtn:focus-visible, .ib-address:focus-visible, .ib-tab:focus-visible,
.ib-chip:focus-visible, .ib-quick:focus-visible, .ib-recent-row:focus-visible {
  outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.ib-address { flex:1; min-width:0; height:30px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary); padding:0 10px; font:inherit; font-size:13px;
  outline:none; }
.ib-address:focus { border-color:var(--dsw-alias-brand-primary); outline:none; }
.ib-address::placeholder { color:var(--dsw-alias-state-idle-primary); }

.ib-bookmarks { display:flex; align-items:center; gap:6px; padding:6px 12px;
  overflow-x:auto; scrollbar-width:none; border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1); flex:none; }
.ib-bookmarks::-webkit-scrollbar { display:none; }
.ib-chip { display:inline-flex; align-items:center; gap:6px; height:24px; max-width:190px;
  padding:0 6px 0 4px; border-radius:6px; border:1px solid transparent;
  background:transparent; color:var(--dsw-alias-label-secondary); font:inherit;
  font-size:12px; cursor:pointer; white-space:nowrap; flex:none; }
.ib-chip:hover { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.ib-mono { display:inline-flex; align-items:center; justify-content:center; width:16px;
  height:16px; border-radius:4px; background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary); font-size:9px; font-weight:600; flex:none; }
.ib-chip-label { overflow:hidden; text-overflow:ellipsis; }
.ib-chip-close { display:inline-flex; align-items:center; justify-content:center; width:16px;
  height:16px; padding:0; border:none; border-radius:3px; background:transparent;
  color:inherit; opacity:.55; cursor:pointer; flex:none; }
.ib-chip-close:hover { opacity:1; background:var(--dsw-alias-bg-overlay); }

.ib-content { position:relative; flex:1; min-height:360px; }
.ib-frame { display:block; width:100%; height:100%; border:0; background:#fff; }
.ib-hint { position:absolute; left:12px; right:12px; bottom:12px; display:flex;
  align-items:center; gap:10px; padding:8px 12px; border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-overlay);
  color:var(--dsw-alias-label-primary); font-size:12px; }
.ib-hint-text { flex:1; min-width:0; }

.ib-histpanel { position:absolute; top:calc(100% + 4px); right:12px; z-index:20;
  width:min(360px, calc(100% - 24px)); max-height:420px; overflow:auto; padding:6px;
  border-radius:10px; border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-overlay); }
.ib-histhead { display:flex; align-items:center; justify-content:space-between; gap:8px;
  padding:4px 6px 8px; }
.ib-histtitle { font-size:12px; font-weight:600; }
.ib-textbtn { padding:2px 6px; border:none; border-radius:4px; background:transparent;
  color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; cursor:pointer; }
.ib-textbtn:hover { background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary); }
.ib-histrow { display:flex; align-items:center; gap:8px; width:100%; padding:6px;
  border:none; border-radius:6px; background:transparent; color:var(--dsw-alias-label-primary);
  font:inherit; font-size:12px; text-align:left; cursor:pointer; }
.ib-histrow:hover { background:var(--dsw-alias-bg-layer-2); }
.ib-histrow-main { flex:1; min-width:0; }
.ib-histrow-url { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ib-histrow-time { color:var(--dsw-alias-label-secondary); font-size:11px; flex:none; }
.ib-empty { padding:10px 8px; color:var(--dsw-alias-label-secondary); font-size:12px; }

.ib-start { height:100%; overflow:auto; padding:44px 24px 32px; display:flex;
  justify-content:center; }
.ib-start-inner { width:100%; max-width:620px; }
.ib-start-title { margin:0 0 6px; font-size:22px; font-weight:600; letter-spacing:-0.01em; }
.ib-start-sub { margin:0; color:var(--dsw-alias-label-secondary); font-size:13px; }
.ib-section-title { margin:26px 0 8px; font-size:12px; font-weight:600;
  color:var(--dsw-alias-label-secondary); text-transform:uppercase; letter-spacing:.04em; }
.ib-quick-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(160px, 1fr));
  gap:8px; }
.ib-quick { display:flex; align-items:center; gap:10px; padding:10px; border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary); font:inherit; text-align:left; cursor:pointer; }
.ib-quick:hover { background:var(--dsw-alias-bg-layer-2);
  border-color:var(--dsw-alias-border-l2); }
.ib-quick-body { min-width:0; }
.ib-quick-name { font-size:12px; font-weight:600; }
.ib-quick-host { font-size:11px; color:var(--dsw-alias-label-secondary); overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.ib-recent { display:flex; flex-direction:column; gap:2px; }
.ib-recent-row { display:flex; align-items:center; gap:8px; padding:6px 8px; border:none;
  border-radius:6px; background:transparent; color:var(--dsw-alias-label-secondary);
  font:inherit; font-size:12px; text-align:left; cursor:pointer; }
.ib-recent-row:hover { background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary); }
.ib-start-note { margin:28px 0 0; padding-top:14px;
  border-top:1px solid var(--dsw-alias-border-l1);
  color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.5; }
`;

    /* ------------------------------------------------------------------ */
    /* Page                                                                */
    /* ------------------------------------------------------------------ */

    function BrowserPage(props) {
      const t = props && typeof props.t === 'function' ? props.t : null;
      const tr = useCallback(
        (key) => {
          const value = t ? t(key) : key;
          return value === key ? EN[key] || key : value;
        },
        [t],
      );

      const initial = useRef(null);
      if (initial.current === null) initial.current = loadState();

      const [tabs, setTabs] = useState(initial.current.tabs);
      const [activeId, setActiveId] = useState(initial.current.activeId);
      const [bookmarks, setBookmarks] = useState(initial.current.bookmarks);
      const [history, setHistory] = useState(initial.current.history);
      const [draft, setDraft] = useState('');
      const [nonce, setNonce] = useState(0);
      const [showHistory, setShowHistory] = useState(false);
      const [blocked, setBlocked] = useState(false);

      const addressRef = useRef(null);
      const historyPanelRef = useRef(null);
      const historyToggleRef = useRef(null);
      const loadedRef = useRef(false);

      const active = tabs.find((tab) => tab.id === activeId) || tabs[0];
      const currentUrl = active && active.pos >= 0 ? active.stack[active.pos] : null;
      const canBack = Boolean(active) && active.pos >= 0;
      const canForward = Boolean(active) && active.pos < active.stack.length - 1;
      const isBookmarked = Boolean(currentUrl) && bookmarks.some((item) => item.url === currentUrl);

      /* Keep the address bar in sync with whatever the tab is showing. */
      useEffect(() => {
        setDraft(currentUrl || '');
      }, [currentUrl]);

      /* Persist tabs, bookmarks, and history whenever they change. */
      useEffect(() => {
        saveState({ tabs, activeId, bookmarks, history });
      }, [tabs, activeId, bookmarks, history]);

      /* Flag frames that never finish loading (blocked or unreachable). */
      useEffect(() => {
        if (!currentUrl) {
          setBlocked(false);
          return undefined;
        }
        loadedRef.current = false;
        setBlocked(false);
        const timer = window.setTimeout(() => {
          if (!loadedRef.current) setBlocked(true);
        }, EMBED_TIMEOUT_MS);
        return () => window.clearTimeout(timer);
      }, [currentUrl, nonce]);

      /* Close the history popover on an outside click. */
      useEffect(() => {
        if (!showHistory) return undefined;
        const onPointerDown = (event) => {
          const panel = historyPanelRef.current;
          const toggle = historyToggleRef.current;
          const target = event.target;
          if (!(target instanceof Node)) return;
          if (panel && panel.contains(target)) return;
          if (toggle && toggle.contains(target)) return;
          setShowHistory(false);
        };
        document.addEventListener('mousedown', onPointerDown);
        return () => document.removeEventListener('mousedown', onPointerDown);
      }, [showHistory]);

      const navigate = useCallback(
        (raw) => {
          const url = normalizeUrl(raw);
          if (!url) return;
          setTabs((prev) =>
            prev.map((tab) => {
              if (tab.id !== activeId) return tab;
              const stack = tab.stack.slice(0, tab.pos + 1);
              if (stack[stack.length - 1] !== url) stack.push(url);
              const trimmed = stack.slice(-MAX_STACK);
              return { ...tab, stack: trimmed, pos: trimmed.length - 1 };
            }),
          );
          setHistory((prev) => [{ url, at: Date.now() }, ...prev.filter((item) => item.url !== url)].slice(0, MAX_HISTORY));
          setDraft(url);
          setShowHistory(false);
        },
        [activeId, setDraft],
      );

      const goBack = useCallback(() => {
        setTabs((prev) =>
          prev.map((tab) => (tab.id === activeId && tab.pos >= 0 ? { ...tab, pos: tab.pos - 1 } : tab)),
        );
      }, [activeId]);

      const goForward = useCallback(() => {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === activeId && tab.pos < tab.stack.length - 1 ? { ...tab, pos: tab.pos + 1 } : tab,
          ),
        );
      }, [activeId]);

      const reload = useCallback(() => {
        loadedRef.current = false;
        setNonce((value) => value + 1);
      }, []);

      const openTab = useCallback(
        (raw) => {
          const url = normalizeUrl(raw);
          const tab = newTab();
          if (url) {
            tab.stack = [url];
            tab.pos = 0;
          }
          setTabs((prev) => [...prev.slice(-(MAX_TABS - 1)), tab]);
          setActiveId(tab.id);
          setDraft(url || '');
          if (url) {
            setHistory((prev) => [{ url, at: Date.now() }, ...prev.filter((item) => item.url !== url)].slice(0, MAX_HISTORY));
          }
        },
        [],
      );

      const closeTab = useCallback(
        (tabId) => {
          const index = tabs.findIndex((tab) => tab.id === tabId);
          const next = tabs.filter((tab) => tab.id !== tabId);
          if (next.length === 0) {
            const fresh = newTab();
            setTabs([fresh]);
            setActiveId(fresh.id);
            return;
          }
          setTabs(next);
          if (tabId === activeId) setActiveId(next[Math.max(0, index - 1)].id);
        },
        [activeId, tabs],
      );

      const toggleBookmark = useCallback(() => {
        if (!currentUrl) return;
        setBookmarks((prev) => {
          if (prev.some((item) => item.url === currentUrl)) {
            return prev.filter((item) => item.url !== currentUrl);
          }
          return [{ url: currentUrl, label: hostOf(currentUrl) }, ...prev].slice(0, MAX_BOOKMARKS);
        });
      }, [currentUrl]);

      const openExternal = useCallback(
        (url) => {
          const target = url || currentUrl;
          if (!target) return;
          window.open(target, '_blank', 'noopener,noreferrer');
        },
        [currentUrl],
      );

      const focusAddress = useCallback(() => {
        const input = addressRef.current;
        if (!input) return;
        input.focus();
        input.select();
      }, []);

      const onRootKeyDown = useCallback(
        (event) => {
          const key = event.key.toLowerCase();
          const mod = event.ctrlKey || event.metaKey;
          if (mod && key === 'l') {
            event.preventDefault();
            focusAddress();
          } else if (mod && key === 't') {
            event.preventDefault();
            openTab();
          } else if (mod && key === 'w') {
            event.preventDefault();
            closeTab(activeId);
          }
        },
        [activeId, closeTab, focusAddress, openTab],
      );

      const frameKey = (active ? active.id : 'none') + ':' + nonce;

      return h(
        'div',
        { className: 'ib-root', onKeyDown: onRootKeyDown },
        h('style', null, CSS),

        /* Tab strip */
        h(
          'div',
          { className: 'ib-tabs', role: 'tablist', 'aria-label': tr('panel.label') },
          tabs.map((tab) => {
            const url = tab.pos >= 0 ? tab.stack[tab.pos] : null;
            const isActive = tab.id === activeId;
            return h(
              'div',
              {
                key: tab.id,
                className: 'ib-tab',
                'data-active': isActive ? 'true' : 'false',
                role: 'tab',
                'aria-selected': isActive ? 'true' : 'false',
                tabIndex: isActive ? 0 : -1,
                title: url || tr('tab.newTab'),
                onClick: () => setActiveId(tab.id),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setActiveId(tab.id);
                  }
                },
              },
              h('span', { className: 'ib-tab-title' }, url ? hostOf(url) : tr('tab.newTab')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ib-tab-close',
                  'aria-label': tr('tab.close'),
                  title: tr('tab.close'),
                  onClick: (event) => {
                    event.stopPropagation();
                    closeTab(tab.id);
                  },
                },
                h(IconClose, null),
              ),
            );
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'ib-tab-add',
              'aria-label': tr('action.home'),
              title: tr('action.home'),
              onClick: () => openTab(),
            },
            h(IconPlus, null),
          ),
        ),

        /* Toolbar */
        h(
          'div',
          { className: 'ib-toolbar' },
          h(
            'button',
            {
              type: 'button',
              className: 'ib-iconbtn',
              'aria-label': tr('action.back'),
              title: tr('action.back'),
              disabled: !canBack,
              onClick: goBack,
            },
            h(IconBack, null),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ib-iconbtn',
              'aria-label': tr('action.forward'),
              title: tr('action.forward'),
              disabled: !canForward,
              onClick: goForward,
            },
            h(IconForward, null),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ib-iconbtn',
              'aria-label': tr('action.reload'),
              title: tr('action.reload'),
              disabled: !currentUrl,
              onClick: reload,
            },
            h(IconReload, null),
          ),
          h('input', {
            ref: addressRef,
            className: 'ib-address',
            type: 'text',
            spellCheck: false,
            autoComplete: 'off',
            placeholder: tr('address.placeholder'),
            'aria-label': tr('address.placeholder'),
            value: draft,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                navigate(draft);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setDraft(currentUrl || '');
                event.currentTarget.blur();
              }
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'ib-iconbtn',
              'aria-label': isBookmarked ? tr('action.removeBookmark') : tr('action.bookmark'),
              title: isBookmarked ? tr('action.removeBookmark') : tr('action.bookmark'),
              'data-on': isBookmarked ? 'true' : 'false',
              disabled: !currentUrl,
              onClick: toggleBookmark,
            },
            h(IconStar, { filled: isBookmarked }),
          ),
          h(
            'button',
            {
              type: 'button',
              ref: historyToggleRef,
              className: 'ib-iconbtn',
              'aria-label': tr('action.history'),
              title: tr('action.history'),
              'data-on': showHistory ? 'true' : 'false',
              onClick: () => setShowHistory((value) => !value),
            },
            h(IconHistory, null),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ib-iconbtn',
              'aria-label': tr('action.openExternal'),
              title: tr('action.openExternal'),
              disabled: !currentUrl,
              onClick: () => openExternal(),
            },
            h(IconExternal, null),
          ),
          showHistory
            ? h(
                'div',
                { className: 'ib-histpanel', ref: historyPanelRef, role: 'dialog', 'aria-label': tr('history.title') },
                h(
                  'div',
                  { className: 'ib-histhead' },
                  h('span', { className: 'ib-histtitle' }, tr('history.title')),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ib-textbtn',
                      onClick: () => setHistory([]),
                    },
                    tr('history.clear'),
                  ),
                ),
                history.length === 0
                  ? h('div', { className: 'ib-empty' }, tr('history.empty'))
                  : history.slice(0, 40).map((item) =>
                      h(
                        'button',
                        {
                          key: item.url + ':' + item.at,
                          type: 'button',
                          className: 'ib-histrow',
                          title: item.url,
                          onClick: () => navigate(item.url),
                        },
                        h('span', { className: 'ib-mono' }, monogram(hostOf(item.url))),
                        h(
                          'span',
                          { className: 'ib-histrow-main' },
                          h('span', { className: 'ib-histrow-url' }, pathOf(item.url)),
                        ),
                        h(
                          'span',
                          { className: 'ib-histrow-time' },
                          new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                        ),
                      ),
                    ),
              )
            : null,
        ),

        /* Bookmark chips */
        bookmarks.length > 0
          ? h(
              'div',
              { className: 'ib-bookmarks' },
              bookmarks.map((item) =>
                h(
                  'div',
                  { key: item.url, className: 'ib-chip' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ib-chip',
                      style: { padding: 0, maxWidth: 'none' },
                      title: item.url,
                      onClick: () => navigate(item.url),
                    },
                    h('span', { className: 'ib-mono' }, monogram(item.label)),
                    h('span', { className: 'ib-chip-label' }, item.label),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ib-chip-close',
                      'aria-label': tr('action.removeBookmark'),
                      title: tr('action.removeBookmark'),
                      onClick: () => setBookmarks((prev) => prev.filter((entry) => entry.url !== item.url)),
                    },
                    h(IconClose, { size: 10 }),
                  ),
                ),
              ),
            )
          : null,

        /* Content */
        h(
          'div',
          { className: 'ib-content' },
          currentUrl
            ? h('iframe', {
                key: frameKey,
                className: 'ib-frame',
                src: currentUrl,
                title: hostOf(currentUrl),
                referrerPolicy: 'no-referrer',
                allowFullScreen: true,
                onLoad: () => {
                  loadedRef.current = true;
                  setBlocked(false);
                },
              })
            : h(StartPage, {
                t: tr,
                history,
                onNavigate: navigate,
                onOpenTab: openTab,
              }),
          blocked && currentUrl
            ? h(
                'div',
                { className: 'ib-hint', role: 'status' },
                h('span', { className: 'ib-hint-text' }, tr('hint.blocked')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ib-textbtn',
                    onClick: () => openExternal(),
                  },
                  tr('action.openExternal'),
                ),
              )
            : null,
        ),
      );
    }

    function StartPage({ t, history, onNavigate, onOpenTab }) {
      return h(
        'div',
        { className: 'ib-start' },
        h(
          'div',
          { className: 'ib-start-inner' },
          h('h1', { className: 'ib-start-title' }, t('start.title')),
          h('p', { className: 'ib-start-sub' }, t('start.subtitle')),

          h('div', { className: 'ib-section-title' }, t('start.quick')),
          h(
            'div',
            { className: 'ib-quick-grid' },
            QUICK_LINKS.map((link) =>
              h(
                'button',
                {
                  key: link.url,
                  type: 'button',
                  className: 'ib-quick',
                  title: link.url,
                  onClick: () => onNavigate(link.url),
                },
                h('span', { className: 'ib-mono' }, monogram(hostOf(link.url))),
                h(
                  'span',
                  { className: 'ib-quick-body' },
                  h('span', { className: 'ib-quick-name', style: { display: 'block' } }, link.label),
                  h('span', { className: 'ib-quick-host', style: { display: 'block' } }, hostOf(link.url)),
                ),
              ),
            ),
          ),

          h('div', { className: 'ib-section-title' }, t('start.recent')),
          history.length === 0
            ? h('div', { className: 'ib-empty' }, t('start.empty'))
            : h(
                'div',
                { className: 'ib-recent' },
                history.slice(0, 6).map((item) =>
                  h(
                    'button',
                    {
                      key: item.url + ':' + item.at,
                      type: 'button',
                      className: 'ib-recent-row',
                      title: item.url,
                      onClick: () => onNavigate(item.url),
                    },
                    h('span', { className: 'ib-mono' }, monogram(hostOf(item.url))),
                    h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, pathOf(item.url)),
                  ),
                ),
              ),

          h('p', { className: 'ib-start-note' }, t('start.note')),
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        /* English dictionary with every other locale falling back through it. */
        ctx.effect(() => ctx.locale.register(NS, 'en', EN));

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, BrowserPage),
        );

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: () => ctx.locale.bind(NS)('panel.label'),
              locale: NS,
            },
            PanelIcon,
          ),
        );
      },
    };
  },
});
