/**
 * Client half of the Harness Rail bundle.
 *
 * Registers, through the Web UI slot renderer:
 *   - `main` (keyed x4)             → Search, Sessions, Customize, Activity pages
 *   - `sidebar.panellist` (list x4) → the left-rail icon rows that select them
 *   - `shell.bottom` (single)       → the terminal-style status strip
 *
 * Plain-JS React surface: no JSX, no imports, no fetch of package files. All
 * styling lives in one `data-plugin` <style> tag and reads the theme's semantic
 * tokens, so the surfaces follow light/dark and font settings.
 *
 * Data comes from public Client services and the framework standard kit the
 * renderer hands to every slot component (`useSessions`, `useWorkspaces`); DOM
 * access is limited to documented fallback triggers (see NOTES.md).
 */
window.__ModuleLoader__.load({
  id: '@local/harness-rail',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useEffect = React.useEffect;
    const useState = React.useState;

    /* ------------------------------------------------------------------ */
    /* Identity and constants                                              */
    /* ------------------------------------------------------------------ */

    const PACKAGE_ID = '@local/harness-rail';
    const PANEL_ID = {
      search: 'hr-search',
      sessions: 'hr-sessions',
      customize: 'hr-customize',
      activity: 'hr-activity',
    };
    /** Rail row order: append after the shipped panels (0, 10, 20). */
    const RAIL_ORDER = { search: 30, sessions: 40, customize: 50, activity: 60 };
    const SEARCH_RESULT_LIMIT = 40;
    const RECENT_LIMIT = 6;
    const DAY_MS = 86400000;
    const NOW_TICK_MS = 30000;
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    /** Stable selector: the shared session list snapshot. */
    const selectSnapshot = (state) => state;

    /** Settings trigger accessible labels across the locales this build ships. */
    const SETTINGS_TRIGGER_LABELS = ['Settings', '设置', '設定', 'Paramètres', 'Einstellungen', 'Настройки', 'Configurações', 'Configuración'];
    /** Settings navigation labels, keyed by settings section id. */
    const SETTINGS_SECTION_LABELS = {
      general: ['General', '通用设置', '一般', 'Général', 'Allgemein', 'Общие', 'Geral'],
      models: ['Models', '模型', 'モデル', 'Modèles', 'Modelle', 'Модели', 'Modelos'],
    };
    /** Sidebar "new session" accessible labels across the shipped locales. */
    const NEW_SESSION_LABELS = ['New session', 'New Session', '新建会话', '新会话', '新規セッション', 'Nouvelle session', 'Neue Sitzung', 'Новая сессия', 'Nova sessão', 'Nueva sesión'];
    /** Sidebar panel accessible labels for the plugin manager fallback. */
    const PLUGINS_LABELS = ['Plugins', '插件', 'プラグイン', 'Extensions', 'Erweiterungen', 'Расширения', 'Complementos', 'Plugins intégrés'];
    /** Shortcut command that opens the settings modal. */
    const SETTINGS_SHORTCUT_ID = 'settings.open';
    /** Physical event.code → the key value a synthetic KeyboardEvent should carry. */
    const KEY_LABELS = {
      Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`',
      Minus: '-', Equal: '=', Space: ' ', Enter: 'Enter', Escape: 'Escape', Tab: 'Tab',
    };

    /* ------------------------------------------------------------------ */
    /* Pure formatting helpers                                             */
    /* ------------------------------------------------------------------ */

    /** Finite positive number, else 0. */
    function numeric(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
    }

    /** Local midnight of one epoch-ms timestamp. */
    function startOfDay(stamp) {
      const date = new Date(stamp);
      date.setHours(0, 0, 0, 0);
      return date.getTime();
    }

    /** Compact relative timestamp: now / 5m / 2h ago / Yesterday / Mar 3. */
    function timeAgo(stamp, now) {
      const value = typeof stamp === 'number' && Number.isFinite(stamp) ? stamp : 0;
      if (value <= 0) return '';
      const current = typeof now === 'number' ? now : Date.now();
      const delta = Math.max(0, current - value);
      if (delta < 60e3) return 'now';
      if (delta < 3600e3) return Math.max(1, Math.floor(delta / 60e3)) + 'm ago';
      const today = startOfDay(current);
      if (value >= today) return Math.floor(delta / 3600e3) + 'h ago';
      if (value >= today - DAY_MS) return 'Yesterday';
      if (value >= today - 6 * DAY_MS) return Math.floor(delta / DAY_MS) + 'd ago';
      const date = new Date(value);
      return MONTHS[date.getMonth()] + ' ' + String(date.getDate());
    }

    /** 0 / 942 / 12.4k / 3.1M. */
    function formatTokens(value) {
      const count = numeric(value);
      if (count < 1000) return String(Math.round(count));
      if (count < 1e6) {
        const scaled = count / 1000;
        return (scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, '')) + 'k';
      }
      const scaled = count / 1e6;
      return (scaled >= 10 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, '')) + 'M';
    }

    /** 0 B / 812 B / 4.2 KiB / 1.4 MiB. */
    function formatBytes(value) {
      const count = numeric(value);
      if (count < 1024) return String(Math.round(count)) + ' B';
      if (count < 1048576) {
        const scaled = count / 1024;
        return (scaled >= 10 ? String(Math.round(scaled)) : scaled.toFixed(1)) + ' KiB';
      }
      return (count / 1048576).toFixed(1) + ' MiB';
    }

    /** 0..1 ratio as an integer percentage, or an em dash when absent. */
    function formatPercent(ratio) {
      if (ratio === null || ratio === undefined) return '—';
      return String(Math.round(ratio * 100)) + '%';
    }

    /** Session title as the list projects it. */
    function sessionTitle(row) {
      if (!row) return '';
      if (typeof row.displayTitle === 'string' && row.displayTitle !== '') return row.displayTitle;
      if (typeof row.title === 'string' && row.title !== '') return row.title;
      return String(row.id === undefined ? '' : row.id);
    }

    /** Trailing path segment of the session working directory. */
    function projectOf(row) {
      const cwd = row && typeof row.cwd === 'string' ? row.cwd : '';
      if (cwd === '') return '';
      const parts = cwd.split(/[\\/]+/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : cwd;
    }

    /** Workspace title that accounts for this session, when any. */
    function workspaceTitleOf(row, workspaces) {
      if (!row || !workspaces || !Array.isArray(workspaces.items)) return '';
      for (let i = 0; i < workspaces.items.length; i += 1) {
        const item = workspaces.items[i];
        if (!item || !Array.isArray(item.sessionIds)) continue;
        if (item.sessionIds.indexOf(row.id) >= 0 && typeof item.title === 'string' && item.title !== '') return item.title;
      }
      return '';
    }

    /** Title of the most recently touched workspace, used before a session is selected. */
    function firstWorkspaceTitle(workspaces) {
      if (!workspaces || !Array.isArray(workspaces.items) || workspaces.items.length === 0) return '';
      let best = null;
      let bestStamp = -1;
      for (let i = 0; i < workspaces.items.length; i += 1) {
        const item = workspaces.items[i];
        if (!item) continue;
        const stamp = Date.parse(item.updatedAt || item.createdAt || '') || 0;
        if (stamp > bestStamp) {
          best = item;
          bestStamp = stamp;
        }
      }
      return best && typeof best.title === 'string' ? best.title : '';
    }

    /** The row the main Conversation currently retains. */
    function currentSummary(list) {
      if (!list || !Array.isArray(list.ids) || !list.byId) return undefined;
      for (let i = 0; i < list.ids.length; i += 1) {
        const row = list.byId[list.ids[i]];
        if (row && row.retainedBy && numeric(row.retainedBy.mainView) > 0) return row;
      }
      return undefined;
    }

    /** Current session identity, if a Conversation is selected. */
    function currentSessionId(list) {
      const row = currentSummary(list);
      return row ? row.id : undefined;
    }

    /** Non-archived catalog rows, most recent first. */
    function sessionRows(list, workspaces) {
      if (!list || !Array.isArray(list.ids) || !list.byId) return [];
      const archived = workspaces && Array.isArray(workspaces.archivedSessionIds) ? workspaces.archivedSessionIds : [];
      const rows = [];
      for (let i = 0; i < list.ids.length; i += 1) {
        const id = list.ids[i];
        const row = list.byId[id];
        if (!row) continue;
        if (archived.indexOf(id) >= 0) continue;
        rows.push(row);
      }
      rows.sort((left, right) => numeric(right.updatedAt) - numeric(left.updatedAt));
      return rows;
    }

    /** Today / Yesterday / Earlier groups over an already recent-first list. */
    function groupSessions(rows, now) {
      const today = startOfDay(typeof now === 'number' ? now : Date.now());
      const yesterday = today - DAY_MS;
      const groups = [
        { key: 'today', label: 'Today', items: [] },
        { key: 'yesterday', label: 'Yesterday', items: [] },
        { key: 'earlier', label: 'Earlier', items: [] },
      ];
      for (let i = 0; i < rows.length; i += 1) {
        const stamp = numeric(rows[i].updatedAt);
        const target = stamp >= today ? groups[0] : stamp >= yesterday ? groups[1] : groups[2];
        target.items.push(rows[i]);
      }
      return groups.filter(group => group.items.length > 0);
    }

    /** Case-insensitive catalog filter over title, project path, and id. */
    function sessionMatches(row, query) {
      const needle = String(query || '').trim().toLowerCase();
      if (needle === '') return true;
      const fields = [sessionTitle(row), String(row.id || ''), String(row.cwd || ''), String(row.title || '')];
      for (let i = 0; i < fields.length; i += 1) {
        if (fields[i].toLowerCase().indexOf(needle) >= 0) return true;
      }
      return false;
    }

    /** Split a title around the query match so the hit can carry a mint mark. */
    function highlighted(text, query) {
      const raw = String(text === undefined || text === null ? '' : text);
      const needle = String(query || '').trim();
      if (needle === '') return raw;
      const at = raw.toLowerCase().indexOf(needle.toLowerCase());
      if (at < 0) return raw;
      return [
        raw.slice(0, at),
        h('mark', { key: 'hit', className: 'hr-mark' }, raw.slice(at, at + needle.length)),
        raw.slice(at + needle.length),
      ];
    }

    /** Model id recorded for the session's next model step, or its last request. */
    function modelLabel(projections) {
      const selection = projections && projections.modelSelection ? projections.modelSelection : null;
      const active = selection ? (selection.next || selection.lastUsed) : null;
      return active && typeof active.model === 'string' ? active.model : '';
    }

    /** Provider id paired with the model label. */
    function providerLabel(projections) {
      const selection = projections && projections.modelSelection ? projections.modelSelection : null;
      const active = selection ? (selection.next || selection.lastUsed) : null;
      return active && typeof active.provider === 'string' ? active.provider : '';
    }

    /** Token buckets and the cache-hit share of prompt-side tokens. */
    function usageStats(projections) {
      const usage = projections && projections.tokenUsage ? projections.tokenUsage : null;
      const uncached = numeric(usage && usage.uncachedInputTokens);
      const cacheRead = numeric(usage && usage.cacheReadTokens);
      const cacheWrite = numeric(usage && usage.cacheWriteTokens);
      const output = numeric(usage && usage.outputTokens);
      const input = uncached + cacheRead + cacheWrite;
      return {
        input,
        output,
        cacheRead,
        cacheWrite,
        cacheHit: input > 0 ? cacheRead / input : null,
      };
    }

    /** Occupancy of the newest request against the newest known context window. */
    function contextStats(projections) {
      const pressure = projections && projections.contextPressure ? projections.contextPressure : null;
      const projected = numeric(pressure && pressure.projectedTokens);
      const sampled = numeric(pressure && pressure.pressureTokens);
      const used = projected > 0 ? projected : sampled;
      const window = numeric(pressure && pressure.contextWindow);
      if (used <= 0 || window <= 0) return { used: 0, window: 0, ratio: null };
      return { used, window, ratio: Math.min(1, used / window) };
    }

    /** Theme currently applied to the document, as the shell reports it in the DOM. */
    function themeName() {
      try {
        if (typeof document === 'undefined' || !document.body || typeof document.body.hasAttribute !== 'function') return 'Appearance';
        return document.body.hasAttribute('data-ds-dark-theme') ? 'Dark theme' : 'Light theme';
      } catch (error) {
        return 'Appearance';
      }
    }

    /* ------------------------------------------------------------------ */
    /* Data hooks                                                          */
    /* ------------------------------------------------------------------ */

    /** Ticking clock for relative labels; survives long-lived panels. */
    function useNow(intervalMs) {
      const [now, setNow] = useState(() => Date.now());
      useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
        return () => window.clearInterval(timer);
      }, [intervalMs]);
      return now;
    }

    /** Subscribe a component to a framework host-observable snapshot source. */
    function useObservable(source) {
      const [snapshot, setSnapshot] = useState(() => (source && typeof source.getSnapshot === 'function' ? source.getSnapshot() : null));
      useEffect(() => {
        if (!source || typeof source.getSnapshot !== 'function') {
          setSnapshot(null);
          return undefined;
        }
        setSnapshot(source.getSnapshot());
        const unsubscribe = typeof source.subscribe === 'function' ? source.subscribe(() => setSnapshot(source.getSnapshot())) : null;
        return () => {
          if (typeof unsubscribe === 'function') unsubscribe();
        };
      }, [source]);
      return snapshot;
    }

    /* ------------------------------------------------------------------ */
    /* Service and DOM bridges (documented fallbacks live here)            */
    /* ------------------------------------------------------------------ */

    /** Resolve a Client service without declaring a hard injection dependency. */
    function serviceOf(ctx, name) {
      if (!ctx) return null;
      try {
        if (typeof ctx.get === 'function') {
          const found = ctx.get(name);
          if (found !== undefined && found !== null) return found;
        }
      } catch (error) {
        /* Service not composed in this client; fall through to direct access. */
      }
      try {
        const direct = ctx[name];
        return direct === undefined ? null : direct;
      } catch (error) {
        return null;
      }
    }

    /** Buttons whose aria-label equals / contains one of the candidate labels. */
    function findButtonByLabels(labels, root) {
      const scope = root || (typeof document === 'undefined' ? null : document);
      if (!scope || typeof scope.querySelectorAll !== 'function') return null;
      const wanted = labels.map(label => String(label).toLowerCase());
      const buttons = scope.querySelectorAll('button[aria-label]');
      let partial = null;
      for (let i = 0; i < buttons.length; i += 1) {
        const element = buttons[i];
        const label = String(element.getAttribute('aria-label') || '').trim().toLowerCase();
        if (label === '') continue;
        for (let j = 0; j < wanted.length; j += 1) {
          if (label === wanted[j]) return element;
          if (partial === null && label.indexOf(wanted[j]) >= 0) partial = element;
        }
      }
      return partial;
    }

    /** Buttons whose visible text equals / contains one of the candidate labels. */
    function findButtonByText(labels, root) {
      if (!root || typeof root.querySelectorAll !== 'function') return null;
      const wanted = labels.map(label => String(label).toLowerCase());
      const buttons = root.querySelectorAll('button');
      let partial = null;
      for (let i = 0; i < buttons.length; i += 1) {
        const text = String(buttons[i].textContent || '').trim().toLowerCase();
        if (text === '') continue;
        for (let j = 0; j < wanted.length; j += 1) {
          if (text === wanted[j]) return buttons[i];
          if (partial === null && text.indexOf(wanted[j]) >= 0) partial = buttons[i];
        }
      }
      return partial;
    }

    /** Click the first button matching any candidate label. */
    function clickButtonByLabels(labels, root) {
      const element = findButtonByLabels(labels, root);
      if (element === null) return false;
      try {
        element.click();
        return true;
      } catch (error) {
        return false;
      }
    }

    /**
     * DOM fallback for opening a session: the sidebar session row carries a
     * stable `data-row-key="session:<id>"` attribute (ui-workspace Rows.tsx).
     * Requires an expanded sidebar; the rail has no session list at all.
     */
    function clickSessionRow(sessionId) {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return false;
      const escaped = String(sessionId).replace(/["\\]/g, '\\$&');
      let row = null;
      try {
        row = document.querySelector('[data-row-key="session:' + escaped + '"]');
      } catch (error) {
        row = null;
      }
      if (!row) return false;
      try {
        row.click();
        return true;
      } catch (error) {
        return false;
      }
    }

    /** The settings modal when it is mounted (portalled beside #root). */
    function settingsDialogElement() {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
      try {
        return document.querySelector('[data-shortcut-modal="settings"]');
      } catch (error) {
        return null;
      }
    }

    /** Click one settings navigation cell by its visible, localized label. */
    function selectSettingsSection(sectionId) {
      const labels = SETTINGS_SECTION_LABELS[sectionId];
      if (!labels) return false;
      const dialog = settingsDialogElement();
      if (!dialog) return false;
      const nav = dialog.querySelector('nav');
      const button = findButtonByText(labels, nav || dialog);
      if (button === null) return false;
      try {
        button.click();
        return true;
      } catch (error) {
        return false;
      }
    }

    /**
     * Open the settings modal by dispatching the shell's own `settings.open`
     * shortcut command: its binding is read from the public shortcut catalog and
     * replayed as a synthetic keydown (no trusted-input check in the keyboard
     * adapter), which is locale independent. Falls back to clicking the labelled
     * sidebar trigger.
     */
    function dispatchSettingsShortcut(ctx) {
      const shortcuts = serviceOf(ctx, 'shortcuts');
      if (!shortcuts || !shortcuts.catalog || typeof shortcuts.catalog.getSnapshot !== 'function') return false;
      let binding = null;
      try {
        const rows = shortcuts.catalog.getSnapshot();
        if (Array.isArray(rows)) {
          for (let i = 0; i < rows.length; i += 1) {
            if (rows[i] && rows[i].id === SETTINGS_SHORTCUT_ID && rows[i].binding) {
              binding = rows[i].binding;
              break;
            }
          }
        }
      } catch (error) {
        return false;
      }
      if (!binding || typeof binding.code !== 'string') return false;
      const modifiers = Array.isArray(binding.modifiers) ? binding.modifiers : [];
      const code = binding.code;
      const key = KEY_LABELS[code] || (code.indexOf('Key') === 0 ? code.slice(3).toLowerCase() : code);
      if (typeof KeyboardEvent !== 'function' || typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return false;
      try {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key,
          code,
          bubbles: true,
          cancelable: true,
          ctrlKey: modifiers.indexOf('control') >= 0,
          altKey: modifiers.indexOf('alt') >= 0,
          shiftKey: modifiers.indexOf('shift') >= 0,
          metaKey: modifiers.indexOf('meta') >= 0,
        }));
        return true;
      } catch (error) {
        return false;
      }
    }

    /** Open settings (optionally on one section) through shortcut + labelled fallback. */
    function openSettingsDialog(ctx, sectionId) {
      if (settingsDialogElement()) {
        if (sectionId) selectSettingsSection(sectionId);
        return 'already-open';
      }
      dispatchSettingsShortcut(ctx);
      let attempts = 0;
      const tick = () => {
        attempts += 1;
        if (settingsDialogElement()) {
          if (sectionId) selectSettingsSection(sectionId);
          return;
        }
        if (attempts === 2) clickButtonByLabels(SETTINGS_TRIGGER_LABELS);
        if (attempts < 8 && typeof window !== 'undefined') window.setTimeout(tick, 90);
      };
      if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') window.setTimeout(tick, 90);
      return 'opening';
    }

    /** Build the action/environment object the panels close over. */
    function createEnvironment(ctx) {
      const cached = Object.create(null);
      const service = (name) => {
        if (cached[name] !== undefined) return cached[name];
        const found = serviceOf(ctx, name);
        if (found !== null) cached[name] = found;
        return found;
      };
      const openSession = (sessionId) => {
        const id = sessionId === undefined || sessionId === null ? '' : String(sessionId);
        if (id === '') return 'none';
        const uiWorkspace = service('uiWorkspace');
        if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
          try {
            uiWorkspace.openSession(id);
            return 'service';
          } catch (error) {
            console.warn('[harness-rail] uiWorkspace.openSession failed:', error);
          }
        }
        return clickSessionRow(id) ? 'dom' : 'none';
      };
      const startSession = () => {
        const uiWorkspace = service('uiWorkspace');
        if (uiWorkspace && typeof uiWorkspace.startSession === 'function') {
          try {
            uiWorkspace.startSession();
            return true;
          } catch (error) {
            console.warn('[harness-rail] uiWorkspace.startSession failed:', error);
          }
        }
        return clickButtonByLabels(NEW_SESSION_LABELS);
      };
      const selectPanel = (panelId) => {
        const layout = service('layout');
        if (!layout || typeof layout.selectPanel !== 'function') return false;
        try {
          layout.selectPanel(panelId);
          return true;
        } catch (error) {
          console.warn('[harness-rail] layout.selectPanel(' + panelId + ') failed:', error);
          return false;
        }
      };
      const openPlugins = () => {
        if (selectPanel('plugins')) return true;
        return clickButtonByLabels(PLUGINS_LABELS);
      };
      const openSettings = (sectionId) => {
        const target = sectionId && SETTINGS_SECTION_LABELS[sectionId] ? sectionId : null;
        return openSettingsDialog(ctx, target);
      };
      const jobsService = () => service('jobs');
      return { openSession, startSession, selectPanel, openPlugins, openSettings, jobsService };
    }

    /* ------------------------------------------------------------------ */
    /* Icons (16-20px, currentColor; the rail passes { size, active })     */
    /* ------------------------------------------------------------------ */

    function IconBase(props) {
      return h('svg', {
        width: props.size,
        height: props.size,
        viewBox: '0 0 20 20',
        fill: 'none',
        stroke: props.active === true ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
        className: props.className,
      }, props.children);
    }

    function iconProps(props) {
      const source = props || {};
      return { size: typeof source.size === 'number' ? source.size : 18, active: source.active === true };
    }

    function SearchIcon(props) {
      const own = iconProps(props);
      return h(IconBase, { size: own.size, active: own.active },
        h('circle', { cx: 8.6, cy: 8.6, r: 5.1 }),
        h('path', { d: 'M12.4 12.4 17 17' }));
    }

    function SessionsIcon(props) {
      const own = iconProps(props);
      return h(IconBase, { size: own.size, active: own.active },
        h('rect', { x: 2.8, y: 3.2, width: 14.4, height: 13.6, rx: 3 }),
        h('path', { d: 'M5.6 7.4h5.2' }),
        h('path', { d: 'M5.6 10.4h8.8' }),
        h('path', { d: 'M5.6 13.4h4.2' }));
    }

    function CustomizeIcon(props) {
      const own = iconProps(props);
      return h(IconBase, { size: own.size, active: own.active },
        h('path', { d: 'M6.2 3.4v13.2' }),
        h('circle', { cx: 6.2, cy: 8, r: 1.7 }),
        h('path', { d: 'M13.8 3.4v13.2' }),
        h('circle', { cx: 13.8, cy: 12.2, r: 1.7 }));
    }

    function ActivityIcon(props) {
      const own = iconProps(props);
      return h(IconBase, { size: own.size, active: own.active },
        h('path', { d: 'M2.6 10.4h3.2l2.1-5 3.3 9.2 2.4-5.2h3.8' }));
    }

    function AppearanceIcon(props) {
      const own = iconProps(props);
      return h(IconBase, { size: own.size, active: own.active },
        h('circle', { cx: 10, cy: 10, r: 3.2 }),
        h('path', { d: 'M10 2.4v1.8' }),
        h('path', { d: 'M10 15.8v1.8' }),
        h('path', { d: 'M2.4 10h1.8' }),
        h('path', { d: 'M15.8 10h1.8' }),
        h('path', { d: 'M4.7 4.7l1.3 1.3' }),
        h('path', { d: 'M14 14l1.3 1.3' }),
        h('path', { d: 'M15.3 4.7 14 6' }),
        h('path', { d: 'M6 14l-1.3 1.3' }));
    }

    function PluginsIcon(props) {
      const own = iconProps(props);
      return h(IconBase, { size: own.size, active: own.active },
        h('path', { d: 'M7 3.2v2.4' }),
        h('path', { d: 'M13 3.2v2.4' }),
        h('rect', { x: 3.4, y: 5.6, width: 13.2, height: 11.2, rx: 3 }),
        h('path', { d: 'M7 10.4v2.6' }),
        h('path', { d: 'M13 10.4v2.6' }));
    }

    function ModelIcon(props) {
      const own = iconProps(props);
      return h(IconBase, { size: own.size, active: own.active },
        h('rect', { x: 5.2, y: 5.2, width: 9.6, height: 9.6, rx: 2.2 }),
        h('rect', { x: 8.2, y: 8.2, width: 3.6, height: 3.6, rx: 1 }),
        h('path', { d: 'M7.4 2.6v2.6' }),
        h('path', { d: 'M12.6 2.6v2.6' }),
        h('path', { d: 'M7.4 14.8v2.6' }),
        h('path', { d: 'M12.6 14.8v2.6' }),
        h('path', { d: 'M2.6 7.4h2.6' }),
        h('path', { d: 'M2.6 12.6h2.6' }),
        h('path', { d: 'M14.8 7.4h2.6' }),
        h('path', { d: 'M14.8 12.6h2.6' }));
    }

    function SkillIcon(props) {
      const own = iconProps(props);
      return h(IconBase, { size: own.size, active: own.active },
        h('path', { d: 'M10 2.8l1.8 4.6 4.6 1.8-4.6 1.8L10 15.6l-1.8-4.6L3.6 9.2l4.6-1.8z' }),
        h('path', { d: 'M15.6 14.4l.7 1.7 1.7.7-1.7.7-.7 1.7' }));
    }

    /* ------------------------------------------------------------------ */
    /* Shared presentation pieces                                          */
    /* ------------------------------------------------------------------ */

    function SectionHeading(props) {
      return h('div', { className: 'hr-section' },
        h('span', { className: 'hr-section-label' }, props.label),
        typeof props.count === 'number' ? h('span', { className: 'hr-section-count' }, String(props.count)) : null);
    }

    function StatusCount(props) {
      return h('span', { className: 'hr-count' },
        h('strong', null, String(props.value)),
        props.label);
    }

    function EmptyState(props) {
      const Icon = typeof props.icon === 'function' ? props.icon : SearchIcon;
      return h('div', { className: 'hr-empty' },
        h('span', { className: 'hr-empty-icon', 'aria-hidden': 'true' }, h(Icon, { size: 18 })),
        h('div', { className: 'hr-empty-title' }, props.title),
        h('div', { className: 'hr-empty-body' }, props.body),
        props.action ? h('div', { className: 'hr-empty-action' }, props.action) : null);
    }

    /** One clickable session row shared by Search and Sessions. */
    function SessionRow(props) {
      const row = props.row;
      const current = props.current === true;
      const project = projectOf(row) || workspaceTitleOf(row, props.workspaces) || 'no project';
      return h('button', {
        type: 'button',
        className: 'hr-row',
        'data-current': current ? 'true' : undefined,
        title: String(row.id) + (row.running === true ? ' — running' : ''),
        onClick: () => props.env.openSession(row.id),
      },
        h('span', { className: 'hr-row-glyph', 'aria-hidden': 'true' }, h('span', { className: 'hr-row-dot' })),
        h('span', { className: 'hr-row-main' },
          h('span', { className: 'hr-row-title' }, highlighted(sessionTitle(row), props.query)),
          h('span', { className: 'hr-row-meta' },
            h('span', { className: 'hr-row-project' }, project),
            h('span', { className: 'hr-row-sep', 'aria-hidden': 'true' }, '·'),
            h('span', null, timeAgo(row.updatedAt, props.now)))),
        row.running === true ? h('span', { className: 'hr-tag hr-tag-live' }, h('span', { className: 'hr-tag-dot' }), 'running') : null,
        row.blank === true ? h('span', { className: 'hr-tag' }, 'new') : null,
        h('span', { className: 'hr-row-chevron', 'aria-hidden': 'true' }, '›'));
    }

    function CustomizeCard(props) {
      const card = props.card;
      const Icon = card.icon;
      return h('button', {
        type: 'button',
        className: 'hr-card',
        title: card.title + ' — ' + card.actionLabel,
        onClick: () => card.run(),
      },
        h('span', { className: 'hr-card-icon', 'aria-hidden': 'true' }, h(Icon, { size: 18 })),
        h('span', { className: 'hr-card-body' },
          h('span', { className: 'hr-card-title' }, card.title),
          h('span', { className: 'hr-card-desc' }, card.description),
          h('span', { className: 'hr-card-meta' }, card.meta)),
        h('span', { className: 'hr-card-chevron', 'aria-hidden': 'true' }, '›'));
    }

    function isLiveJob(job) {
      return Boolean(job) && (job.status === 'running' || job.status === 'stopping');
    }

    function JobRow(props) {
      const job = props.job;
      const live = isLiveJob(job);
      const rawLabel = typeof job.label === 'string' && job.label !== '' ? job.label : '';
      const label = rawLabel || (typeof job.kind === 'string' && job.kind !== '' ? job.kind : 'background task');
      const outputBytes = job.output && typeof job.output.total === 'number' ? job.output.total : 0;
      const meta = [];
      if (typeof job.kind === 'string' && job.kind !== '') meta.push(job.kind);
      if (typeof job.status === 'string' && job.status !== '') meta.push(job.status);
      if (typeof job.progress === 'string' && job.progress !== '') meta.push(job.progress);
      if (typeof job.detail === 'string' && job.detail !== '') meta.push(job.detail);
      meta.push(formatBytes(outputBytes) + ' output');
      const age = timeAgo(job.startedAt, props.now);
      if (age !== '') meta.push(age);
      return h('div', { className: 'hr-job', 'data-live': live ? 'true' : undefined },
        h('span', { className: 'hr-job-status', 'data-status': String(job.status || ''), 'aria-hidden': 'true' }),
        h('span', { className: 'hr-job-main' },
          h('span', { className: 'hr-job-label', title: label }, label),
          h('span', { className: 'hr-job-meta' }, meta.map((item, index) => h('span', { key: String(index), className: 'hr-job-meta-item' }, item)))),
        live
          ? h('button', {
            type: 'button',
            className: 'hr-job-stop',
            disabled: props.pending === true,
            title: 'Stop this background task',
            'aria-label': 'Stop background task: ' + label,
            onClick: () => props.onStop(),
          }, props.pending === true ? 'stopping…' : 'stop')
          : null);
    }

    /* ------------------------------------------------------------------ */
    /* Panel: Search                                                       */
    /* ------------------------------------------------------------------ */

    function createSearchPage(env) {
      return function SearchPage(props) {
        const useSessions = props ? props.useSessions : null;
        const useWorkspaces = props ? props.useWorkspaces : null;
        const list = typeof useSessions === 'function' ? useSessions(selectSnapshot) : null;
        const workspaces = typeof useWorkspaces === 'function' ? useWorkspaces(selectSnapshot) : null;
        const [query, setQuery] = useState('');
        const now = useNow(NOW_TICK_MS);

        const visible = sessionRows(list, workspaces);
        const trimmed = query.trim();
        const matches = trimmed === '' ? [] : visible.filter(row => sessionMatches(row, trimmed)).slice(0, SEARCH_RESULT_LIMIT);
        const recent = visible.slice(0, RECENT_LIMIT);
        const currentId = currentSessionId(list);
        const total = visible.length;

        const rowFor = row => h(SessionRow, {
          key: String(row.id),
          row,
          query: trimmed,
          current: currentId === row.id,
          now,
          workspaces,
          env,
        });

        let body = null;
        if (trimmed === '') {
          body = recent.length === 0
            ? h(EmptyState, {
              icon: SearchIcon,
              title: 'No sessions yet',
              body: 'Start a conversation in this workspace and it will show up here, ready to search.',
            })
            : h('div', null,
              h(SectionHeading, { label: 'Recent sessions', count: recent.length }),
              h('div', { className: 'hr-list' }, recent.map(rowFor)),
              h('p', { className: 'hr-tip' }, 'Search matches session titles, project names, and session ids.'));
        } else if (matches.length === 0) {
          body = h(EmptyState, {
            icon: SearchIcon,
            title: 'No matches',
            body: 'Nothing in this workspace matches “' + trimmed + '”. Try a different word, or clear the field.',
          });
        } else {
          body = h('div', null,
            h(SectionHeading, { label: 'Results', count: matches.length }),
            h('div', { className: 'hr-list' }, matches.map(rowFor)),
            total > SEARCH_RESULT_LIMIT
              ? h('p', { className: 'hr-tip' }, 'Showing the first ' + String(SEARCH_RESULT_LIMIT) + ' of ' + String(total) + ' matching sessions.')
              : null);
        }

        return h('div', { className: 'hr-page hr-page-search' },
          h('div', { className: 'hr-page-head' },
            h('div', { className: 'hr-column' },
              h('div', { className: 'hr-eyebrow' }, 'Search'),
              h('h1', { className: 'hr-title' }, 'Find a conversation'),
              h('p', { className: 'hr-subtitle' }, 'Filter every session in this client by title, project, or id. Enter opens the first match.'),
              h('div', { className: 'hr-search-field' },
                h('span', { className: 'hr-search-prompt', 'aria-hidden': 'true' }, '❯'),
                h('input', {
                  className: 'hr-search-input',
                  type: 'search',
                  value: query,
                  placeholder: 'Search sessions…',
                  'aria-label': 'Search sessions',
                  spellCheck: false,
                  autoComplete: 'off',
                  autoFocus: true,
                  onChange: event => setQuery(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Escape') {
                      setQuery('');
                      return;
                    }
                    if (event.key === 'Enter' && matches.length > 0) {
                      event.preventDefault();
                      env.openSession(matches[0].id);
                    }
                  },
                }),
                h('span', { className: 'hr-search-count' }, trimmed === '' ? String(total) + ' sessions' : String(matches.length) + ' of ' + String(total))))),
          h('div', { className: 'hr-scroll' }, h('div', { className: 'hr-column' }, body)),
          h('div', { className: 'hr-page-foot' },
            h('span', null, h('span', { className: 'hr-key' }, 'Enter'), ' open first match'),
            h('span', null, h('span', { className: 'hr-key' }, 'Esc'), ' clear'),
            h('span', { className: 'hr-foot-note' }, 'Local session catalog')));
      };
    }

    /* ------------------------------------------------------------------ */
    /* Panel: Sessions                                                     */
    /* ------------------------------------------------------------------ */

    function createSessionsPage(env) {
      return function SessionsPage(props) {
        const useSessions = props ? props.useSessions : null;
        const useWorkspaces = props ? props.useWorkspaces : null;
        const list = typeof useSessions === 'function' ? useSessions(selectSnapshot) : null;
        const workspaces = typeof useWorkspaces === 'function' ? useWorkspaces(selectSnapshot) : null;
        const now = useNow(NOW_TICK_MS);

        const rows = sessionRows(list, workspaces);
        const groups = groupSessions(rows, now);
        const currentId = currentSessionId(list);
        let running = 0;
        for (let i = 0; i < rows.length; i += 1) {
          if (rows[i].running === true) running += 1;
        }

        const rowFor = row => h(SessionRow, {
          key: String(row.id),
          row,
          query: '',
          current: currentId === row.id,
          now,
          workspaces,
          env,
        });

        let body = null;
        if (rows.length === 0) {
          body = h(EmptyState, {
            icon: SessionsIcon,
            title: 'No sessions yet',
            body: 'Start a conversation and it will appear here, grouped by when it was last used.',
            action: h('button', { type: 'button', className: 'hr-button hr-button-primary', onClick: () => env.startSession() }, 'Start a conversation'),
          });
        } else {
          body = h('div', null, groups.map(group => h('section', { key: group.key, className: 'hr-group' },
            h(SectionHeading, { label: group.label, count: group.items.length }),
            h('div', { className: 'hr-list' }, group.items.map(rowFor)))));
        }

        return h('div', { className: 'hr-page hr-page-sessions' },
          h('div', { className: 'hr-page-head' },
            h('div', { className: 'hr-column' },
              h('div', { className: 'hr-head-row' },
                h('div', { className: 'hr-head-text' },
                  h('div', { className: 'hr-eyebrow' }, 'Sessions'),
                  h('h1', { className: 'hr-title' }, 'All conversations'),
                  h('p', { className: 'hr-subtitle' }, 'Grouped by last activity. Click a row to open it in the main column.')),
                h('button', { type: 'button', className: 'hr-button hr-button-primary', onClick: () => env.startSession() }, 'New session')),
              running > 0
                ? h('div', { className: 'hr-head-chips' },
                  h(StatusCount, { value: running, label: 'running' }),
                  h(StatusCount, { value: rows.length, label: 'total' }))
                : null)),
          h('div', { className: 'hr-scroll' }, h('div', { className: 'hr-column' }, body)));
      };
    }

    /* ------------------------------------------------------------------ */
    /* Panel: Customize                                                    */
    /* ------------------------------------------------------------------ */

    function createCustomizePage(env) {
      return function CustomizePage(props) {
        const useSessions = props ? props.useSessions : null;
        const list = typeof useSessions === 'function' ? useSessions(selectSnapshot) : null;
        const current = currentSummary(list);
        const projections = current && current.projectionValues ? current.projectionValues : null;
        const model = modelLabel(projections);

        const cards = [
          {
            key: 'appearance',
            icon: AppearanceIcon,
            title: 'Appearance',
            description: 'Theme, font family, and the visual language of the whole shell.',
            meta: themeName(),
            actionLabel: 'Settings › General',
            run: () => env.openSettings('general'),
          },
          {
            key: 'plugins',
            icon: PluginsIcon,
            title: 'Plugins',
            description: 'Installed plugins, their bundles, views, and configuration pages.',
            meta: 'Plugin manager',
            actionLabel: 'Plugin manager page',
            run: () => env.openPlugins(),
          },
          {
            key: 'models',
            icon: ModelIcon,
            title: 'Models',
            description: 'Providers, API keys, and the model the next session starts on.',
            meta: model || 'No model recorded',
            actionLabel: 'Settings › Models',
            run: () => env.openSettings('models'),
          },
          {
            key: 'skills',
            icon: SkillIcon,
            title: 'Skills & settings',
            description: 'Agent presets, tool permissions, and the skill catalog behind the composer’s / menu.',
            meta: 'Settings',
            actionLabel: 'Settings',
            run: () => env.openSettings(null),
          },
        ];

        return h('div', { className: 'hr-page hr-page-customize' },
          h('div', { className: 'hr-page-head' },
            h('div', { className: 'hr-column' },
              h('div', { className: 'hr-head-row' },
                h('div', { className: 'hr-head-text' },
                  h('div', { className: 'hr-eyebrow' }, 'Customize'),
                  h('h1', { className: 'hr-title' }, 'Make it yours'),
                  h('p', { className: 'hr-subtitle' }, 'Shortcuts into the surfaces this client already owns: the settings modal, the plugin manager, and the model catalog.')),
                h('button', { type: 'button', className: 'hr-button', onClick: () => env.openSettings(null) }, 'Open settings')))),
          h('div', { className: 'hr-scroll' }, h('div', { className: 'hr-column' },
            h('div', { className: 'hr-cards' }, cards.map(card => h(CustomizeCard, { key: card.key, card }))),
            h('div', { className: 'hr-note' },
              h('span', { className: 'hr-note-mark', 'aria-hidden': 'true' }, '❯'),
              h('span', null, 'Every card opens a shipped surface. Where the Client API exposes no navigation hook, the rail replays the shell’s own shortcut command or clicks the labelled trigger; NOTES.md lists the exact paths.')))));
      };
    }

    /* ------------------------------------------------------------------ */
    /* Panel: Activity                                                     */
    /* ------------------------------------------------------------------ */

    function createActivityPage(env) {
      return function ActivityPage(props) {
        const useSessions = props ? props.useSessions : null;
        const list = typeof useSessions === 'function' ? useSessions(selectSnapshot) : null;
        const currentId = currentSessionId(list);
        const jobs = env.jobsService();
        const stateSource = jobs && jobs.state ? jobs.state : null;
        const snapshot = useObservable(stateSource);
        const [pending, setPending] = useState({});
        const now = useNow(NOW_TICK_MS);

        useEffect(() => {
          if (!jobs || currentId === undefined || typeof jobs.watchRows !== 'function') return undefined;
          let stop = null;
          try {
            stop = jobs.watchRows(currentId);
          } catch (error) {
            console.warn('[harness-rail] jobs.watchRows failed:', error);
            return undefined;
          }
          return () => {
            if (typeof stop !== 'function') return;
            try {
              stop();
            } catch (error) {
              console.warn('[harness-rail] jobs watch release failed:', error);
            }
          };
        }, [jobs, currentId]);

        const rows = snapshot && snapshot.rows && currentId !== undefined ? (snapshot.rows[String(currentId)] || []) : [];
        let running = 0;
        for (let i = 0; i < rows.length; i += 1) {
          if (isLiveJob(rows[i])) running += 1;
        }

        const stopJob = (jobId) => {
          if (!jobs || currentId === undefined || typeof jobs.kill !== 'function') return;
          setPending((previous) => {
            const next = Object.assign({}, previous);
            next[String(jobId)] = true;
            return next;
          });
          Promise.resolve()
            .then(() => jobs.kill(currentId, jobId))
            .catch((error) => { console.warn('[harness-rail] job kill failed:', error); })
            .then(() => setPending((previous) => {
              const next = Object.assign({}, previous);
              delete next[String(jobId)];
              return next;
            }));
        };

        let body = null;
        if (!jobs) {
          body = h(EmptyState, {
            icon: ActivityIcon,
            title: 'Background tasks unavailable',
            body: 'The jobs service is not part of this client composition, so the rail has no roster to show. Nothing is broken — this page just has no data source.',
          });
        } else if (currentId === undefined) {
          body = h(EmptyState, {
            icon: ActivityIcon,
            title: 'No active conversation',
            body: 'Open a conversation and the background tasks it started appear here, with live progress and a stop control.',
          });
        } else if (rows.length === 0) {
          body = h(EmptyState, {
            icon: ActivityIcon,
            title: 'Nothing running',
            body: 'Commands the agent starts in the background show up here while they run and after they settle.',
          });
        } else {
          body = h('div', { className: 'hr-list hr-job-list' }, rows.map(job => h(JobRow, {
            key: String(job.id),
            job,
            now,
            pending: pending[String(job.id)] === true,
            onStop: () => stopJob(job.id),
          })));
        }

        return h('div', { className: 'hr-page hr-page-activity' },
          h('div', { className: 'hr-page-head' },
            h('div', { className: 'hr-column' },
              h('div', { className: 'hr-head-row' },
                h('div', { className: 'hr-head-text' },
                  h('div', { className: 'hr-eyebrow' }, 'Activity'),
                  h('h1', { className: 'hr-title' }, 'Background tasks'),
                  h('p', { className: 'hr-subtitle' }, 'Processes the current conversation started in the background. Stop one without leaving the page.'))),
              running > 0
                ? h('div', { className: 'hr-head-chips' },
                  h(StatusCount, { value: running, label: 'running' }),
                  h(StatusCount, { value: rows.length, label: 'total' }))
                : null)),
          h('div', { className: 'hr-scroll' }, h('div', { className: 'hr-column' }, body)));
      };
    }

    /* ------------------------------------------------------------------ */
    /* Bottom status strip (root `shell.bottom` occupant)                  */
    /* ------------------------------------------------------------------ */

    function createStatusStrip(env) {
      return function StatusStrip(props) {
        const useSessions = props ? props.useSessions : null;
        const useWorkspaces = props ? props.useWorkspaces : null;
        const list = typeof useSessions === 'function' ? useSessions(selectSnapshot) : null;
        const workspaces = typeof useWorkspaces === 'function' ? useWorkspaces(selectSnapshot) : null;

        const current = currentSummary(list);
        const projections = current && current.projectionValues ? current.projectionValues : null;
        const usage = usageStats(projections);
        const context = contextStats(projections);
        const model = modelLabel(projections);
        const provider = providerLabel(projections);
        const running = current ? current.running === true : false;
        const project = current
          ? (projectOf(current) || workspaceTitleOf(current, workspaces) || 'no project')
          : (firstWorkspaceTitle(workspaces) || 'no workspace');
        const stateLabel = current ? (running ? 'running' : 'ready') : 'idle';
        const sessionLabel = current ? sessionTitle(current) : 'No session selected';
        const contextWidth = context.ratio === null ? 0 : Math.max(2, Math.round(context.ratio * 100));
        const cacheWidth = usage.cacheHit === null ? 0 : Math.max(2, Math.round(usage.cacheHit * 100));

        return h('div', { className: 'hr-strip' },
          h('div', { className: 'hr-strip-side hr-strip-left' },
            h('span', { className: 'hr-strip-prompt', 'aria-hidden': 'true' }, '❯'),
            h('span', { className: 'hr-strip-brand' }, 'dsh'),
            h('span', { className: 'hr-strip-sep', 'aria-hidden': 'true' }, '·'),
            h('span', { className: 'hr-strip-project', title: current && current.cwd ? String(current.cwd) : project }, project)),
          h('div', { className: 'hr-strip-mid' },
            h('span', { className: 'hr-strip-chip', title: (provider !== '' ? provider + ' / ' : '') + (model !== '' ? model : 'no model recorded for the current session') },
              h('span', { className: 'hr-strip-dot', 'aria-hidden': 'true' }),
              h('span', { className: 'hr-strip-chip-text' }, model !== '' ? model : 'no model')),
            h('span', { className: 'hr-strip-counter', title: 'Prompt-side tokens billed across this session (uncached input + cache read + cache write)' },
              h('span', { className: 'hr-strip-key' }, 'in'), formatTokens(usage.input)),
            h('span', { className: 'hr-strip-counter', title: 'Output tokens accumulated across this session' },
              h('span', { className: 'hr-strip-key' }, 'out'), formatTokens(usage.output)),
            h('span', { className: 'hr-strip-state', 'data-live': running ? 'true' : undefined, title: sessionLabel + ' — ' + stateLabel },
              h('span', { className: 'hr-strip-dot', 'aria-hidden': 'true' }), stateLabel)),
          h('div', { className: 'hr-strip-side hr-strip-right' },
            h('span', {
              className: 'hr-strip-meter',
              title: context.ratio === null
                ? 'Context pressure is not reported for the current session yet'
                : formatTokens(context.used) + ' of ' + formatTokens(context.window) + ' context tokens',
            },
              h('span', { className: 'hr-strip-key' }, 'ctx'),
              h('span', { className: 'hr-strip-meter-track' },
                h('span', {
                  className: 'hr-strip-meter-fill',
                  'data-tone': context.ratio !== null && context.ratio >= 0.85 ? 'warn' : 'mint',
                  style: { width: contextWidth + '%' },
                })),
              h('span', { className: 'hr-strip-meter-value' }, formatPercent(context.ratio))),
            h('span', {
              className: 'hr-strip-meter',
              title: usage.cacheHit === null
                ? 'Cache hit rate is not reported for the current session yet'
                : 'Cache reads are ' + formatPercent(usage.cacheHit) + ' of prompt-side tokens',
            },
              h('span', { className: 'hr-strip-key' }, 'cache'),
              h('span', { className: 'hr-strip-meter-track' },
                h('span', { className: 'hr-strip-meter-fill', 'data-tone': 'mint', style: { width: cacheWidth + '%' } })),
              h('span', { className: 'hr-strip-meter-value' }, formatPercent(usage.cacheHit)))));
      };
    }

    /* ------------------------------------------------------------------ */
    /* Styles (single data-plugin <style> tag, theme tokens only)          */
    /* ------------------------------------------------------------------ */

    const CSS = `
/* ===================================================================
Harness Rail — left rail pages + bottom status strip
Prefix: hr-   (every selector is rooted at .hr-page or .hr-strip)
Tokens: --dsw-alias-*, --dsw-radius-*, --dsw-font-family,
--dsw-elevation-*; mint alpha overlays are the documented accent.
=================================================================== */

.hr-page, .hr-strip { box-sizing: border-box; }
.hr-page *, .hr-page *::before, .hr-page *::after, .hr-strip *, .hr-strip *::before, .hr-strip *::after { box-sizing: border-box; }

/* ---------------------------------------------------------------- pages */
.hr-page {
  display: flex; flex-direction: column; height: 100%; min-height: 0; width: 100%; overflow: hidden;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family);
  font-size: 13px; line-height: 1.4;
}

.hr-page .hr-column { width: 100%; max-width: 880px; min-width: 0; margin: 0 auto; }

.hr-page .hr-page-head { flex: none; padding: 26px 40px 14px; }

.hr-page .hr-scroll {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 6px 40px 30px; scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l1) transparent;
}
.hr-page .hr-scroll::-webkit-scrollbar { width: 8px; }
.hr-page .hr-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1); border-radius: 4px; }
.hr-page .hr-scroll::-webkit-scrollbar-track { background: transparent; }

