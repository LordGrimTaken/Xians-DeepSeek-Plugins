/**
 * Client half of the Harness Deck bundle - a Lamprey-style right workspace deck.
 *
 * Registers six right-Sidebar page types with guide cards for surfaces the
 * shipped tabs do not cover, plus two boot-time behaviours:
 *
 *   Side chat        `ctx.uiWorkspace.forkSession` - a real branch action.
 *   Artifacts        session workspace path + deep link to the `files` tab.
 *   Review           honest turn-scoped review explainer; opens a page-type
 *                    review tab when one is registered, never a resource-only
 *                    address-driven one (whose body would reject the address).
 *   Plan             plan-mode state + todo checklist from public session
 *                    projections; toggles plan mode through the public `/plan`
 *                    command when reachable.
 *   Background tasks `ctx.jobs` roster (when the job controller is composed).
 *   Reasoning trace  live `useTrajectory` counts + switches the conversation to
 *                    the Trajectory view.
 *
 * Plain browser JavaScript: only `react` is required, no JSX, no imports, no npm
 * dependencies. All styling is one `data-plugin` style tag over theme tokens;
 * every selector is scoped by an `hd-` class.
 */
window.__ModuleLoader__.load({
  id: '@local/harness-deck',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect } = React;

    const PKG_ID = '@local/harness-deck';
    /** Right-column width target, matching the Lamprey reference (~350-380px). */
    const DECK_WIDTH = 384;
    /** Widths above this are the shipped 45%-of-window default worth nudging. */
    const WIDE_PANEL_THRESHOLD = 480;

    /* ================================================================== */
    /* Styles                                                              */
    /* ================================================================== */

    const CSS = `
/* Harness Deck - right workspace deck. Every selector carries an hd- class so
   nothing leaks into other surfaces. Theme tokens only; the mint alpha tints
   are the ones the build brief allows. */
.hd-root { box-sizing: border-box; }
.hd-page { display: flex; flex-direction: column; gap: 12px; box-sizing: border-box; height: 100%; overflow-y: auto; padding: 14px 14px 22px; color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); font-size: 12px; }
.hd-page-head { display: flex; gap: 12px; align-items: flex-start; }
.hd-page-icon { display: flex; flex: none; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 10px; background: rgb(78 229 155 / 8%); color: var(--dsw-alias-state-business-primary); }
.hd-page-heading { min-width: 0; padding-top: 1px; }
.hd-page-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.3; color: var(--dsw-alias-label-primary); }
.hd-page-sub { margin: 3px 0 0; font-size: 12px; line-height: 1.45; color: var(--dsw-alias-label-tertiary); }
.hd-page-body { display: flex; flex-direction: column; gap: 10px; }
.hd-section-label { margin-top: 4px; font-size: 11px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
.hd-card { display: flex; flex-direction: column; gap: 5px; padding: 11px 14px; background: var(--dsw-alias-bg-layer-2); border: 1px solid rgb(120 229 170 / 12%); border-radius: var(--dsw-radius-md, 12px); }
.hd-card-title { font-size: 13px; font-weight: 500; line-height: 1.35; color: var(--dsw-alias-label-primary); }
.hd-card-desc { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.hd-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.hd-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 6px 12px; border-radius: 8px; border: 1px solid rgb(120 229 170 / 24%); background: transparent; color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 12px; line-height: 1.2; cursor: pointer; }
.hd-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); border-color: rgb(78 229 155 / 40%); }
.hd-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.hd-btn:disabled { opacity: 0.45; cursor: default; }
.hd-btn[data-tone="primary"] { background: var(--dsw-alias-state-business-primary); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); font-weight: 500; }
.hd-btn[data-tone="primary"]:hover:not(:disabled) { background: var(--dsw-alias-state-business-primary); opacity: 0.9; }
.hd-status { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-3); border: 0.5px solid rgb(120 229 170 / 12%); font-size: 12px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
.hd-status[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.hd-status[data-tone="warn"] { color: var(--dsw-alias-state-warn-label); }
.hd-status[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.hd-mono { margin: 0; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.hd-note { margin: 0; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.hd-kv { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; }
.hd-kv-label { color: var(--dsw-alias-label-tertiary); }
.hd-kv-value { color: var(--dsw-alias-label-secondary); }
.hd-empty { display: flex; flex-direction: column; gap: 4px; padding: 14px; border: 1px dashed rgb(120 229 170 / 18%); border-radius: var(--dsw-radius-md, 12px); }
.hd-empty-title { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
.hd-empty-desc { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.hd-counts { display: flex; gap: 18px; padding: 2px 0; }
.hd-count { display: flex; flex-direction: column; gap: 1px; }
.hd-count-value { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.hd-count-label { font-size: 11px; letter-spacing: 0.04em; color: var(--dsw-alias-label-tertiary); }
/* Guide cards: one per deck page, rendered in the shipped guide's capsule cell. */
.hd-guide-card { display: flex; align-items: center; gap: 12px; box-sizing: border-box; width: 100%; padding: 12px 14px; text-align: left; font-family: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); border: 1px solid rgb(120 229 170 / 12%); border-radius: var(--dsw-radius-xl, 20px); cursor: pointer; }
@media (hover: hover) {
  .hd-guide-card:hover { background: var(--dsw-alias-interactive-bg-hover); border-color: rgb(78 229 155 / 22%); }
}
.hd-guide-card:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }
.hd-guide-icon { display: flex; flex: none; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 10px; background: rgb(78 229 155 / 8%); color: var(--dsw-alias-state-business-primary); }
.hd-guide-text { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.hd-guide-title { font-size: 13px; font-weight: 500; line-height: 1.35; color: var(--dsw-alias-label-primary); }
.hd-guide-desc { overflow: hidden; font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-tertiary); text-overflow: ellipsis; white-space: nowrap; }
.hd-guide-chevron { flex: none; font-size: 18px; line-height: 1; color: var(--dsw-alias-label-tertiary); }
/* Background tasks: one card per job. */
.hd-job { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; background: var(--dsw-alias-bg-layer-2); border: 1px solid rgb(120 229 170 / 12%); border-radius: var(--dsw-radius-md, 12px); }
.hd-job-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.hd-job-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.hd-job[data-status="running"] .hd-job-dot { background: var(--dsw-alias-state-success-primary); box-shadow: 0 0 6px rgb(78 229 155 / 55%); }
.hd-job[data-status="stopping"] .hd-job-dot, .hd-job[data-status="killed"] .hd-job-dot { background: var(--dsw-alias-state-warn-primary); }
.hd-job[data-status="failed"] .hd-job-dot { background: var(--dsw-alias-state-error-primary); }
.hd-job[data-status="completed"] .hd-job-dot { background: var(--dsw-alias-label-dimmed); }
.hd-job-label { flex: 1; min-width: 0; overflow: hidden; font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-primary); text-overflow: ellipsis; white-space: nowrap; }
.hd-job-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; padding-left: 15px; font-size: 11px; line-height: 1.4; color: var(--dsw-alias-label-tertiary); }
.hd-job-progress { color: var(--dsw-alias-label-secondary); }
.hd-stop { flex: none; padding: 3px 8px; border-radius: 6px; border: 1px solid rgb(120 229 170 / 24%); background: transparent; color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 11px; line-height: 1.2; cursor: pointer; }
.hd-stop:hover { background: var(--dsw-alias-interactive-bg-hover); }
.hd-stop[data-armed="true"] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-label); }
/* Plan checklist rows. */
.hd-todo { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; background: var(--dsw-alias-bg-layer-2); border: 1px solid rgb(120 229 170 / 12%); border-radius: var(--dsw-radius-md, 12px); }
.hd-todo-dot { flex: none; width: 7px; height: 7px; margin-top: 4px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.hd-todo[data-status="in_progress"] .hd-todo-dot { background: var(--dsw-alias-state-business-primary); box-shadow: 0 0 6px rgb(78 229 155 / 55%); }
.hd-todo[data-status="completed"] .hd-todo-dot { background: var(--dsw-alias-state-done-primary); }
.hd-todo-text { font-size: 12px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
.hd-todo[data-status="completed"] .hd-todo-text { color: var(--dsw-alias-label-tertiary); text-decoration: line-through; }
/* Reasoning trace: one row per recorded model request. */
.hd-trace-row { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: var(--dsw-alias-bg-layer-2); border: 1px solid rgb(120 229 170 / 12%); border-radius: var(--dsw-radius-md, 12px); }
.hd-trace-seq { flex: none; min-width: 44px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.hd-trace-main { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.hd-trace-kind { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.hd-trace-meta { overflow: hidden; font-size: 11px; color: var(--dsw-alias-label-tertiary); text-overflow: ellipsis; white-space: nowrap; }
.hd-trace-status { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.hd-trace-status[data-status="running"] { color: var(--dsw-alias-state-success-primary); }
.hd-trace-status[data-status="error"] { color: var(--dsw-alias-state-error-primary); }
`;

    /* ================================================================== */
    /* Icons (inline SVG, currentColor)                                    */
    /* ================================================================== */

    function glyph(props, children) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: props.size || 20,
          height: props.size || 20,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          className: props.className,
        },
        children,
      );
    }

    function IconSideChat(props) {
      return glyph(props, [
        h('path', { key: 'a', d: 'M4 6.2A2.2 2.2 0 0 1 6.2 4h7.1a2.2 2.2 0 0 1 2.2 2.2v4.4a2.2 2.2 0 0 1-2.2 2.2H8.4L4.6 16v-3.2z' }),
        h('path', { key: 'b', d: 'M19.9 9.6v4.2a2.2 2.2 0 0 1-2.2 2.2h-1.2' }),
      ]);
    }

    function IconArtifacts(props) {
      return glyph(props, [
        h('path', { key: 'a', d: 'M8.2 7.4V5.6c0-1 .8-1.8 1.8-1.8h7.4c1 0 1.8.8 1.8 1.8v8.2c0 1-.8 1.8-1.8 1.8h-1.9' }),
        h('rect', { key: 'b', x: 3.6, y: 8.2, width: 11.6, height: 11.6, rx: 1.9 }),
        h('path', { key: 'c', d: 'M7.2 12.2h4.4M7.2 15.4h6.4' }),
      ]);
    }

    function IconReview(props) {
      return glyph(props, [
        h('rect', { key: 'a', x: 3.8, y: 3.6, width: 12.4, height: 16.8, rx: 2 }),
        h('path', { key: 'b', d: 'M6.8 8.2h6.4M6.8 11.6h4.2' }),
        h('circle', { key: 'c', cx: 16.6, cy: 15.4, r: 2.8 }),
        h('path', { key: 'd', d: 'M18.7 17.5l2.2 2.2' }),
      ]);
    }

    function IconPlan(props) {
      return glyph(props, [
        h('path', { key: 'a', d: 'M3.4 6.4l1.3 1.3 2.1-2.3M10 6.4h10.6' }),
        h('path', { key: 'b', d: 'M3.4 12.1l1.3 1.3 2.1-2.3M10 12.1h10.6' }),
        h('path', { key: 'c', d: 'M10 17.8h7.4' }),
        h('circle', { key: 'd', cx: 5.1, cy: 17.8, r: 1.3 }),
      ]);
    }

    function IconBackgroundTasks(props) {
      return glyph(props, [h('path', { key: 'a', d: 'M3 12.2h3.6l2.4-6 4 12 2.5-6h5.5' })]);
    }

    function IconReasoningTrace(props) {
      return glyph(props, [
        h('circle', { key: 'a', cx: 5.2, cy: 12, r: 1.9 }),
        h('circle', { key: 'b', cx: 18, cy: 5.8, r: 1.9 }),
        h('circle', { key: 'c', cx: 18, cy: 18.2, r: 1.9 }),
        h('path', { key: 'd', d: 'M7.1 12h4.1M11.2 12l5.1-4.7M11.2 12l5.1 4.7' }),
      ]);
    }

    /* ================================================================== */
    /* Utilities                                                           */
    /* ================================================================== */

    const EMPTY_LIST = [];

    function statusLabel(status) {
      switch (status) {
        case 'running': return 'running';
        case 'stopping': return 'stopping';
        case 'completed': return 'completed';
        case 'killed': return 'stopped';
        case 'failed': return 'failed';
        default: return String(status);
      }
    }

    function formatDuration(milliseconds) {
      const total = Math.max(0, Math.round(Number(milliseconds) || 0));
      if (total < 1000) return total + 'ms';
      const seconds = total / 1000;
      if (seconds < 60) return (seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))) + 's';
      return Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's';
    }

    /** Subscribe a component to a bare observable source (getSnapshot/subscribe). */
    function useSnapshot(source) {
      const [value, setValue] = useState(function () {
        return source === null ? null : source.getSnapshot();
      });
      useEffect(
        function () {
          if (source === null) {
            setValue(null);
            return undefined;
          }
          let alive = true;
          const sync = function () {
            if (alive) setValue(source.getSnapshot());
          };
          sync();
          const unsubscribe = source.subscribe(sync);
          return function () {
            alive = false;
            if (typeof unsubscribe === 'function') unsubscribe();
          };
        },
        [source],
      );
      return value;
    }

    function isLiveJob(job) {
      return job.status === 'running' || job.status === 'stopping';
    }

    function orderedJobs(jobs) {
      return jobs.slice().sort(function (left, right) {
        const liveLeft = isLiveJob(left);
        const liveRight = isLiveJob(right);
        if (liveLeft !== liveRight) return liveLeft ? -1 : 1;
        if (liveLeft) return left.startedAt - right.startedAt;
        const finishedLeft = left.finishedAt === undefined ? left.startedAt : left.finishedAt;
        const finishedRight = right.finishedAt === undefined ? right.startedAt : right.finishedAt;
        return finishedRight - finishedLeft;
      });
    }

    /* ================================================================== */
    /* Presentation atoms                                                  */
    /* ================================================================== */

    function Status(props) {
      return h(
        'div',
        { className: 'hd-status', 'data-tone': props.tone || 'default', role: 'status' },
        h('span', null, props.text),
      );
    }

    function Card(props) {
      return h(
        'section',
        { className: 'hd-card' },
        h('div', { className: 'hd-card-title' }, props.title),
        props.desc === undefined ? null : h('p', { className: 'hd-card-desc' }, props.desc),
        props.children === undefined ? null : props.children,
      );
    }

    function Btn(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'hd-btn',
          'data-tone': props.tone || 'default',
          disabled: props.disabled === true,
          title: props.title,
          onClick: props.onClick,
        },
        props.label,
      );
    }

    function SectionLabel(props) {
      return h('div', { className: 'hd-section-label' }, props.text);
    }

    function Empty(props) {
      return h(
        'div',
        { className: 'hd-empty' },
        h('div', { className: 'hd-empty-title' }, props.title),
        h('div', { className: 'hd-empty-desc' }, props.desc),
      );
    }

    function Page(props) {
      const type = props.type;
      return h(
        'div',
        { className: 'hd-root hd-page', 'data-deck-page': type.kind },
        h(
          'header',
          { className: 'hd-page-head' },
          h('span', { className: 'hd-page-icon' }, h(type.icon, { size: 20 })),
          h(
            'div',
            { className: 'hd-page-heading' },
            h('h1', { className: 'hd-page-title' }, type.title),
            h('p', { className: 'hd-page-sub' }, type.subtitle),
          ),
        ),
        h('div', { className: 'hd-page-body' }, props.children),
      );
    }

    /* ================================================================== */
    /* Side chat page                                                      */
    /* ================================================================== */

    function SideChatBody(props) {
      const sessionId = props.sessionId;
      const deck = props.deck;
      const session = props.useSessions(function (snapshot) {
        return snapshot !== undefined && snapshot.byId !== undefined ? snapshot.byId[sessionId] : undefined;
      });
      const [phase, setPhase] = useState({ status: 'idle' });
      const blank = session !== undefined && session !== null && session.blank === true;

      const branch = function () {
        if (phase.status === 'working') return;
        setPhase({ status: 'working' });
        let pending = null;
        try {
          pending = deck.forkSession(sessionId);
        } catch (error) {
          setPhase({ status: 'unavailable' });
          return;
        }
        if (pending === null || pending === undefined || typeof pending.then !== 'function') {
          setPhase({ status: 'unavailable' });
          return;
        }
        pending.then(
          function (childId) {
            setPhase({ status: 'created', childId: String(childId) });
          },
          function (error) {
            const unavailable = Boolean(error)
              && error.name === 'SessionForkError'
              && Boolean(error.rpcError)
              && error.rpcError.code === 'session/fork-unavailable';
            setPhase({ status: 'failed', unavailable: unavailable });
          },
        );
      };

      return h(
        Page,
        { type: props.type },
        phase.status === 'created'
          ? h(
              Card,
              {
                title: 'Side chat created',
                desc: 'The branch is a separate session with its own queue and title. This conversation is untouched.',
              },
              h(
                'div',
                { className: 'hd-actions' },
                h(Btn, {
                  label: 'Open side chat',
                  tone: 'primary',
                  onClick: function () { deck.openSession(phase.childId); },
                }),
              ),
            )
          : null,
        phase.status === 'failed' && phase.unavailable === true
          ? h(Status, { tone: 'warn', text: 'This conversation cannot be branched yet. A side chat is cut from the latest completed turn, so finish the current turn and try again.' })
          : null,
        phase.status === 'failed' && phase.unavailable !== true
          ? h(Status, { tone: 'error', text: 'The branch could not be created. Check the connection and try again.' })
          : null,
        phase.status === 'unavailable'
          ? h(Status, { tone: 'warn', text: 'Branching needs the workspace navigation service, which is not available in this build.' })
          : null,
        blank
          ? h(Status, { tone: 'warn', text: 'This session is still blank. Send a message and let the turn complete before branching it.' })
          : null,
        h(
          Card,
          { key: 'create', title: 'Create a side chat', desc: 'Starts a new session from this conversation without moving your place here.' },
          h(
            'div',
            { className: 'hd-actions' },
            h(Btn, {
              label: phase.status === 'working' ? 'Branching...' : 'Create side chat',
              tone: 'primary',
              disabled: phase.status === 'working' || blank,
              onClick: branch,
            }),
          ),
        ),
        h(SectionLabel, { text: 'How it works' }),
        h(Card, { title: 'What the branch carries', desc: 'Messages up to the latest completed turn. The original session keeps its history, queue, and title unchanged.' }),
        h(Card, { title: 'What stays separate', desc: 'Everything after the branch: prompts, tool runs, and files. Each side chat is its own session in the workspace.' }),
        h(Card, { title: 'Where it appears', desc: 'In the workspace list beside this conversation, exactly like a forked session. There is no extra pane to manage.' }),
        h(
          'p',
          { className: 'hd-note' },
          session !== undefined && session !== null && session.displayTitle
            ? 'Current session: ' + String(session.displayTitle)
            : "Branching is also available from this session's workspace menu.",
        ),
      );
    }

    /* ================================================================== */
    /* Artifacts page                                                      */
    /* ================================================================== */

    function ArtifactsBody(props) {
      const sessionId = props.sessionId;
      const deck = props.deck;
      const session = props.useSessions(function (snapshot) {
        return snapshot !== undefined && snapshot.byId !== undefined ? snapshot.byId[sessionId] : undefined;
      });
      const cwd = session !== undefined && session !== null ? session.cwd : undefined;
      const filesReady = deck.hasTab('files');
      const [status, setStatus] = useState(null);

      const openFiles = function () {
        const opened = deck.openTab('files');
        setStatus(
          opened
            ? { tone: 'ok', text: 'Opened the Files tab in this sidebar.' }
            : { tone: 'warn', text: 'The Files tab is not available in this build.' },
        );
      };

      return h(
        Page,
        { type: props.type },
        status === null ? null : h(Status, status),
        h(SectionLabel, { text: 'Session workspace' }),
        h(
          Card,
          {
            title: 'Workspace root',
            desc: cwd === undefined || cwd === ''
              ? 'This session has no workspace directory attached; artifacts land wherever the session works.'
              : 'The directory this session works in. Produced and changed files are reachable under it.',
          },
          cwd === undefined || cwd === '' ? null : h('p', { className: 'hd-mono' }, cwd),
          h(
            'div',
            { className: 'hd-actions' },
            h(Btn, {
              label: filesReady ? 'Browse files' : 'Files tab unavailable',
              tone: 'primary',
              disabled: filesReady !== true,
              onClick: openFiles,
            }),
          ),
        ),
        h(SectionLabel, { text: 'Artifacts in this build' }),
        h(Card, { title: 'Files tab', desc: 'Browse the workspace tree, filter entries, and preview any file the session produced. It opens in this sidebar, beside the conversation.' }),
        h(Card, { title: 'Review tab', desc: "A turn's changed-files card opens the review tab with that turn's comparisons. The review page needs turn coordinates, so it cannot be deep-linked from here." }),
        h(Card, { title: 'Presented files', desc: 'A file the agent presents is posted in the transcript at the turn that produced it.' }),
        h(
          'p',
          { className: 'hd-note' },
          'This page shows where the session works and deep-links to the Files tab. A per-session artifact inventory is not exposed as a public client service yet, so nothing here is guessed.',
        ),
      );
    }

    /* ================================================================== */
    /* Review page                                                         */
    /* ================================================================== */

    /**
     * Kinds that may provide review content. The shipped `changes-review` and
     * experimental `forge-changes` types are address-driven resource viewers,
     * so they are only opened by their changed-files card; a future page-type
     * review kind is opened by kind here.
     */
    const REVIEW_KINDS = ['changes-review', 'forge-changes', 'review'];
    /** Kinds that may provide a plan preview page. The shipped `plan` type is address-driven. */
    const PLAN_KINDS = ['plan', 'plan-preview'];

    function ReviewBody(props) {
      const deck = props.deck;
      const pageKind = deck.openablePageKind(REVIEW_KINDS);
      const turnScoped = deck.hasTab('changes-review') || deck.hasTab('forge-changes');
      const filesReady = deck.hasTab('files');
      const [status, setStatus] = useState(null);
      const report = function (opened, ok, failed) {
        setStatus(opened ? { tone: 'ok', text: ok } : { tone: 'warn', text: failed });
      };
      const open = function () { report(deck.openTab(pageKind), 'Opened the Review tab in this sidebar.', 'The Review tab could not be opened.'); };
      const openFiles = function () { report(deck.openTab('files'), 'Opened the Files tab in this sidebar.', 'The Files tab is not available in this build.'); };
      return h(
        Page,
        { type: props.type },
        status === null ? null : h(Status, status),
        h(Card, { title: "Review a turn's changes", desc: "A review tab is minted from a turn's changed-files card, because its comparison needs that turn's start and end sequence; the deck cannot mint those coordinates, so this page never fabricates a diff." },
          h('div', { className: 'hd-actions' },
            h(Btn, { label: pageKind === null ? "Review opens from a turn's changed-files card" : 'Open Review tab', tone: 'primary', disabled: pageKind === null, onClick: open }),
            filesReady ? h(Btn, { label: 'Browse files', onClick: openFiles }) : null)),
        h(SectionLabel, { text: 'Where review lives' }),
        h(Card, { title: 'Changed-files card', desc: 'Under each turn that changed files, the transcript shows a changed-files card; picking a file opens the review tab for that turn.' }),
        h(Card, { title: 'Turn-scoped tab', desc: turnScoped ? 'This build registers a turn-scoped review tab type (changes-review or forge-changes). It is address-driven: the changed-files card supplies the address, not the deck.' : 'No review tab type is registered in this build; changed files still open as file previews.' }),
        h(Card, { title: 'What review shows', desc: "The selected file's turn-start and turn-end comparison, with the rest of the turn's changed files beside it." }),
        h('p', { className: 'hd-note' }, 'The deck does not invent staged or committed state: DSH review compares the files one turn changed, and staging or committing stays with the workspace tools.'),
      );
    }

    /* ================================================================== */
    /* Plan page                                                           */
    /* ================================================================== */

    /**
     * The live plan slice. A separate component keeps `useProjection` calls out
     * of the page body, so a build without that standard hook never calls it.
     */
    function PlanLive(props) {
      const deck = props.deck;
      const sessionId = props.sessionId;
      const useProjection = props.useProjection;
      const pageKind = props.pageKind;
      const planState = useProjection('plan');
      const todos = useProjection('todos');
      const [status, setStatus] = useState(null);
      const modeKnown = planState !== undefined && planState !== null;
      const active = modeKnown && planState.active === true;
      const settling = modeKnown && planState.pending === true;

      const togglePlanMode = function () {
        setStatus(null);
        const result = deck.runCommand(sessionId, active ? '/plan off' : '/plan');
        if (result === null || result === undefined || typeof result.then !== 'function') {
          setStatus({ tone: 'warn', text: 'The command service is not available in this build.' });
          return;
        }
        result.then(
          function (settled) {
            if (settled === undefined || settled === null || settled.ok !== true) {
              const code = settled !== undefined && settled !== null && settled.error !== undefined && settled.error.code !== undefined
                ? ' (' + String(settled.error.code) + ')'
                : '';
              setStatus({ tone: 'error', text: 'The plan command failed' + code + '.' });
              return;
            }
            if (settled.value === undefined) {
              setStatus({ tone: 'warn', text: 'The /plan command is not available in this build.' });
              return;
            }
            setStatus({ tone: 'ok', text: active ? 'Plan mode turned off.' : 'Plan mode turned on.' });
          },
          function () {
            setStatus({ tone: 'error', text: 'The plan command failed.' });
          },
        );
      };

      const items = Array.isArray(todos) ? todos : null;
      const modeDesc = !modeKnown
        ? 'Plan mode state is not available in this build.'
        : settling
          ? 'A /plan switch is settling.'
          : 'Planning guidance is ' + (active ? 'on' : 'off') + ' for this session.';

      return h(
        React.Fragment,
        null,
        status === null ? null : h(Status, status),
        h(Card, { title: 'Plan mode', desc: modeDesc },
          h('div', { className: 'hd-actions' },
            modeKnown ? h(Btn, { label: active ? 'Turn off plan mode' : 'Turn on plan mode', tone: 'primary', disabled: settling, onClick: togglePlanMode }) : null,
            pageKind === null ? null : h(Btn, { label: 'Open Plan preview', onClick: function () {
              const opened = deck.openTab(pageKind);
              setStatus(opened ? { tone: 'ok', text: 'Opened the Plan preview tab in this sidebar.' } : { tone: 'warn', text: 'The Plan preview tab could not be opened.' });
            } }))),
        h(SectionLabel, { text: 'Current checklist' }),
        items === null
          ? h(Card, { title: 'Checklist unavailable', desc: 'The todo projection is not available in this build.' })
          : items.length === 0
            ? h(Empty, { title: 'No checklist yet', desc: "The agent's todo list appears here after its first todo write. A submitted plan appears in the transcript as its own card." })
            : h('div', { className: 'hd-page-body' }, items.map(function (item, index) {
                return h('div', { key: String(index) + ':' + String(item.content), className: 'hd-todo', 'data-status': item.status },
                  h('span', { className: 'hd-todo-dot', 'aria-hidden': 'true' }),
                  h('span', { className: 'hd-todo-text' }, String(item.content)));
              })),
      );
    }

    function PlanBody(props) {
      const deck = props.deck;
      const pageKind = deck.openablePageKind(PLAN_KINDS);
      const useProjection = props.useProjection;
      return h(
        Page,
        { type: props.type },
        typeof useProjection === 'function'
          ? h(PlanLive, { deck: deck, sessionId: props.sessionId, pageKind: pageKind, useProjection: useProjection })
          : h(Card, { title: 'Plan data is not available', desc: 'The session projection hook is not available in this build, so plan mode and the checklist cannot be shown here.' }),
        h(SectionLabel, { text: 'How plan mode works' }),
        h(Card, { title: 'Plan mode', desc: '/plan switches planning guidance on; the agent plans, then exit_plan_mode presents the finished plan for your review.' }),
        h(Card, { title: 'Approving a plan', desc: 'A submitted plan card appears in the transcript with approve and reject controls. Approving leaves plan mode and starts execution.' }),
        h('p', { className: 'hd-note' }, 'The plan preview tab is address-driven: a submitted plan opens it from its transcript card. This page reads the live plan-mode projection and todo list instead of opening that preview by kind.'),
      );
    }

    /* ================================================================== */
    /* Background tasks page                                               */
    /* ================================================================== */

    function counter(label, value) {
      return h(
        'div',
        { key: 'count-' + label, className: 'hd-count' },
        h('span', { className: 'hd-count-value' }, String(value)),
        h('span', { className: 'hd-count-label' }, label),
      );
    }

    function BackgroundTasksBody(props) {
      const sessionId = props.sessionId;
      const deck = props.deck;
      const source = deck.jobsState();
      const snapshot = useSnapshot(source);
      const jobs = snapshot !== null && snapshot.rows !== undefined && snapshot.rows[sessionId] !== undefined
        ? snapshot.rows[sessionId]
        : EMPTY_LIST;
      const hasLive = jobs.some(isLiveJob);
      const [now, setNow] = useState(function () { return Date.now(); });
      const [armed, setArmed] = useState(null);
      const [killError, setKillError] = useState(null);

      // Keep this session's roster streaming while the page is mounted.
      useEffect(
        function () {
          const stop = deck.watchRows(sessionId);
          return function () {
            if (typeof stop === 'function') stop();
          };
        },
        [deck, sessionId],
      );

      // Only a live row has a moving duration.
      useEffect(
        function () {
          if (!hasLive) return undefined;
          const timer = setInterval(function () { setNow(Date.now()); }, 1000);
          return function () { clearInterval(timer); };
        },
        [hasLive],
      );

      // The two-press stop control disarms itself.
      useEffect(
        function () {
          if (armed === null) return undefined;
          const timer = setTimeout(function () { setArmed(null); }, 3000);
          return function () { clearTimeout(timer); };
        },
        [armed],
      );

      const requestStop = function (job) {
        const key = String(job.id);
        if (armed !== key) {
          setArmed(key);
          return;
        }
        setArmed(null);
        setKillError(null);
        const pending = deck.killJob(sessionId, key);
        if (pending === null || pending === undefined || typeof pending.then !== 'function') {
          setKillError('The stop request could not be sent.');
          return;
        }
        pending.then(
          function (ok) {
            if (!ok) setKillError('The stop request was refused by the job controller.');
          },
          function () {
            setKillError('The stop request failed. The job may still be running.');
          },
        );
      };

      const rows = orderedJobs(jobs);
      const liveCount = rows.filter(isLiveJob).length;
      const settledCount = rows.length - liveCount;

      return h(
        Page,
        { type: props.type },
        source === null
          ? h(Status, { tone: 'warn', text: 'The job controller is not available in this build, so background jobs cannot be listed here.' })
          : null,
        killError === null ? null : h(Status, { tone: 'error', text: killError }),
        source !== null && rows.length === 0
          ? h(Empty, {
              title: 'No background jobs',
              desc: 'Commands and workflows that run in the background appear here while they are live, and remain briefly after they settle.',
            })
          : null,
        source !== null && rows.length > 0
          ? h(
              'div',
              { className: 'hd-counts' },
              counter('Live', liveCount),
              counter('Settled', settledCount),
            )
          : null,
        source !== null && rows.length > 0
          ? h(
              'div',
              { className: 'hd-page-body' },
              rows.map(function (job) {
                const key = String(job.id);
                const elapsed = (job.finishedAt === undefined ? now : job.finishedAt) - job.startedAt;
                return h(
                  'div',
                  { key: key, className: 'hd-job', 'data-status': job.status },
                  h(
                    'div',
                    { className: 'hd-job-row' },
                    h('span', { className: 'hd-job-dot', 'aria-hidden': 'true' }),
                    h('span', { className: 'hd-job-label', title: job.label }, job.label),
                    job.status === 'running'
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'hd-stop',
                            'data-armed': armed === key ? 'true' : 'false',
                            title: armed === key ? 'Press again to stop this job' : 'Stop this background job',
                            onClick: function () { requestStop(job); },
                          },
                          armed === key ? 'Confirm stop' : 'Stop',
                        )
                      : null,
                  ),
                  h(
                    'div',
                    { className: 'hd-job-meta' },
                    h('span', { className: 'hd-job-kind' }, String(job.kind)),
                    h('span', null, statusLabel(job.status)),
                    job.progress === undefined ? null : h('span', { className: 'hd-job-progress' }, String(job.progress)),
                    h('span', null, formatDuration(elapsed)),
                    job.detail === undefined ? null : h('span', { title: String(job.detail) }, String(job.detail)),
                  ),
                );
              }),
            )
          : null,
        h(SectionLabel, { text: 'About this page' }),
        h(Card, { title: 'Agent-started background work', desc: 'Shell commands and workflows the agent sends to the background. The same roster backs the job list in the conversation header.' }),
        h(Card, { title: 'Stopping a job', desc: 'The stop control asks twice: the first press arms it, the second asks the job controller to cancel the job on your behalf.' }),
      );
    }

    /* ================================================================== */
    /* Reasoning trace page                                                */
    /* ================================================================== */

    function ReasoningTraceBody(props) {
      const deck = props.deck;
      const useTrajectory = props.useTrajectory;
      const [status, setStatus] = useState(null);

      const openTrajectory = function () {
        const outcome = deck.switchToTrajectory();
        if (outcome.ok) {
          setStatus({ tone: 'ok', text: 'Switched the conversation to the Trajectory view.' });
          return;
        }
        setStatus({
          tone: 'warn',
          text: outcome.reason === 'missing-strip'
            ? 'The conversation view tabs are not on screen right now. Open a session first.'
            : 'The Trajectory view is not visible in this layout. Open it from the conversation view tabs.',
        });
      };

      return h(
        Page,
        { type: props.type },
        status === null ? null : h(Status, status),
        h(
          Card,
          {
            title: 'Open the Trajectory view',
            desc: 'The conversation header carries one tab per registered view. This switches the main column to the trajectory ledger, where every request, tool call, and record is listed in order.',
          },
          h('div', { className: 'hd-actions' }, h(Btn, { label: 'Open Trajectory view', tone: 'primary', onClick: openTrajectory })),
        ),
        typeof useTrajectory === 'function'
          ? h(TrajectoryPanels, { useTrajectory: useTrajectory })
          : h(Card, {
              title: 'Trajectory data is not available',
              desc: 'The trajectory plugin is not composed into this build, so live stage counts cannot be shown. The recorded ledger is still available from the conversation view tabs when the view is registered.',
            }),
        h(SectionLabel, { text: 'What the trajectory shows' }),
        h(Card, { title: 'Every model request', desc: 'Turn and step, request purpose, and the status each request settled in.' }),
        h(Card, { title: 'Tool calls and results', desc: "Each call's arguments and the result the model received, in execution order." }),
        h(Card, { title: 'Context changes', desc: 'System prompts, compaction, and the tool catalog in force for each request.' }),
        h('p', { className: 'hd-note' }, 'Switching views changes the main column only; this sidebar and its tabs stay where they are.'),
      );
    }

    /**
     * The live trajectory slice. A separate component keeps the trajectory hook
     * calls out of the page body, so a build without the trajectory plugin
     * simply never mounts them.
     */
    function TrajectoryPanels(props) {
      const useTrajectory = props.useTrajectory;
      const requests = useTrajectory(function (snapshot) {
        return snapshot !== undefined && snapshot !== null && Array.isArray(snapshot.requests) ? snapshot.requests : EMPTY_LIST;
      });
      const running = useTrajectory(function (snapshot) {
        return snapshot !== undefined && snapshot !== null && Array.isArray(snapshot.runningCalls) ? snapshot.runningCalls : EMPTY_LIST;
      });
      const records = useTrajectory(function (snapshot) {
        return snapshot !== undefined && snapshot !== null && Array.isArray(snapshot.eventNodes) ? snapshot.eventNodes.length : 0;
      });
      const stages = requests.slice(-6).reverse();
      const liveStages = requests.filter(function (request) { return request.status === 'running'; }).length;

      return h(
        React.Fragment,
        null,
        h(SectionLabel, { text: 'Live from this session' }),
        h(
          'div',
          { className: 'hd-counts' },
          counter('Stages', requests.length),
          counter('Live', liveStages + running.length),
          counter('Records', records),
        ),
        stages.length === 0
          ? h(Empty, {
              title: 'No model stages recorded yet',
              desc: 'Requests appear here as the conversation runs; an empty session has an empty trajectory.',
            })
          : h(
              'div',
              { className: 'hd-page-body' },
              stages.map(function (request, index) {
                const isCompaction = request.purpose === 'compaction';
                const label = isCompaction ? 'Compaction' : 'Step ' + String(request.turn) + '.' + String(request.step);
                const elapsed = (request.completedAt === null || request.completedAt === undefined ? Date.now() : request.completedAt) - request.startedAt;
                const detail = request.error === undefined || request.error === null
                  ? formatDuration(elapsed)
                  : formatDuration(elapsed) + ' / ' + String(request.error).slice(0, 80);
                return h(
                  'div',
                  { key: String(request.startSeq) + ':' + String(index), className: 'hd-trace-row' },
                  h('span', { className: 'hd-trace-seq' }, label),
                  h(
                    'div',
                    { className: 'hd-trace-main' },
                    h('span', { className: 'hd-trace-kind' }, isCompaction ? 'Compaction request' : 'Model request'),
                    h('span', { className: 'hd-trace-meta', title: String(detail) }, detail),
                  ),
                  h('span', { className: 'hd-trace-status', 'data-status': request.status }, statusLabel(request.status)),
                );
              }),
            ),
      );
    }

    /* ================================================================== */
    /* Guide cards                                                         */
    /* ================================================================== */

    function makeGuideCard(type) {
      return function HarnessDeckGuideCard(props) {
        const info = props.useTabInfo();
        const open = function () {
          try {
            // A new page replaces the guide; the guide then closes itself, as
            // the shipped guide's own entry boxes do.
            info.tab.actions.openTab(type.kind, { replaceTab: true });
            info.tab.actions.close();
          } catch (error) {
            console.warn('[harness-deck] could not open ' + type.kind + ':', error);
          }
        };
        return h(
          'button',
          { type: 'button', className: 'hd-root hd-guide-card', 'data-deck-card': type.kind, title: type.description, onClick: open },
          h('span', { className: 'hd-guide-icon' }, h(type.icon, { size: 20 })),
          h(
            'span',
            { className: 'hd-guide-text' },
            h('span', { className: 'hd-guide-title' }, type.title),
            h('span', { className: 'hd-guide-desc' }, type.description),
          ),
          h('span', { className: 'hd-guide-chevron', 'aria-hidden': 'true' }, '\u203A'),
        );
      };
    }

    /* ================================================================== */
    /* Page type catalogue                                                 */
    /* ================================================================== */

    const TYPES = {
      sideChat: {
        id: PKG_ID + '/side-chat',
        kind: 'harness-side-chat',
        title: 'Side chat',
        description: 'Branch the current conversation.',
        subtitle: 'Branch this conversation into a parallel thread and keep working here.',
        order: 15,
        icon: IconSideChat,
        body: SideChatBody,
      },
      artifacts: {
        id: PKG_ID + '/artifacts',
        kind: 'harness-artifacts',
        title: 'Artifacts',
        description: 'Files produced in this session.',
        subtitle: 'Where this session works, and the doors to the files it produced.',
        order: 35,
        icon: IconArtifacts,
        body: ArtifactsBody,
      },
      review: {
        id: PKG_ID + '/review',
        kind: 'harness-review',
        title: 'Review',
        description: 'Turn diffs and changed files.',
        subtitle: "Review a turn's changed files from the transcript card that carries its coordinates.",
        order: 40,
        icon: IconReview,
        body: ReviewBody,
      },
      plan: {
        id: PKG_ID + '/plan',
        kind: 'harness-plan',
        title: 'Plan',
        description: 'Plan goals, checklist, approve steps.',
        subtitle: "Plan-mode state and the current checklist, read from this session's projections.",
        order: 45,
        icon: IconPlan,
        body: PlanBody,
      },
      tasks: {
        id: PKG_ID + '/background-tasks',
        kind: 'harness-background-tasks',
        title: 'Background tasks',
        description: 'Live background jobs and output.',
        subtitle: 'Live background jobs this session can see, streamed from the job controller.',
        order: 80,
        icon: IconBackgroundTasks,
        body: BackgroundTasksBody,
      },
      reasoning: {
        id: PKG_ID + '/reasoning-trace',
        kind: 'harness-reasoning-trace',
        title: 'Reasoning trace',
        description: 'Per-stage reasoning and tool calls.',
        subtitle: 'Per-stage reasoning: what the model saw, which tools ran, and how each step was assembled.',
        order: 90,
        icon: IconReasoningTrace,
        body: ReasoningTraceBody,
      },
    };

    const ALL_TYPES = [TYPES.sideChat, TYPES.artifacts, TYPES.review, TYPES.plan, TYPES.tasks, TYPES.reasoning];

    /* ================================================================== */
    /* Boot-time behaviours                                                */
    /* ================================================================== */

    /** One auto-open per page load; a manual collapse afterwards is respected. */
    let deckAutoOpened = false;
    /** One width nudge per page load. */
    let deckWidthNudged = false;

    /**
     * Move the right column from the shipped 45%-of-window default toward the
     * Lamprey reference width (~384px) with one synthetic drag on the frame's
     * right resize handle. There is no public width API, so this drives the
     * real pointer handlers; it runs at most once per page load, never in
     * fullscreen, and restores the three prototype methods it shims.
     */
    function nudgeRightPanelWidth() {
      if (deckWidthNudged) return;
      if (typeof document === 'undefined' || typeof PointerEvent !== 'function') return;
      const frame = document.querySelector('[class*="_frame"]');
      const handle = document.querySelector('[class*="_handle"][data-side="rightbar"]');
      if (!frame || !handle) return;
      if (frame.hasAttribute('data-rightbar-fullscreen')) return;
      const before = frame.getAttribute('style') || '';
      const match = /minmax\(0px,\s*(\d+)px\)/.exec(before);
      if (!match) return;
      const current = Number(match[1]);
      // A persisted or already-nudged width is left alone; 480 is above the
      // widest sensible deck and below the 45%-of-window default on desk displays.
      if (!(current > WIDE_PANEL_THRESHOLD)) {
        deckWidthNudged = true;
        return;
      }
      const target = DECK_WIDTH;
      const proto = Element.prototype;
      const saved = {
        set: proto.setPointerCapture,
        rel: proto.releasePointerCapture,
        has: proto.hasPointerCapture,
      };
      // The handle calls pointer capture on a real pointer id; a synthetic
      // PointerEvent has none, so the three calls are stubbed for this gesture.
      proto.setPointerCapture = function () {};
      proto.releasePointerCapture = function () {};
      proto.hasPointerCapture = function () { return true; };
      try {
        const rect = handle.getBoundingClientRect();
        const y = Math.round(rect.height / 2);
        const x = rect.left + rect.width / 2;
        const make = function (type, clientX, buttons) {
          return new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: clientX,
            clientY: y,
            button: 0,
            buttons: buttons,
            pointerId: 91,
            isPrimary: true,
            pointerType: 'mouse',
          });
        };
        handle.dispatchEvent(make('pointerdown', x, 1));
        handle.dispatchEvent(make('pointermove', x + (current - target), 1));
        handle.dispatchEvent(make('pointerup', x + (current - target), 0));
        deckWidthNudged = true;
      } finally {
        proto.setPointerCapture = saved.set;
        proto.releasePointerCapture = saved.rel;
        proto.hasPointerCapture = saved.has;
      }
    }

    /* ================================================================== */
    /* Plugin                                                              */
    /* ================================================================== */

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        /* ---- styles ------------------------------------------------- */
        ctx.effect(
          function () {
            const tag = document.createElement('style');
            tag.dataset.plugin = PKG_ID;
            tag.dataset.pluginCss = PKG_ID + '/styles.css';
            tag.textContent = CSS;
            document.head.appendChild(tag);
            return function () { tag.remove(); };
          },
          'harness-deck: styles',
        );

        /* ---- services/actions the pages share ----------------------- */
        const service = function (name) {
          try {
            return ctx.get(name);
          } catch (error) {
            return undefined;
          }
        };

        const deck = {
          /** Branch one session; null when the workspace navigation service is absent. */
          forkSession: function (sessionId) {
            const workspace = service('uiWorkspace');
            return workspace === undefined || workspace === null ? null : workspace.forkSession(sessionId);
          },
          /** Reveal a session in the main column. */
          openSession: function (sessionId) {
            const workspace = service('uiWorkspace');
            if (workspace === undefined || workspace === null) return;
            try {
              workspace.openSession(sessionId);
            } catch (error) {
              console.warn('[harness-deck] could not open session:', error);
            }
          },
          /** Whether a page kind has a registered type in this build. */
          hasTab: function (kind) {
            try {
              return ctx.sidebarRightTabs.get(kind) !== undefined;
            } catch (error) {
              return false;
            }
          },
          /** Open one sidebar page; false when nothing can open it. */
          openTab: function (kind) {
            try {
              ctx.sidebarRight.openTab(kind);
              return true;
            } catch (error) {
              console.warn('[harness-deck] could not open tab "' + kind + '":', error);
              return false;
            }
          },
          /**
           * First candidate kind registered as a PAGE type, else null. A
           * resource viewer declares `patterns` and can only open a real
           * resource address; opening it by kind would mint a page address its
           * body rejects, so those are not offered as page buttons.
           */
          openablePageKind: function (candidates) {
            for (let index = 0; index < candidates.length; index += 1) {
              const kind = candidates[index];
              let definition;
              try {
                definition = ctx.sidebarRightTabs.get(kind);
              } catch (error) {
                definition = undefined;
              }
              if (definition === undefined || definition === null) continue;
              const patterns = definition.patterns;
              if (!Array.isArray(patterns) || patterns.length === 0) return kind;
            }
            return null;
          },
          /** Run one slash command through the public command Remote; null when unavailable. */
          runCommand: function (sessionId, command) {
            let commands;
            try {
              commands = service('remote.commands');
            } catch (error) {
              commands = undefined;
            }
            if (commands === undefined || commands === null) {
              const remote = service('remote');
              commands = remote === undefined || remote === null ? undefined : remote.commands;
            }
            if (commands === undefined || commands === null || typeof commands.execute !== 'function') return null;
            try {
              return commands.execute(sessionId, command, []);
            } catch (error) {
              console.warn('[harness-deck] command "' + command + '" failed:', error);
              return null;
            }
          },
          /** The job controller's bare roster source, or null when it is not composed. */
          jobsState: function () {
            const jobs = service('jobs');
            return jobs === undefined || jobs === null ? null : jobs.state;
          },
          /** Keep one session's job roster streaming while the page is mounted. */
          watchRows: function (sessionId) {
            const jobs = service('jobs');
            if (jobs === undefined || jobs === null) return function () {};
            try {
              return jobs.watchRows(sessionId);
            } catch (error) {
              console.warn('[harness-deck] could not watch jobs:', error);
              return function () {};
            }
          },
          /** Ask the job controller to stop one job; resolves whether it was admitted. */
          killJob: function (sessionId, jobId) {
            const jobs = service('jobs');
            if (jobs === undefined || jobs === null) return null;
            let pending = null;
            try {
              pending = jobs.kill(sessionId, jobId);
            } catch (error) {
              return null;
            }
            return pending.then(function (result) {
              return Boolean(result) && result.ok === true;
            });
          },
          /**
           * Switch the main column to the Trajectory view by pressing its view
           * tab. No public command/service switches a conversation view, so this
           * uses the view strip's real control.
           */
          switchToTrajectory: function () {
            if (typeof document === 'undefined') return { ok: false, reason: 'no-document' };
            const strip = document.querySelector('[data-conversation-tabs]');
            if (strip === null) return { ok: false, reason: 'missing-strip' };
            const buttons = strip.querySelectorAll('button[role="tab"]');
            for (let index = 0; index < buttons.length; index += 1) {
              const button = buttons[index];
              const label = String(button.textContent || '').trim().toLowerCase();
              if (label === 'trajectory' || label.indexOf('trajectory') !== -1) {
                button.click();
                return { ok: true };
              }
            }
            return { ok: false, reason: 'missing-tab' };
          },
        };

        /* ---- tab types (stage one) --------------------------------- */
        ALL_TYPES.forEach(function (type) {
          ctx.effect(
            function () {
              return ctx.sidebarRightTabs.register({
                id: type.id,
                kind: type.kind,
                priority: 'extension',
                title: function () { return type.title; },
                guide: [{
                  id: 'card',
                  order: type.order,
                  title: function () { return type.title; },
                  description: function () { return type.description; },
                  icon: type.icon,
                }],
              });
            },
            'harness-deck: type ' + type.kind,
          );
        });

        /* ---- page bodies (stage two) ------------------------------- */
        ALL_TYPES.forEach(function (type) {
          ctx.effect(
            function () {
              return ctx.slots.inject('sidebar.right.pane.tab', function () {
                return ctx.slots.register(
                  {
                    name: 'sidebar.right.pane.tab',
                    key: type.id,
                    inject: function () {
                      return { deck: deck, type: type };
                    },
                  },
                  type.body,
                );
              });
            },
            'harness-deck: page ' + type.kind,
          );
        });

        /* ---- richer guide cards ------------------------------------ */
        ALL_TYPES.forEach(function (type) {
          ctx.effect(
            function () {
              return ctx.slots.inject('sidebar.right.tab.guide.entry', function () {
                return ctx.slots.register(
                  { name: 'sidebar.right.tab.guide.entry', key: type.id },
                  makeGuideCard(type),
                );
              });
            },
            'harness-deck: guide card ' + type.kind,
          );
        });

        /* ---- auto-open the right column once per boot -------------- */
        ctx.effect(
          function () {
            let disposed = false;
            let attempts = 0;
            let timer = null;
            let nudgeTimer = null;
            const attempt = function () {
              if (disposed || deckAutoOpened) return;
              let mountedId;
              try {
                mountedId = ctx.sidebarRight.mounted.getSnapshot();
              } catch (error) {
                return;
              }
              if (mountedId === undefined || mountedId === null) return;
              try {
                if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded();
                deckAutoOpened = true;
              } catch (error) {
                // The Session's surface store is minted with its first render;
                // the retry below runs again once it exists.
                return;
              }
              // A session shown long after the boot retry window still gets
              // the one-time width nudge (the function itself runs once).
              nudgeTimer = setTimeout(function () {
                nudgeTimer = null;
                if (disposed) return;
                try {
                  nudgeRightPanelWidth();
                } catch (nudgeError) {
                  console.warn('[harness-deck] right panel width nudge failed:', nudgeError);
                }
              }, 250);
            };
            let unsubscribe = function () {};
            try {
              unsubscribe = ctx.sidebarRight.mounted.subscribe(attempt);
            } catch (error) {
              unsubscribe = function () {};
            }
            attempt();
            // A short bounded retry covers the store-minting race; the
            // subscription above still catches a session shown much later.
            timer = setInterval(function () {
              attempts += 1;
              attempt();
              if (deckAutoOpened || attempts > 40) {
                clearInterval(timer);
                timer = null;
              }
            }, 250);
            return function () {
              disposed = true;
              if (timer !== null) clearInterval(timer);
              if (nudgeTimer !== null) clearTimeout(nudgeTimer);
              try {
                unsubscribe();
              } catch (error) {
                /* already disposed */
              }
            };
          },
          'harness-deck: auto-open right sidebar',
        );

        /* ---- one-time width nudge toward the reference -------------- */
        ctx.effect(
          function () {
            let disposed = false;
            let tries = 0;
            let timer = null;
            const attempt = function () {
              if (disposed || deckWidthNudged) return;
              try {
                nudgeRightPanelWidth();
              } catch (error) {
                console.warn('[harness-deck] right panel width nudge failed:', error);
                deckWidthNudged = true;
                return;
              }
              tries += 1;
              if (deckWidthNudged || tries >= 8) return;
              timer = setTimeout(attempt, tries < 3 ? 800 : 1600);
            };
            timer = setTimeout(attempt, 800);
            return function () {
              disposed = true;
              if (timer !== null) clearTimeout(timer);
            };
          },
          'harness-deck: right panel width',
        );
      },
    };
  },
});
