window.__ModuleLoader__.load({
  id: 'dsh-plugin-interactive-browser',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'interactive-browser';
    const TAB_ID = 'dsh-plugin-interactive-browser/tab';
    const KIND = 'interactive-browser';
    const PREFIX = '/ibrowser';

    const ZH = {
      title: '交互式浏览器',
      guide: '交互式浏览器',
      guideHint: '需要你登录或操作时，让真实浏览器出现在这里',
      reconnect: '重新连接',
      stop: '关闭浏览器',
      starting: '正在启动…',
      offline: '浏览器未运行',
      online: '已连接虚拟显示器',
      failed: '启动失败',
    };
    const EN = {
      title: 'Interactive browser',
      guide: 'Interactive browser',
      guideHint: 'A real browser in the panel, for sign-in and manual steps',
      reconnect: 'Reconnect',
      stop: 'Stop browser',
      starting: 'Starting…',
      offline: 'Browser is not running',
      online: 'Live virtual display',
      failed: 'Failed to start',
    };

    /** Address of the noVNC page this panel frames. */
    function panelSrc() {
      // `path` is resolved by noVNC as `new URL('./' + path, location.href)`, and the page
      // itself lives under PREFIX, so the websocket path must stay relative here.
      return PREFIX + '/vnc.html?autoconnect=1&resize=scale&reconnect=1&reconnect_delay=2000&path=websockify';
    }

    function readState() {
      return fetch(PREFIX + '/api/state', { credentials: 'same-origin' }).then((r) => r.json());
    }

    /** State-changing calls are POST so cross-site GETs cannot trigger them. */
    function post(path) {
      return fetch(PREFIX + path, { method: 'POST', credentials: 'same-origin' }).then((r) => r.json());
    }

    /** Panel body: a status line, two controls, and the remote framebuffer. */
    function BrowserPanel(props) {
      const t = props.t;
      const [nonce, setNonce] = React.useState(0);
      const [state, setState] = React.useState({ phase: 'starting', running: false });
      const [error, setError] = React.useState('');

      React.useEffect(() => {
        let cancelled = false;
        post('/api/start')
          .then((next) => { if (!cancelled) setState({ phase: next.running ? 'online' : 'offline', running: Boolean(next.running) }); })
          .catch((err) => { if (!cancelled) { setError(String(err && err.message ? err.message : err)); setState({ phase: 'failed', running: false }); } });
        return () => { cancelled = true; };
      }, [nonce]);

      const label = state.phase === 'online' ? t('online')
        : state.phase === 'failed' ? t('failed')
        : state.phase === 'offline' ? t('offline')
        : t('starting');

      const stop = () => {
        post('/api/stop').catch(() => {}).then(() => setState({ phase: 'offline', running: false }));
      };

      return h('div', {
        style: {
          display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
          background: 'var(--dsw-alias-bg-base, transparent)',
          color: 'var(--dsw-alias-text-primary, inherit)',
          font: 'inherit',
        },
      },
        h('div', {
          style: {
            display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
            borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.2))',
            fontSize: 12, flex: '0 0 auto',
          },
        },
          h('span', {
            'aria-hidden': true,
            style: {
              width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto',
              background: state.phase === 'online' ? 'var(--dsw-alias-accent, #2f9e64)'
                : state.phase === 'failed' ? 'var(--dsw-alias-danger, #c14343)'
                : 'var(--dsw-alias-text-tertiary, #999)',
            },
          }),
          h('span', { style: { opacity: 0.85 } }, label),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', onClick: () => setNonce((n) => n + 1), style: buttonStyle }, t('reconnect')),
          h('button', { type: 'button', onClick: stop, style: buttonStyle }, t('stop')),
        ),
        error ? h('div', { style: { padding: '6px 10px', fontSize: 12, color: 'var(--dsw-alias-danger, #c14343)' } }, error) : null,
        // The iframe is mounted only once the stack is up: noVNC returns 503
        // before that, and an iframe that already failed does not retry itself.
        state.phase === 'online'
          ? h('iframe', {
            key: nonce,
            title: t('title'),
            src: panelSrc(),
            allow: 'clipboard-read; clipboard-write',
            style: { flex: 1, width: '100%', minHeight: 0, border: 0, display: 'block', background: '#111' },
          })
          : h('div', {
            style: {
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, opacity: 0.6, background: '#111', color: '#ddd',
            },
          }, state.phase === 'failed' ? t('failed') : t('starting')),
      );
    }

    const buttonStyle = {
      font: 'inherit', fontSize: 12, padding: '2px 8px', cursor: 'pointer',
      borderRadius: 'var(--dsw-alias-radius-sm, 6px)',
      border: '1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,0.3))',
      background: 'transparent', color: 'inherit',
    };

    /** The tab chip's label. */
    function BrowserTitle(props) {
      return h('span', null, props.t('title'));
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'interactive-browser: zh');
        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'interactive-browser: en');
        const t = ctx.locale.bind(NS);

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: KIND,
          multiple: false,
          keepMounted: true,
          title: () => t('title'),
          guide: [
            { id: 'open', order: 10, title: () => t('guide'), description: () => t('guideHint') },
          ],
        }), 'interactive-browser: tab type');

        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS,
          inject: () => ({ t }),
        }, BrowserPanel));

        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS,
          inject: () => ({ t }),
        }, BrowserTitle));

        // Surfacing: the stack is started by the agent's tool, so poll its state
        // and open the tab once when it comes alive. Dismissal is remembered for
        // this page load only.
        // Surface the tab once per page load when the stack is already alive.
        // The poll stops after the first successful open: nothing else to watch.
        let timer;
        const tick = () => {
          if (document.visibilityState !== 'visible') return;
          readState()
            .then((state) => {
              if (!state?.running) return;
              if (!ctx.sidebarRight.mounted.getSnapshot()) return;
              ctx.sidebarRight.openTab(KIND, { revealIfOpened: true });
              clearInterval(timer);
              timer = undefined;
            })
            .catch(() => {});
        };
        timer = setInterval(tick, 3000);
        tick();
        ctx.effect(() => () => { if (timer !== undefined) clearInterval(timer); },
          'interactive-browser: surface poll');
      },
    };
  },
});