.hr-page .hr-page-foot {
  flex: none; display: flex; align-items: center; gap: 16px; padding: 7px 40px;
  border-top: 0.5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-tertiary); font-size: 11px; white-space: nowrap; overflow: hidden;
}
.hr-page .hr-page-foot > span { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.hr-page .hr-key {
  display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 4px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 4px; color: var(--dsw-alias-label-secondary); font-size: 10px;
  line-height: 1;
}
.hr-page .hr-foot-note { margin-left: auto; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-dimmed); }

/* ---------------------------------------------------------------- headings */
.hr-page .hr-head-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; }
.hr-page .hr-head-text { min-width: 0; }
.hr-page .hr-eyebrow {
  display: flex; align-items: center; gap: 6px; margin: 0 0 6px; color: var(--dsw-alias-label-tertiary); font-size: 11px;
  letter-spacing: 0.08em; text-transform: uppercase;
}
.hr-page .hr-eyebrow::before { content: '❯'; color: var(--dsw-alias-state-success-primary); text-shadow: 0 0 8px rgb(78 229 155 / 45%); }
.hr-page .hr-title {
  margin: 0; color: var(--dsw-alias-label-primary); font-size: 20px; font-weight: 600; line-height: 1.25;
  letter-spacing: -0.01em;
}
.hr-page .hr-subtitle { max-width: 640px; margin: 7px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12.5px; line-height: 1.5; }
.hr-page .hr-head-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.hr-page .hr-count {
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 4px; color: var(--dsw-alias-label-tertiary); font-size: 11px;
}
.hr-page .hr-count strong { color: var(--dsw-alias-label-secondary); font-weight: 500; font-variant-numeric: tabular-nums; }

