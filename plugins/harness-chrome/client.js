/**
 * Client half of the Harness Chrome bundle.
 *
 * Puts a compact, Lamprey-style command menu bar into the conversation
 * header's leading seat (`conversation.header.leading`, root scope) — present in
 * both the session and the no-session state:
 *
 *     File  Edit  View  Window  Help
 *
 * Each tab opens a real dropdown whose actions are wired to public DSH client
 * surfaces only (ctx.layout, ctx.sidebarRight, ctx.uiWorkspace,
 * ctx.pluginNavigation, the ctx.shortcuts command catalog, and plain DOM /
 * navigator APIs). Below ~900px of header width the whole strip collapses into
 * a single "⋯" menu so it can never push the title row around.
 *
 * The occupant is a plain-JS React surface: `require('react')` is the only
 * shared module, everything else is DOM/JS. Styling uses only `--dsw-*` theme
 * tokens and lives in one module-owned <style> tag tagged `data-plugin`, so HMR
 * unload removes both the CSS and the registration.
 */
window.__ModuleLoader__.load({
  id: '@local/harness-chrome',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const PLUGIN_ID = '@local/harness-chrome';
    const PLUGIN_VERSION = '1.0.0';
    /** Header width (CSS px) under which the five tabs collapse into one "⋯" menu. */
    const COMPACT_BREAKPOINT = 900;
    const MENUBAR_LABEL = 'Main menu';
    /** Menu-row navigation keys handled in the popup itself (Escape handled at document capture). */
    const MENU_NAV_KEYS = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ', 'Spacebar', 'Tab'];
    /** Preferred command ids for the local fallback shortcut panel, most useful first. */
    const FALLBACK_SHORTCUT_IDS = [
      'session.new', 'session.search', 'settings.open', 'shortcuts.open',
      'sidebar.left.toggle', 'session.fork', 'workspace.add', 'session.rename',
      'session.archive', 'workspace.openLocal',
    ];

    /* ------------------------------------------------------------------ */
    /* Styles (theme tokens only; one data-plugin tag)                     */
    /* ------------------------------------------------------------------ */

    const CSS = `
.hc-root {
  position: relative; display: flex; align-items: center; gap: 1px; height: 26px;
  padding: 0 2px; font-family: var(--dsw-font-family); font-size: 11.5px;
  line-height: 16px; color: var(--dsw-alias-label-secondary);
  -webkit-app-region: no-drag; user-select: none;
}
.hc-root *, .hc-root *::before, .hc-root *::after { box-sizing: border-box; }
.hc-menubar { display: flex; align-items: center; gap: 1px; }

.hc-tab {
  display: inline-flex; align-items: center; justify-content: center; height: 24px;
  padding: 0 8px; border: 0; border-radius: 6px; background: transparent; color: inherit;
  font: inherit; letter-spacing: 0.02em; white-space: nowrap; cursor: pointer;
}
.hc-tab:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.hc-tab[data-open='true'] {
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-label-primary);
  box-shadow: inset 0 0 0 1px rgb(78 229 155 / 24%);
}
.hc-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.hc-more { padding: 0 7px; font-size: 13px; letter-spacing: 0; }

.hc-popup, .hc-panel {
  position: absolute; top: calc(100% + 7px); left: 0; z-index: 70;
  border-radius: var(--dsw-radius-md); background: var(--dsw-specific-menu);
  box-shadow: var(--dsw-elevation-panel);
  backdrop-filter: var(--dsw-menu-backdrop-filter);
  -webkit-backdrop-filter: var(--dsw-menu-backdrop-filter);
  color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family);
  text-align: left; animation: hc-pop-in 90ms ease-out;
}
.hc-popup { min-width: 216px; max-width: min(320px, calc(100vw - 24px)); padding: 4px; }
.hc-popup[data-kind='compact'] { min-width: 248px; }
.hc-panel { width: min(340px, calc(100vw - 32px)); padding: 10px 12px 8px; outline: none; }

.hc-item {
  display: flex; align-items: center; gap: 14px; width: 100%; min-height: 26px;
  padding: 4px 8px; border: 0; border-radius: 8px; background: transparent;
  color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 12.5px;
  line-height: 16px; text-align: left; cursor: pointer;
}
.hc-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.hc-item:focus { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.hc-item:focus-visible { background: var(--dsw-alias-interactive-bg-active); outline: none; }
.hc-item[aria-disabled='true'] { color: var(--dsw-alias-state-idle-primary); cursor: default; }
.hc-item[aria-disabled='true']:hover, .hc-item[aria-disabled='true']:focus { background: transparent; }
.hc-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hc-item-keys { display: inline-flex; flex: none; gap: 3px; }

.hc-key {
  display: inline-flex; align-items: center; justify-content: center; min-width: 14px;
  height: 16px; padding: 0 4px; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 4px; background: rgb(78 229 155 / 5%);
  color: var(--dsw-alias-label-tertiary); font-size: 10px; line-height: 14px;
}
.hc-separator { height: 1px; margin: 4px 8px; background: var(--dsw-alias-separator-primary); }
.hc-section {
  padding: 6px 8px 2px; color: var(--dsw-alias-label-tertiary); font-size: 10px;
  letter-spacing: 0.08em; text-transform: uppercase;
}
.hc-section:first-child { padding-top: 2px; }

.hc-panel-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.hc-panel-title {
  color: var(--dsw-alias-label-tertiary); font-size: 11px;
  letter-spacing: 0.08em; text-transform: uppercase;
}
.hc-panel-close {
  display: inline-flex; align-items: center; justify-content: center; width: 20px;
  height: 20px; padding: 0; border: 0; border-radius: 5px; background: transparent;
  color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 13px;
  line-height: 1; cursor: pointer;
}
.hc-panel-close:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.hc-panel-close:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.hc-panel-rows { display: flex; flex-direction: column; gap: 1px; max-height: min(52vh, 420px); overflow: auto; }
.hc-panel-row { display: flex; align-items: center; gap: 12px; min-height: 24px; padding: 2px 4px; font-size: 11.5px; }
.hc-panel-label {
  flex: 1; min-width: 0; overflow: hidden; color: var(--dsw-alias-label-secondary);
  text-overflow: ellipsis; white-space: nowrap;
}
.hc-panel-value {
  flex: none; max-width: 60%; overflow: hidden; color: var(--dsw-alias-label-primary);
  font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap;
}
.hc-panel-keys { display: inline-flex; flex: none; gap: 3px; }
.hc-panel-empty { margin: 4px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 1.45; }
.hc-panel-foot {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--dsw-alias-border-l1);
}
.hc-panel-note { flex: 1; min-width: 0; color: var(--dsw-alias-label-tertiary); font-size: 10.5px; line-height: 1.4; }
.hc-panel-action {
  flex: none; padding: 3px 8px; border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px; background: rgb(78 229 155 / 6%);
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 10.5px; cursor: pointer;
}
.hc-panel-action:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.hc-panel-action:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

@keyframes hc-pop-in {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .hc-popup, .hc-panel { animation: none; }
}
`;

    /* ------------------------------------------------------------------ */
    /* Plain helpers                                                       */
    /* ------------------------------------------------------------------ */

    function safeGet(ctx, name) {
      try {
        return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
      } catch {
        return undefined;
      }
    }

    function safeCall(label, fn) {
      try {
        return fn();
      } catch (error) {
        console.warn('[harness-chrome] ' + label + ' failed:', error);
        return undefined;
      }
    }

    function readSelection() {
      try {
        const selection = window.getSelection();
        return selection ? String(selection).trim() : '';
      } catch {
        return '';
      }
    }

    function findComposer() {
      try {
        const scope = document.querySelector('main') || document.body;
        if (!scope) return null;
        const nodes = scope.querySelectorAll('[contenteditable="true"], [contenteditable="plaintext-only"]');
        for (const node of nodes) {
          if (!(node instanceof Element) || node.getClientRects().length === 0) continue;
          if (node.closest('[role="dialog"][aria-modal="true"], [aria-hidden="true"]')) continue;
          return node;
        }
        return null;
      } catch {
        return null;
      }
    }

    function selectComposerDraft() {
      const editor = findComposer();
      if (!editor) return false;
      try {
        editor.focus({ preventScroll: true });
        const selection = window.getSelection();
        if (!selection) return false;
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      } catch (error) {
        console.warn('[harness-chrome] selecting the composer draft failed:', error);
        return false;
      }
    }

    async function writeClipboard(text) {
      if (!text) return false;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch {
        /* fall through to the legacy path */
      }
      try {
        const field = document.createElement('textarea');
        field.value = text;
        field.setAttribute('readonly', '');
        field.style.position = 'fixed';
        field.style.top = '-1000px';
        document.body.appendChild(field);
        field.select();
        const copied = document.execCommand('copy');
        field.remove();
        return copied;
      } catch (error) {
        console.warn('[harness-chrome] clipboard write failed:', error);
        return false;
      }
    }

    /** Read the Host release identity from the public boot graph (falling back to the rendered brand). */
    function readAboutInfo() {
      let release = null;
      try {
        const boot = window.__DSH_BOOT__;
        if (boot && typeof boot === 'object' && boot.release) release = boot.release;
      } catch {
        release = null;
      }
      let version = release && typeof release.version === 'string' ? release.version : '';
      let commit = release && typeof release.commit === 'string' ? release.commit : '';
      if (!version) {
        try {
          const node = document.querySelector('[data-copy-version]');
          const match = node && /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(node.textContent || '');
          if (match) version = match[1];
        } catch {
          /* the brand badge is optional */
        }
      }
      const dataset = document.documentElement.dataset || {};
      return {
        version: version || 'unknown', commit: commit || 'unknown',
        runtime: dataset.platform ? 'Desktop' : 'Web', platform: dataset.platform || navigator.platform || 'unknown',
      };
    }

    /** All shortcut command rows the client publishes through `ctx.shortcuts.catalog`. */
    function commandRows(ctx) {
      const shortcuts = safeGet(ctx, 'shortcuts');
      if (!shortcuts || !shortcuts.catalog || typeof shortcuts.catalog.getSnapshot !== 'function') return [];
      const rows = safeCall('read shortcut catalog', () => shortcuts.catalog.getSnapshot());
      return Array.isArray(rows) ? rows : [];
    }

    function findCommandRow(ctx, id) {
      for (const row of commandRows(ctx)) if (row && row.id === id) return row;
      return null;
    }

    /** A command row that can actually run from a synthesized gesture (bound, unconflicted, single-stroke). */
    function usableCommand(ctx, id) {
      const row = findCommandRow(ctx, id);
      if (!row || row.binding == null) return null;
      if (row.binding.secondCode) return null;
      if (row.issue) return null;
      if (Array.isArray(row.conflicts) && row.conflicts.length > 0) return null;
      return row;
    }

    /**
     * Re-dispatch one catalog binding as a synthetic keydown so the owning
     * plugin's own command resolves it. The command catalog is the public
     * contract here: `ctx.shortcuts` publishes bindings but no `invoke()`.
     */
    function dispatchCommand(row) {
      const binding = row.binding;
      if (!binding || typeof binding.code !== 'string' || !binding.code) return false;
      const modifiers = Array.isArray(binding.modifiers) ? binding.modifiers : [];
      try {
        const event = new KeyboardEvent('keydown', {
          key: '',
          code: binding.code,
          bubbles: true,
          cancelable: true,
          composed: true,
          ctrlKey: modifiers.includes('control'),
          altKey: modifiers.includes('alt'),
          shiftKey: modifiers.includes('shift'),
          metaKey: modifiers.includes('meta'),
          repeat: false,
        });
        window.dispatchEvent(event);
        return true;
      } catch (error) {
        console.warn('[harness-chrome] dispatching a command gesture failed:', error);
        return false;
      }
    }

    function leftSidebarCollapsed() {
      try {
        return document.querySelector('[data-sidebar-collapsed]') !== null;
      } catch {
        return false;
      }
    }

    /** Find the product's own labelled Settings launcher (rendered by `settings.launcher`). */
    function settingsLauncher() {
      try {
        const seat = document.querySelector('[data-slot="settings.launcher"]');
        const button = seat ? seat.querySelector('button') : null;
        return button && !button.disabled ? button : null;
      } catch {
        return null;
      }
    }

    /**
     * Whether the shell runs inside the Desktop app. Desktop delivers configurable
     * commands through its native keyboard bridge, so a synthetic DOM keydown is
     * not the way in there.
     */
    function isDesktopRuntime() {
      try {
        return document.documentElement.dataset.platform !== undefined;
      } catch {
        return false;
      }
    }

    /* ------------------------------------------------------------------ */
    /* Environment: public client surfaces behind small guarded calls      */
    /* ------------------------------------------------------------------ */

    /**
     * Build the action environment handed to every menu action. Each accessor
     * re-reads the live service so a menu opened after a plugin reload still
     * acts on what exists now; every write is wrapped so a missing or busy
     * surface degrades to a no-op instead of breaking the header.
     * @param ctx - the client plugin context (services reached through ctx.get).
     * @param host - component callbacks: openPanel(id) and selection() (captured text).
     */
    function createEnv(ctx, host) {
      const layout = () => safeGet(ctx, 'layout');
      const rightbar = () => safeGet(ctx, 'sidebarRight');
      const invoke = (id) => { const row = usableCommand(ctx, id); return row ? dispatchCommand(row) : false; };
      const commandReady = (id) => usableCommand(ctx, id) !== null;
      const workspace = () => safeGet(ctx, 'uiWorkspace');
      const rightbarMounted = () => {
        const service = rightbar();
        if (!service || !service.mounted) return false;
        const session = safeCall('read right sidebar session', () => service.mounted.getSnapshot());
        return session != null;
      };
      const rightbarExpanded = () => {
        const service = rightbar();
        if (!service || typeof service.isExpanded !== 'function') return false;
        return safeCall('read right sidebar state', () => service.isExpanded()) === true;
      };
      const env = {
        selection: () => readSelection() || host.selection(),
        commandReady,
        canStartSession: () => Boolean(workspace() && typeof workspace().startSession === 'function')
          || commandReady('session.new'),
        canOpenPlugins: () => {
          const navigation = safeGet(ctx, 'pluginNavigation');
          if (navigation && typeof navigation.openList === 'function') return true;
          const panels = layout();
          return Boolean(panels && typeof panels.selectPanel === 'function');
        },
        canOpenSettings: () => settingsLauncher() !== null || commandReady('settings.open'),
        openSettings: () => {
          const launcher = settingsLauncher();
          if (launcher) { safeCall('opening Settings', () => launcher.click()); return true; }
          return invoke('settings.open');
        },
        keyHint: (id) => {
          const row = findCommandRow(ctx, id);
          return row && Array.isArray(row.keys) && row.keys.length > 0 ? row.keys.slice(0, 4) : null;
        },
        invoke,
        openPanel: (id) => { host.openPanel(id); },
        startSession: () => {
          const service = workspace();
          if (service && typeof service.startSession === 'function') {
            safeCall('starting a Session', () => service.startSession());
            return true;
          }
          return invoke('session.new');
        },
        openPlugins: () => {
          const navigation = safeGet(ctx, 'pluginNavigation');
          if (navigation && typeof navigation.openList === 'function') {
            safeCall('opening the Plugins panel', () => navigation.openList());
            return true;
          }
          const panels = layout();
          if (!panels || typeof panels.selectPanel !== 'function') return false;
          safeCall('selecting the Plugins panel', () => panels.selectPanel('plugins'));
          return true;
        },
        openShortcuts: () => {
          // Desktop arbitrates configurable commands natively, so the DOM gesture
          // path only exists in the browser; fall back to the local reference panel there.
          if (!isDesktopRuntime() && commandReady('shortcuts.open')) {
            invoke('shortcuts.open');
            return true;
          }
          host.openPanel('shortcuts');
          return false;
        },
        toggleLeftSidebar: () => {
          const panels = layout();
          if (panels && typeof panels.toggleSidebar === 'function') {
            safeCall('toggling the left sidebar', () => panels.toggleSidebar());
          }
        },
        rightbarMounted,
        rightbarExpanded,
        toggleRightSidebar: () => {
          const service = rightbar();
          if (service && typeof service.toggleExpanded === 'function') {
            safeCall('toggling the right sidebar', () => service.toggleExpanded());
          }
        },
        anySidebarOpen: () => !leftSidebarCollapsed() || rightbarExpanded(),
        collapseSidebars: () => {
          if (!leftSidebarCollapsed()) env.toggleLeftSidebar();
          if (rightbarExpanded()) env.toggleRightSidebar();
        },
        fullscreenEnabled: () => {
          try { return Boolean(document.fullscreenEnabled); } catch { return false; }
        },
        toggleFullscreen: () => {
          try {
            if (document.fullscreenElement) {
              const exit = document.exitFullscreen();
              if (exit && typeof exit.catch === 'function') exit.catch(() => {});
              return;
            }
            const root = document.documentElement;
            if (!root || typeof root.requestFullscreen !== 'function') return;
            const enter = root.requestFullscreen();
            if (enter && typeof enter.catch === 'function') {
              enter.catch((error) => console.warn('[harness-chrome] fullscreen refused:', error));
            }
          } catch (error) {
            console.warn('[harness-chrome] fullscreen toggle failed:', error);
          }
        },
        reload: () => {
          try { window.location.reload(); } catch { /* refused reload keeps the page */ }
        },
        copySelection: () => {
          const text = env.selection();
          if (!text) return false;
          void writeClipboard(text);
          return true;
        },
        composerAvailable: () => findComposer() !== null,
        selectComposer: () => selectComposerDraft(),
        about: () => readAboutInfo(),
        shortcutRows: () => {
          const rows = commandRows(ctx);
          if (rows.length === 0) return [];
          const picked = [];
          const seen = new Set();
          const push = (row) => {
            if (!row || seen.has(row.id)) return;
            if (!Array.isArray(row.keys) || row.keys.length === 0) return;
            seen.add(row.id);
            picked.push({
              id: String(row.id),
              label: typeof row.label === 'string' && row.label ? row.label : String(row.id),
              keys: row.keys.slice(0, 4),
            });
          };
          for (const id of FALLBACK_SHORTCUT_IDS) push(rows.find((row) => row && row.id === id));
          for (const row of rows) { if (picked.length >= 10) break; push(row); }
          return picked;
        },
      };
      return env;
    }

    /* ------------------------------------------------------------------ */
    /* Action matrix and menu layout                                       */
    /* ------------------------------------------------------------------ */

    /**
     * Every actionable row. `availability` returns true, or a disabled reason
     * string; `run` performs the action and may return 'panel-opened' when it
     * replaced the dropdown with a local panel (so the dropdown stays closed).
     */
    const ACTIONS = {
      'new-session': {
        label: 'New Session',
        command: 'session.new',
        availability: (env) => (env.canStartSession() ? true : 'No Session service'),
        run: (env) => { env.startSession(); },
      },
      'open-plugins': {
        label: 'Open Plugins',
        availability: (env) => (env.canOpenPlugins() ? true : 'Plugins page unavailable'),
        run: (env) => { env.openPlugins(); },
      },
      'open-settings': {
        label: 'Open Settings',
        command: 'settings.open',
        availability: (env) => (env.canOpenSettings() ? true : 'Settings unavailable'),
        run: (env) => { env.openSettings(); },
      },
      'find-sessions': {
        label: 'Find Sessions',
        command: 'session.search',
        availability: (env) => (env.commandReady('session.search') ? true : 'Session search command unavailable'),
        run: (env) => { env.invoke('session.search'); },
      },
      'copy-selection': {
        label: 'Copy Selection',
        availability: (env) => (env.selection() ? true : 'Select text first'),
        run: (env) => { env.copySelection(); },
      },
      'select-composer': {
        label: 'Select Composer Draft',
        availability: (env) => (env.composerAvailable() ? true : 'Composer not found'),
        run: (env) => { env.selectComposer(); },
      },
      'toggle-left': {
        label: 'Toggle Left Sidebar',
        availability: () => true,
        run: (env) => { env.toggleLeftSidebar(); },
      },
      'toggle-right': {
        label: 'Toggle Right Sidebar',
        availability: (env) => (env.rightbarMounted() ? true : 'No Session on screen'),
        run: (env) => { env.toggleRightSidebar(); },
      },
      reload: {
        label: 'Reload Page',
        availability: () => true,
        run: (env) => { env.reload(); },
      },
      fullscreen: {
        label: 'Toggle Fullscreen',
        availability: (env) => (env.fullscreenEnabled() ? true : 'Fullscreen unavailable'),
        run: (env) => { env.toggleFullscreen(); },
      },
      'collapse-both': {
        label: 'Collapse Both Sidebars',
        availability: (env) => (env.anySidebarOpen() ? true : 'Both sidebars are already collapsed'),
        run: (env) => { env.collapseSidebars(); },
      },
      shortcuts: {
        label: 'Keyboard Shortcuts',
        command: 'shortcuts.open',
        availability: () => true,
        run: (env) => (env.openShortcuts() ? undefined : 'panel-opened'),
      },
      about: {
        label: 'About DeepSeek Harness',
        availability: () => true,
        run: (env) => {
          env.openPanel('about');
          return 'panel-opened';
        },
      },
    };

    /** `null` marks a separator in a menu's entry sequence. */
    const MENUS = [
      { id: 'file', label: 'File', entries: ['new-session', null, 'open-plugins', 'open-settings'] },
      { id: 'edit', label: 'Edit', entries: ['find-sessions', null, 'copy-selection', 'select-composer'] },
      { id: 'view', label: 'View', entries: ['toggle-left', 'toggle-right', null, 'reload'] },
      { id: 'window', label: 'Window', entries: ['fullscreen', null, 'collapse-both'] },
      { id: 'help', label: 'Help', entries: ['shortcuts', null, 'about'] },
    ];

    function buildItemRow(env, actionId) {
      const action = ACTIONS[actionId];
      if (!action) return { kind: 'separator' };
      const status = typeof action.availability === 'function' ? action.availability(env) : true;
      const enabled = status === true;
      return {
        kind: 'item',
        actionId,
        label: action.label,
        keys: action.command ? env.keyHint(action.command) : null,
        disabled: !enabled,
        disabledReason: enabled ? '' : (typeof status === 'string' ? status : 'Unavailable'),
      };
    }

    function buildMenuRows(env, menuId) {
      const menu = MENUS.find((entry) => entry.id === menuId);
      const rows = [];
      if (!menu) return rows;
      for (const entry of menu.entries) {
        if (entry === null) {
          if (rows.length > 0 && rows[rows.length - 1].kind === 'item') rows.push({ kind: 'separator' });
          continue;
        }
        rows.push(buildItemRow(env, entry));
      }
      while (rows.length > 0 && rows[rows.length - 1].kind === 'separator') rows.pop();
      return rows;
    }

    function buildCompactRows(env) {
      const rows = [];
      for (const menu of MENUS) {
        rows.push({ kind: 'section', label: menu.label });
        for (const entry of menu.entries) {
          if (entry === null) continue;
          rows.push(buildItemRow(env, entry));
        }
      }
      return rows;
    }

    /* ------------------------------------------------------------------ */
    /* The header menu bar                                                 */
    /* ------------------------------------------------------------------ */

    /**
     * The `conversation.header.leading` occupant.
     * @param props - slot runtime props plus the injected `pluginCtx` (client plugin context).
     */
    function MenuBar(props) {
      const pluginCtx = props && props.pluginCtx ? props.pluginCtx : null;
      const [open, setOpen] = useState(null);
      const [activeRow, setActiveRow] = useState(0);
      const [compact, setCompact] = useState(false);
      const rootRef = useRef(null);
      const popupRef = useRef(null);
      const panelRef = useRef(null);
      const itemRefs = useRef([]);
      const tabRefs = useRef([]);
      const triggerRef = useRef(null);
      const selectionRef = useRef('');

      const close = useCallback((options) => {
        setOpen(null);
        setActiveRow(0);
        if (options && options.focusTrigger) {
          const node = triggerRef.current;
          if (node && node.isConnected) {
            try {
              node.focus({ preventScroll: true });
            } catch {
              node.focus();
            }
          }
        }
      }, []);

      const env = useMemo(() => createEnv(pluginCtx, {
        openPanel: (id) => { setOpen({ kind: 'panel', id }); },
        selection: () => selectionRef.current,
      }), [pluginCtx]);

      /* Collapse into one "⋯" menu when the header gets narrow. */
      useEffect(() => {
        const root = rootRef.current;
        if (!root) return undefined;
        const target = root.closest('header') || root.parentElement;
        if (!target) return undefined;
        const measure = () => {
          let width = 0;
          try {
            width = target.getBoundingClientRect().width;
          } catch {
            width = 0;
          }
          if (!width) {
            try {
              width = window.innerWidth;
            } catch {
              width = 0;
            }
          }
          setCompact(width > 0 && width < COMPACT_BREAKPOINT);
        };
        measure();
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(measure);
          observer.observe(target);
          return () => observer.disconnect();
        }
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
      }, []);

      /* Closing gestures: outside pointerdown, Escape, and any other key that
       * belongs to a global shortcut (the popup only claims menu-navigation
       * keys, so Ctrl/⌘ combos keep working). */
      useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const root = rootRef.current;
          const target = event.target;
          if (root && target instanceof Node && root.contains(target)) return;
          close({});
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape' || event.key === 'Esc') {
            event.preventDefault();
            event.stopPropagation();
            close({ focusTrigger: true });
            return;
          }
          if (MENU_NAV_KEYS.indexOf(event.key) >= 0) return;
          const popup = popupRef.current;
          if (popup && (event.ctrlKey || event.metaKey || event.altKey)) {
            // The popup's role=menu would otherwise count as a modal for one key
            // press; hide it for the duration of this event only.
            const previous = popup.getAttribute('role');
            popup.setAttribute('role', 'presentation');
            window.setTimeout(() => {
              try {
                popup.setAttribute('role', previous || 'menu');
              } catch {
                /* the popup may already be unmounted */
              }
            }, 0);
          }
          close({});
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, [open, close]);

      /* Move focus into a freshly opened popup/panel. */
      useEffect(() => {
        if (!open) return;
        if (open.kind === 'panel') {
          const panel = panelRef.current;
          if (panel) panel.focus({ preventScroll: true });
          return;
        }
        const rows = open.rows || [];
        for (let index = 0; index < rows.length; index += 1) {
          if (rows[index] && rows[index].kind === 'item') {
            setActiveRow(index);
            const node = itemRefs.current[index];
            if (node) node.focus({ preventScroll: true });
            return;
          }
        }
      }, [open]);

      const rememberSelection = useCallback(() => {
        const live = readSelection();
        if (live) selectionRef.current = live;
      }, []);

      /**
       * A tab's pointerdown runs before the browser's default mousedown action
       * can collapse the page selection, so this is the moment a "Copy
       * Selection" row can still see what the user selected.
       */
      const captureSelectionAtPointerDown = useCallback(() => {
        selectionRef.current = readSelection();
      }, []);

      const openMenu = useCallback((menuId, triggerNode) => {
        triggerRef.current = triggerNode || null;
        rememberSelection();
        setActiveRow(0);
        setOpen({ kind: 'menu', id: menuId, rows: buildMenuRows(env, menuId) });
      }, [env, rememberSelection]);

      const toggleMenu = useCallback((menuId, triggerNode) => {
        if (open && open.kind === 'menu' && open.id === menuId) {
          close({ focusTrigger: true });
          return;
        }
        openMenu(menuId, triggerNode);
      }, [open, close, openMenu]);

      const toggleCompact = useCallback((triggerNode) => {
        if (open && open.kind === 'compact') {
          close({ focusTrigger: true });
          return;
        }
        triggerRef.current = triggerNode || null;
        rememberSelection();
        setActiveRow(0);
        setOpen({ kind: 'compact', rows: buildCompactRows(env) });
      }, [open, close, env, rememberSelection]);

      const focusRow = useCallback((index) => {
        setActiveRow(index);
        const node = itemRefs.current[index];
        if (node) node.focus({ preventScroll: true });
      }, []);

      const stepRow = useCallback((delta) => {
        const rows = open && open.rows;
        if (!rows || rows.length === 0) return;
        let index = activeRow;
        for (let step = 0; step < rows.length; step += 1) {
          index = (index + delta + rows.length) % rows.length;
          if (rows[index] && rows[index].kind === 'item') {
            focusRow(index);
            return;
          }
        }
      }, [open, activeRow, focusRow]);

      const jumpRow = useCallback((where) => {
        const rows = open && open.rows;
        if (!rows) return;
        if (where === 'first') {
          const first = rows.findIndex((row) => row.kind === 'item');
          if (first >= 0) focusRow(first);
          return;
        }
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (rows[index].kind === 'item') {
            focusRow(index);
            return;
          }
        }
      }, [open, focusRow]);

      const switchMenu = useCallback((delta) => {
        if (!open || open.kind !== 'menu') return;
        const currentIndex = MENUS.findIndex((menu) => menu.id === open.id);
        if (currentIndex < 0) return;
        const next = MENUS[(currentIndex + delta + MENUS.length) % MENUS.length];
        setActiveRow(0);
        setOpen({ kind: 'menu', id: next.id, rows: buildMenuRows(env, next.id) });
      }, [open, env]);

      const runRow = useCallback((row) => {
        if (!row || row.kind !== 'item' || row.disabled) return;
        const action = ACTIONS[row.actionId];
        if (!action) return;
        // The popup carries role=menu, which the shortcut layer reads as a
        // modal. Hide it for this synchronous dispatch so command-backed rows
        // are not blocked by their own menu.
        const popup = popupRef.current;
        const previousRole = popup ? popup.getAttribute('role') : null;
        if (popup) popup.setAttribute('role', 'presentation');
        let keepOpen = false;
        try {
          keepOpen = action.run(env) === 'panel-opened';
        } catch (error) {
          console.warn('[harness-chrome] menu action "' + row.actionId + '" failed:', error);
        } finally {
          if (popup) popup.setAttribute('role', previousRole || 'menu');
        }
        if (!keepOpen) close({ focusTrigger: true });
      }, [env, close]);

      const onPopupKeyDown = useCallback((event) => {
        if (!open) return;
        if (open.kind === 'panel') return;
        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault();
            stepRow(1);
            break;
          case 'ArrowUp':
            event.preventDefault();
            stepRow(-1);
            break;
          case 'Home':
            event.preventDefault();
            jumpRow('first');
            break;
          case 'End':
            event.preventDefault();
            jumpRow('last');
            break;
          case 'ArrowRight':
            event.preventDefault();
            switchMenu(1);
            break;
          case 'ArrowLeft':
            event.preventDefault();
            switchMenu(-1);
            break;
          case 'Enter':
          case ' ':
          case 'Spacebar': {
            event.preventDefault();
            const rows = open.rows || [];
            const row = rows[activeRow];
            if (row && row.kind === 'item') runRow(row);
            break;
          }
          case 'Tab':
            event.preventDefault();
            close({ focusTrigger: true });
            break;
          default:
            break;
        }
      }, [open, activeRow, stepRow, jumpRow, switchMenu, runRow, close]);

      const onTabKeyDown = useCallback((event, index) => {
        const bare = compact && index < 0;
        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (bare) toggleCompact(event.currentTarget);
          else {
            const menu = MENUS[index];
            if (menu) openMenu(menu.id, event.currentTarget);
          }
          return;
        }
        if (compact) return;
        const last = MENUS.length - 1;
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          tabRefs.current[index === last ? 0 : index + 1]?.focus();
          return;
        }
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          tabRefs.current[index === 0 ? last : index - 1]?.focus();
          return;
        }
        if (event.key === 'Home') {
          event.preventDefault();
          tabRefs.current[0]?.focus();
          return;
        }
        if (event.key === 'End') {
          event.preventDefault();
          tabRefs.current[last]?.focus();
        }
      }, [compact, openMenu, toggleCompact]);

      const renderRow = (row, index) => {
        if (row.kind === 'separator') {
          return h('div', { key: 'separator-' + index, className: 'hc-separator', role: 'separator' });
        }
        if (row.kind === 'section') {
          return h('div', { key: 'section-' + index, className: 'hc-section', role: 'presentation' }, row.label);
        }
        return h(
          'button',
          {
            key: 'item-' + index,
            ref: (node) => { itemRefs.current[index] = node; },
            type: 'button',
            role: 'menuitem',
            className: 'hc-item',
            tabIndex: index === activeRow ? 0 : -1,
            'aria-disabled': row.disabled ? 'true' : undefined,
            title: row.disabled ? row.disabledReason : undefined,
            onClick: () => runRow(row),
            onFocus: () => setActiveRow(index),
            onMouseEnter: () => setActiveRow(index),
          },
          h('span', { className: 'hc-item-label' }, row.label),
          row.keys && row.keys.length > 0
            ? h('span', { className: 'hc-item-keys', 'aria-hidden': 'true' },
              row.keys.map((key, keyIndex) => h('span', { key: 'key-' + keyIndex, className: 'hc-key' }, key)))
            : null,
        );
      };

      const renderShortcutPanel = () => {
        const rows = env.shortcutRows();
        return h(
          'div',
          {
            ref: (node) => { popupRef.current = node; panelRef.current = node; },
            className: 'hc-panel',
            role: 'group',
            'aria-label': 'Keyboard shortcuts',
            tabIndex: -1,
            onKeyDown: onPopupKeyDown,
          },
          h(
            'div',
            { className: 'hc-panel-head' },
            h('span', { className: 'hc-panel-title' }, 'Keyboard Shortcuts'),
            h('button', {
              type: 'button',
              className: 'hc-panel-close',
              'aria-label': 'Close',
              title: 'Close',
              onClick: () => close({ focusTrigger: true }),
            }, '\u00D7'),
          ),
          rows.length === 0
            ? h('p', { className: 'hc-panel-empty' }, 'No shortcut commands are registered in this build.')
            : h('div', { className: 'hc-panel-rows' },
              rows.map((row) => h(
                'div',
                { key: row.id, className: 'hc-panel-row' },
                h('span', { className: 'hc-panel-label' }, row.label),
                h('span', { className: 'hc-panel-keys' },
                  row.keys.map((key, keyIndex) => h('span', { key: 'key-' + keyIndex, className: 'hc-key' }, key))),
              ))),
          h(
            'div',
            { className: 'hc-panel-foot' },
            h('span', { className: 'hc-panel-note' }, 'The editable full reference lives in Settings \u203A General \u203A Keyboard shortcuts.'),
            env.canOpenSettings()
              ? h('button', {
                type: 'button',
                className: 'hc-panel-action',
                onClick: () => { env.openSettings(); close({ focusTrigger: true }); },
              }, 'Open Settings')
              : null,
          ),
        );
      };

      const renderAboutPanel = () => {
        const info = env.about();
        const rows = [
          { label: 'Version', value: info.version },
          { label: 'Commit', value: info.commit },
          { label: 'Runtime', value: info.runtime },
          { label: 'Platform', value: info.platform },
          { label: 'Header chrome', value: 'harness-chrome ' + PLUGIN_VERSION },
        ];
        return h(
          'div',
          {
            ref: (node) => { popupRef.current = node; panelRef.current = node; },
            className: 'hc-panel',
            role: 'group',
            'aria-label': 'About DeepSeek Harness',
            tabIndex: -1,
            onKeyDown: onPopupKeyDown,
          },
          h(
            'div',
            { className: 'hc-panel-head' },
            h('span', { className: 'hc-panel-title' }, 'About DeepSeek Harness'),
            h('button', {
              type: 'button',
              className: 'hc-panel-close',
              'aria-label': 'Close',
              title: 'Close',
              onClick: () => close({ focusTrigger: true }),
            }, '\u00D7'),
          ),
          h('div', { className: 'hc-panel-rows' },
            rows.map((row) => h(
              'div',
              { key: row.label, className: 'hc-panel-row' },
              h('span', { className: 'hc-panel-label' }, row.label),
              h('span', { className: 'hc-panel-value', title: row.value }, row.value),
            ))),
          h(
            'div',
            { className: 'hc-panel-foot' },
            h('span', { className: 'hc-panel-note' }, 'The Lamprey-style shell menu strip for this Harness.'),
            h('button', {
              type: 'button',
              className: 'hc-panel-action',
              onClick: () => {
                const lines = rows.map((row) => row.label + ': ' + row.value);
                void writeClipboard(lines.join('\n'));
              },
            }, 'Copy Details'),
          ),
        );
      };

      const renderPopup = () => {
        if (!open) return null;
        if (open.kind === 'panel') {
          return open.id === 'about' ? renderAboutPanel() : renderShortcutPanel();
        }
        const menu = open.kind === 'menu' ? MENUS.find((entry) => entry.id === open.id) : null;
        const label = menu ? menu.label + ' menu' : MENUBAR_LABEL;
        return h(
          'div',
          {
            ref: (node) => { popupRef.current = node; },
            className: 'hc-popup',
            'data-kind': open.kind,
            role: 'menu',
            'aria-label': label,
            onKeyDown: onPopupKeyDown,
          },
          (open.rows || []).map(renderRow),
        );
      };

      const renderTabs = () => {
        if (compact) {
          return h('button', {
            type: 'button',
            ref: (node) => { tabRefs.current[0] = node; },
            className: 'hc-tab hc-more',
            'aria-label': MENUBAR_LABEL,
            title: MENUBAR_LABEL,
            'aria-haspopup': 'menu',
            'aria-expanded': open ? 'true' : 'false',
            onPointerDown: captureSelectionAtPointerDown,
            onClick: (event) => toggleCompact(event.currentTarget),
            onKeyDown: (event) => onTabKeyDown(event, -1),
          }, '\u22EF');
        }
        return MENUS.map((menu, index) => h('button', {
          key: menu.id,
          type: 'button',
          ref: (node) => { tabRefs.current[index] = node; },
          className: 'hc-tab',
          'data-open': open && open.kind === 'menu' && open.id === menu.id ? 'true' : 'false',
          'aria-haspopup': 'menu',
          'aria-expanded': open && open.kind === 'menu' && open.id === menu.id ? 'true' : 'false',
          onPointerDown: captureSelectionAtPointerDown,
          onClick: (event) => toggleMenu(menu.id, event.currentTarget),
          onKeyDown: (event) => onTabKeyDown(event, index),
        }, menu.label));
      };

      return h(
        'div',
        {
          ref: rootRef,
          className: 'hc-root',
        },
        h('div', { className: 'hc-menubar', role: 'menubar', 'aria-label': MENUBAR_LABEL }, renderTabs()),
        renderPopup(),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Plugin body                                                         */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots'],
      apply(ctx) {
        if (typeof document === 'undefined') return;

        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.dataset.plugin = PLUGIN_ID;
          tag.dataset.pluginCss = PLUGIN_ID + '/chrome.css';
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => { tag.remove(); };
        }, 'harness-chrome: styles');

        ctx.effect(() => ctx.slots.inject('conversation.header.leading', () => ctx.slots.register(
          {
            name: 'conversation.header.leading',
            inject: () => ({ pluginCtx: ctx }),
          },
          MenuBar,
        )), 'harness-chrome: header menu tabs');
      },
    };
  },
});
