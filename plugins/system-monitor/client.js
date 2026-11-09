/**
 * Client half of the system-monitor bundle.
 *
 * Two placements share one poller hook:
 *  - `conversation.composer.dock` (order 2): a compact pill next to the core activity/usage pills under the composer,
 *    i.e. the row that already shows turns/steps/tok/s and token totals · cache hit.
 *  - `sidebar.footer.action`: the persistent footer readout (full figures when wide, CPU % in the 56 px rail).
 *
 * Polls the Host route `system-monitor` (relative URL = same origin as the page) every 3 s, less often while the page
 * is hidden, and refreshes immediately on click.
 */
window.__ModuleLoader__.load({
  id: '@local/system-monitor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const REFRESH_MS = 3000;
    const HIDDEN_REFRESH_MS = 15000;

    const round = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null);

    function formatPercent(value) {
      const rounded = round(value);
      return rounded === null ? '—' : `${rounded}%`;
    }

    function formatBytes(bytes, unit) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
      if (unit === 'GiB') return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
      if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
      return `${Math.round(bytes / 1024)} KB`;
    }

    function formatUptime(seconds) {
      const value = round(seconds);
      if (value === null || value < 0) return '—';
      const days = Math.floor(value / 86400);
      const hours = Math.floor((value % 86400) / 3600);
      const minutes = Math.floor((value % 3600) / 60);
      if (days > 0) return `${days}d ${hours}h`;
      if (hours > 0) return `${hours}h ${minutes}m`;
      return `${minutes}m`;
    }

    function percentTone(value) {
      if (value === null) return 'var(--dsw-alias-label-tertiary, #7c8f86)';
      if (value >= 90) return 'var(--dsw-alias-state-error-primary, #e5484d)';
      if (value >= 75) return '#e5b650';
      return 'var(--dsw-alias-state-success-primary, #4ee59b)';
    }

    function describe(stats) {
      const cpu = stats.cpu || {};
      const memory = stats.memory || {};
      const parts = [
        `CPU ${formatPercent(cpu.percent)}${typeof cpu.cores === 'number' ? ` · ${cpu.cores} cores` : ''}`,
        `RAM ${formatBytes(memory.usedBytes, 'GiB')} / ${formatBytes(memory.totalBytes, 'GiB')} (${formatPercent(memory.usedPercent)})`,
        `Harness app RSS ${formatBytes(memory.processRssBytes, 'MB')}`,
        `System uptime ${formatUptime(stats.uptimeSeconds)}`,
      ];
      const load = Array.isArray(cpu.loadavg) ? cpu.loadavg[0] : null;
      if (typeof load === 'number' && load > 0) parts.splice(1, 0, `load ${load.toFixed(2)}`);
      return parts.join(' · ');
    }

    /** Poll the host route; each mounted placement owns one poller. Returns { stats, stale, refresh }. */
    function useSystemStats() {
      const [stats, setStats] = React.useState(null);
      const [stale, setStale] = React.useState(false);
      const [attempt, setAttempt] = React.useState(0);

      React.useEffect(() => {
        let alive = true;
        let timer = null;

        const tick = async () => {
          timer = null;
          try {
            const response = await fetch('system-monitor', {
              cache: 'no-store',
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const next = await response.json();
            if (!alive) return;
            setStats(next);
            setStale(false);
          } catch {
            if (alive) setStale(true);
          }
          if (alive) schedule();
        };

        const schedule = () => {
          if (!alive) return;
          timer = window.setTimeout(tick, document.hidden ? HIDDEN_REFRESH_MS : REFRESH_MS);
        };

        const onVisibility = () => {
          if (document.hidden || !alive) return;
          if (timer) window.clearTimeout(timer);
          tick();
        };

        tick();
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
          alive = false;
          if (timer) window.clearTimeout(timer);
          document.removeEventListener('visibilitychange', onVisibility);
        };
      }, [attempt]);

      return { stats, stale, refresh: () => setAttempt((value) => value + 1) };
    }

    function gaugeIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { flex: '0 0 auto' } },
        h('path', { d: 'M4 14a8 8 0 0 1 16 0', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', { d: 'M12 14l3.6-4.2', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('circle', { cx: 12, cy: 14, r: 1.6, fill: 'currentColor' }),
      );
    }

    /** Compact composer-dock pill: shaped like the core StatsPills row (same padding, gap, tabular numerals). */
    function SystemMonitorPill() {
      const { stats, stale, refresh } = useSystemStats();
      if (stats === null) return null;
      const cpu = stats.cpu || {};
      const memory = stats.memory || {};
      const cpuPercent = typeof cpu.percent === 'number' ? cpu.percent : null;
      const memPercent = typeof memory.usedPercent === 'number' ? memory.usedPercent : null;
      const tone = percentTone(Math.max(cpuPercent ?? 0, memPercent ?? 0));
      const label = `CPU ${formatPercent(cpuPercent)} · RAM ${formatPercent(memPercent)}`;
      const details = describe(stats) + (stale ? ' · reconnecting' : '');

      return h(
        'button',
        {
          type: 'button',
          'data-system-monitor-pill': 'true',
          'data-stale': stale ? 'true' : 'false',
          'aria-label': `System monitor: ${details}. Click to refresh.`,
          title: details,
          onClick: refresh,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            maxWidth: '100%',
            padding: '1px 8px',
            border: 'none',
            borderRadius: 'var(--dsw-radius-sm, 6px)',
            background: 'transparent',
            color: stale ? 'var(--dsw-alias-label-dimmed, #7c8f86)' : 'var(--dsw-alias-label-tertiary, #9fb2a8)',
            font: 'inherit',
            fontSize: 11,
            lineHeight: 'inherit',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            cursor: 'pointer',
            overflow: 'hidden',
          },
        },
        gaugeIcon(),
        h('span', { style: { width: 6, height: 6, flex: '0 0 auto', borderRadius: 999, background: tone, opacity: stale ? 0.4 : 1 } }),
        h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
      );
    }

    /** Sidebar footer readout: full figures in a wide sidebar, CPU % in the 56 px rail. */
    function SystemMonitorFooter(props) {
      const wide = props.wide !== false;
      const { stats, stale, refresh } = useSystemStats();
      if (stats === null) return null;
      const cpu = stats.cpu || {};
      const memory = stats.memory || {};
      const cpuPercent = typeof cpu.percent === 'number' ? cpu.percent : null;
      const memPercent = typeof memory.usedPercent === 'number' ? memory.usedPercent : null;
      const tone = percentTone(Math.max(cpuPercent ?? 0, memPercent ?? 0));
      // Wide footers have room for both figures; the 56 px rail keeps only the CPU percentage
      // (36 px of usable width after the sidebar's padding) with the rest in the tooltip.
      const text = wide
        ? `CPU ${formatPercent(cpuPercent)} · RAM ${formatPercent(memPercent)}`
        : formatPercent(cpuPercent);
      const label = describe(stats) + (stale ? ' · reconnecting' : '');

      return h(
        'button',
        {
          type: 'button',
          'data-system-monitor': 'true',
          'data-stale': stale ? 'true' : 'false',
          'aria-label': `System monitor: ${label}. Click to refresh.`,
          title: label,
          onClick: refresh,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: wide ? 6 : 4,
            maxWidth: '100%',
            height: 28,
            padding: wide ? '0 8px' : '0 3px',
            margin: 0,
            border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))',
            borderRadius: 'var(--dsw-radius-sm, 6px)',
            background: 'transparent',
            color: stale ? 'var(--dsw-alias-label-tertiary, #7c8f86)' : 'var(--dsw-alias-label-secondary, #c9d6cf)',
            fontFamily: 'var(--ds-font-family-code, var(--dsw-font-family, monospace))',
            fontSize: wide ? 11 : 9,
            lineHeight: 1,
            letterSpacing: '0.02em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            cursor: 'pointer',
          },
        },
        h('span', {
          'aria-hidden': 'true',
          style: {
            width: 6,
            height: 6,
            flex: '0 0 auto',
            borderRadius: 999,
            background: tone,
            boxShadow: `0 0 6px ${tone}`,
            opacity: stale ? 0.4 : 1,
          },
        }),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, text),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Next to the core activity/usage pills under the composer: the same row as the token statistics.
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'system-monitor',
              order: 2,
            },
            SystemMonitorPill,
          ),
        );
        // Persistent readout in the sidebar footer.
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'system-monitor',
              order: 10,
            },
            SystemMonitorFooter,
          ),
        );
      },
    };
  },
});