/* ---------------------------------------------------------------- controls */
.hr-page .hr-button {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; flex: none;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer;
}
.hr-page .hr-button:hover {
  border-color: rgb(78 229 155 / 28%); background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary);
}
.hr-page .hr-button-primary { border-color: rgb(78 229 155 / 30%); background: rgb(78 229 155 / 10%); color: var(--dsw-alias-label-primary); }
.hr-page .hr-button:focus-visible, .hr-page .hr-row:focus-visible, .hr-page .hr-card:focus-visible, .hr-page .hr-job-stop:focus-visible {
  outline: 2px solid var(--dsw-alias-state-success-primary); outline-offset: 1px;
}

/* ---------------------------------------------------------------- search field */
.hr-page .hr-search-field {
  display: flex; align-items: center; gap: 10px; height: 40px; margin-top: 16px; padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.hr-page .hr-search-field:focus-within {
  border-color: rgb(78 229 155 / 45%); box-shadow: 0 0 0 1px rgb(78 229 155 / 12%), 0 0 18px rgb(78 229 155 / 6%);
}
.hr-page .hr-search-prompt {
  flex: none; color: var(--dsw-alias-state-success-primary); font-weight: 600; text-shadow: 0 0 8px rgb(78 229 155 / 45%);
}
.hr-page .hr-search-input {
  flex: 1; min-width: 0; height: 100%; border: none; outline: none; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px;
}
.hr-page .hr-search-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.hr-page .hr-search-count { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }

/* ---------------------------------------------------------------- sections + rows */
.hr-page .hr-section { display: flex; align-items: baseline; gap: 8px; margin: 18px 2px 6px; }
.hr-page .hr-scroll > .hr-column > .hr-section:first-child, .hr-page .hr-group:first-child .hr-section { margin-top: 6px; }
.hr-page .hr-section-label { color: var(--dsw-alias-label-tertiary); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; }
.hr-page .hr-section-count { color: var(--dsw-alias-label-dimmed); font-size: 11px; font-variant-numeric: tabular-nums; }
.hr-page .hr-list { display: flex; flex-direction: column; gap: 2px; }

.hr-page .hr-row {
  display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; margin: 0; padding: 9px 12px;
  border: 1px solid transparent; border-radius: var(--dsw-radius-md); background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer;
}
.hr-page .hr-row:hover { border-color: rgb(78 229 155 / 18%); background: var(--dsw-alias-interactive-bg-hover); }
.hr-page .hr-row[data-current='true'] {
  border-color: rgb(78 229 155 / 16%); background: rgb(78 229 155 / 6%);
  box-shadow: inset 2px 0 0 var(--dsw-alias-state-success-primary);
}
.hr-page .hr-row-glyph {
  display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; flex: none; border-radius: 8px;
  background: rgb(78 229 155 / 7%);
}
.hr-page .hr-row-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.hr-page .hr-row[data-current='true'] .hr-row-dot { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 6px rgb(78 229 155 / 70%); }
.hr-page .hr-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.hr-page .hr-row-title {
  overflow: hidden; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; text-overflow: ellipsis;
  white-space: nowrap;
}
.hr-page .hr-row-meta {
  display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; color: var(--dsw-alias-label-tertiary);
  font-size: 11px; white-space: nowrap;
}
.hr-page .hr-row-project { overflow: hidden; text-overflow: ellipsis; }
.hr-page .hr-row-sep { color: var(--dsw-alias-label-dimmed); }
.hr-page .hr-row-chevron { flex: none; color: var(--dsw-alias-label-dimmed); font-size: 15px; line-height: 1; }
.hr-page .hr-row:hover .hr-row-chevron { color: var(--dsw-alias-state-success-primary); }
.hr-page .hr-mark { padding: 0 1px; border-radius: 3px; background: rgb(78 229 155 / 22%); color: var(--dsw-alias-label-primary); }
.hr-page .hr-tag {
  flex: none; padding: 1px 5px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px;
  color: var(--dsw-alias-label-tertiary); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase;
}
.hr-page .hr-tag-live {
  display: inline-flex; align-items: center; gap: 4px; border-color: rgb(78 229 155 / 30%);
  color: var(--dsw-alias-state-success-primary);
}
.hr-page .hr-tag-dot {
  width: 4px; height: 4px; border-radius: 50%; background: var(--dsw-alias-state-success-primary);
  box-shadow: 0 0 5px rgb(78 229 155 / 80%); animation: hr-pulse 2.4s ease-in-out infinite;
}
.hr-page .hr-tip { margin: 14px 2px 0; color: var(--dsw-alias-label-dimmed); font-size: 11px; }

/* ---------------------------------------------------------------- empty states */
.hr-page .hr-empty {
  display: flex; flex-direction: column; align-items: center; gap: 6px; margin-top: 8px; padding: 46px 24px;
  border: 1px dashed var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); text-align: center;
}
.hr-page .hr-empty-icon {
  display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; margin-bottom: 4px;
  border-radius: 10px; background: rgb(78 229 155 / 8%); color: var(--dsw-alias-state-business-primary);
}
.hr-page .hr-empty-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; }
.hr-page .hr-empty-body { max-width: 420px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.55; }
.hr-page .hr-empty-action { margin-top: 8px; }

/* ---------------------------------------------------------------- customize cards */
.hr-page .hr-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; margin-top: 14px; }
.hr-page .hr-card {
  display: flex; align-items: flex-start; gap: 12px; min-width: 0; margin: 0; padding: 14px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); font: inherit; text-align: left; cursor: pointer;
}
.hr-page .hr-card:hover { border-color: rgb(78 229 155 / 22%); background: var(--dsw-alias-interactive-bg-hover); }
.hr-page .hr-card-icon {
  display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; flex: none;
  border-radius: 10px; background: rgb(78 229 155 / 8%); color: var(--dsw-alias-state-business-primary);
}
.hr-page .hr-card-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.hr-page .hr-card-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; }
.hr-page .hr-card-desc { color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 1.45; }
.hr-page .hr-card-meta {
  align-self: flex-start; max-width: 100%; margin-top: 4px; padding: 1px 6px; overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; background: rgb(78 229 155 / 5%);
  color: var(--dsw-alias-label-secondary); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase;
  text-overflow: ellipsis; white-space: nowrap;
}
.hr-page .hr-card-chevron { flex: none; align-self: center; color: var(--dsw-alias-label-dimmed); font-size: 16px; line-height: 1; }
.hr-page .hr-card:hover .hr-card-chevron { color: var(--dsw-alias-state-success-primary); }
.hr-page .hr-note {
  display: flex; align-items: flex-start; gap: 10px; margin-top: 18px; padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-tertiary); font-size: 11.5px; line-height: 1.55;
}
.hr-page .hr-note-mark { flex: none; color: var(--dsw-alias-state-success-primary); }

/* ---------------------------------------------------------------- activity jobs */
.hr-page .hr-job {
  display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2);
}
.hr-page .hr-job[data-live='true'] { border-color: rgb(78 229 155 / 20%); }
.hr-page .hr-job-status { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.hr-page .hr-job-status[data-status='running'] {
  background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 7px rgb(78 229 155 / 70%);
  animation: hr-pulse 2.4s ease-in-out infinite;
}
.hr-page .hr-job-status[data-status='stopping'] { background: var(--dsw-alias-state-warn-primary); }
.hr-page .hr-job-status[data-status='completed'] { background: var(--dsw-alias-state-done-primary); }
.hr-page .hr-job-status[data-status='failed'] { background: var(--dsw-alias-state-error-primary); }
.hr-page .hr-job-status[data-status='killed'] { background: var(--dsw-alias-label-dimmed); }
.hr-page .hr-job-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.hr-page .hr-job-label {
  overflow: hidden; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; text-overflow: ellipsis;
  white-space: nowrap;
}
.hr-page .hr-job-meta {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--dsw-alias-label-tertiary); font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.hr-page .hr-job-meta-item + .hr-job-meta-item::before { content: '·'; margin-right: 6px; color: var(--dsw-alias-label-dimmed); }
.hr-page .hr-job-stop {
  flex: none; padding: 3px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; cursor: pointer;
}
.hr-page .hr-job-stop:hover:not(:disabled) { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.hr-page .hr-job-stop:disabled { opacity: 0.5; cursor: default; }

/* ---------------------------------------------------------------- strip */
.hr-strip {
  display: flex; align-items: center; gap: 16px; width: 100%; height: 24px; padding: 0 12px; overflow: hidden;
  border-top: 0.5px solid var(--dsw-alias-border-l2); background: var(--dsw-specific-sidebar-fill);
  color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-family); font-size: 11px;
  font-variant-numeric: tabular-nums; line-height: 1; white-space: nowrap; user-select: none;
}
.hr-strip .hr-strip-side { display: flex; align-items: center; gap: 8px; min-width: 0; }
.hr-strip .hr-strip-left { flex: 0 1 auto; }
.hr-strip .hr-strip-mid { display: flex; align-items: center; justify-content: center; gap: 14px; flex: 1 1 auto; min-width: 0; overflow: hidden; }
.hr-strip .hr-strip-right { flex: none; }
.hr-strip .hr-strip-prompt { color: var(--dsw-alias-state-success-primary); font-weight: 600; text-shadow: 0 0 6px rgb(78 229 155 / 45%); }
.hr-strip .hr-strip-brand { color: var(--dsw-alias-label-primary); font-weight: 600; letter-spacing: 0.01em; }
.hr-strip .hr-strip-sep { color: var(--dsw-alias-label-dimmed); }
.hr-strip .hr-strip-project { max-width: 240px; overflow: hidden; color: var(--dsw-alias-label-secondary); text-overflow: ellipsis; }
.hr-strip .hr-strip-dot {
  width: 5px; height: 5px; flex: none; border-radius: 50%; background: var(--dsw-alias-state-success-primary);
  box-shadow: 0 0 6px rgb(78 229 155 / 70%);
}
.hr-strip .hr-strip-chip { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-primary); min-width: 0; }
.hr-strip .hr-strip-chip-text { overflow: hidden; text-overflow: ellipsis; }
.hr-strip .hr-strip-state { display: inline-flex; align-items: center; gap: 5px; }
.hr-strip .hr-strip-state .hr-strip-dot { background: var(--dsw-alias-state-idle-primary); box-shadow: none; }
.hr-strip .hr-strip-state[data-live='true'] .hr-strip-dot {
  background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 6px rgb(78 229 155 / 70%);
  animation: hr-pulse 2.4s ease-in-out infinite;
}
.hr-strip .hr-strip-counter { display: inline-flex; align-items: center; gap: 4px; }
.hr-strip .hr-strip-counter::before { content: '['; margin-right: 3px; color: rgb(78 229 155 / 45%); }
.hr-strip .hr-strip-counter::after { content: ']'; margin-left: 3px; color: rgb(78 229 155 / 45%); }
.hr-strip .hr-strip-key { color: var(--dsw-alias-label-dimmed); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; }
.hr-strip .hr-strip-meter { display: inline-flex; align-items: center; gap: 6px; }
.hr-strip .hr-strip-meter-track { width: 44px; height: 3px; overflow: hidden; border-radius: 2px; background: var(--dsw-alias-border-l2); }
.hr-strip .hr-strip-meter-fill { display: block; height: 100%; border-radius: 2px; background: var(--dsw-alias-state-success-primary); }
.hr-strip .hr-strip-meter-fill[data-tone='warn'] { background: var(--dsw-alias-state-warn-primary); }
.hr-strip .hr-strip-meter-value { color: var(--dsw-alias-label-secondary); min-width: 28px; text-align: right; }

@keyframes hr-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

/* ---------------------------------------------------------------- responsive */
@media (max-width: 1080px) {
  .hr-strip .hr-strip-counter { display: none; }
}
@media (max-width: 900px) {
  .hr-strip .hr-strip-meter-track, .hr-strip .hr-strip-meter-value { display: none; }
  .hr-strip .hr-strip-project { max-width: 120px; }
  .hr-strip .hr-strip-mid { gap: 10px; }
}
@media (max-width: 760px) {
  .hr-page .hr-page-head { padding: 20px 20px 12px; }
  .hr-page .hr-scroll { padding: 4px 20px 24px; }
  .hr-page .hr-page-foot { padding: 7px 20px; }
  .hr-page .hr-title { font-size: 18px; }
  .hr-page .hr-cards { grid-template-columns: 1fr; }
  .hr-page .hr-head-row { align-items: flex-start; flex-direction: column; gap: 12px; }
  .hr-page .hr-foot-note { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .hr-page .hr-tag-dot, .hr-page .hr-job-status[data-status='running'], .hr-strip .hr-strip-state[data-live='true'] .hr-strip-dot { animation: none; }
}
`;

    /* ------------------------------------------------------------------ */
    /* Registration                                                        */
    /* ------------------------------------------------------------------ */

    /**
     * Register one slot entry and never let a composition conflict crash the
     * plugin fiber: a single-slot occupant conflict is retried one priority
     * lower (lowest priority wins), and a failed registration degrades to a
     * no-op disposer.
     */
    function registerSafely(ctx, options, component, label) {
      try {
        return ctx.slots.register(options, component);
      } catch (error) {
        console.warn('[harness-rail] ' + label + ' registration failed at default priority:', error);
        if (options.priority === undefined) {
          try {
            return ctx.slots.register(Object.assign({}, options, { priority: -1 }), component);
          } catch (retryError) {
            console.warn('[harness-rail] ' + label + ' registration failed on retry:', retryError);
            return () => {};
          }
        }
        return () => {};
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const env = createEnvironment(ctx);
        const pages = {
          search: createSearchPage(env),
          sessions: createSessionsPage(env),
          customize: createCustomizePage(env),
          activity: createActivityPage(env),
          strip: createStatusStrip(env),
        };
        const panels = [
          { id: PANEL_ID.search, order: RAIL_ORDER.search, label: 'Search', page: pages.search, icon: SearchIcon },
          { id: PANEL_ID.sessions, order: RAIL_ORDER.sessions, label: 'Sessions', page: pages.sessions, icon: SessionsIcon },
          { id: PANEL_ID.customize, order: RAIL_ORDER.customize, label: 'Customize', page: pages.customize, icon: CustomizeIcon },
          { id: PANEL_ID.activity, order: RAIL_ORDER.activity, label: 'Activity', page: pages.activity, icon: ActivityIcon },
        ];

        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.dataset.plugin = PACKAGE_ID;
          tag.dataset.pluginCss = PACKAGE_ID + '/styles.css';
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => {
            if (tag.parentNode) tag.parentNode.removeChild(tag);
          };
        }, 'harness-rail: styles');

        ctx.effect(() => {
          const disposers = [];
          for (let i = 0; i < panels.length; i += 1) {
            const panel = panels[i];
            disposers.push(ctx.slots.inject('main', () => registerSafely(
              ctx,
              { name: 'main', key: panel.id },
              panel.page,
              'main panel ' + panel.id,
            )));
            disposers.push(ctx.slots.inject('sidebar.panellist', () => registerSafely(
              ctx,
              {
                name: 'sidebar.panellist',
                id: panel.id,
                order: panel.order,
                label: () => panel.label,
              },
              panel.icon,
              'rail row ' + panel.id,
            )));
          }
          disposers.push(ctx.slots.inject('shell.bottom', () => registerSafely(
            ctx,
            { name: 'shell.bottom' },
            pages.strip,
            'status strip',
          )));
          return () => {
            for (let i = 0; i < disposers.length; i += 1) {
              try {
                disposers[i]();
              } catch (error) {
                console.warn('[harness-rail] slot disposer failed:', error);
              }
            }
          };
        }, 'harness-rail: registrations');
      },
    };
  },
});
