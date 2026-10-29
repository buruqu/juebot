window.__ModuleLoader__.load({
  id: '@local/dsh-juebot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'juebot';
    const NAMESPACE = 'juebot';
    const STATUS_URL = 'api/juebot/status';
    const REQUEST_TIMEOUT_MS = 8000;

    // Plain data, deliberately inline: no runtime JSON or Harness UI imports.
    const DICTIONARIES = {
      "zh": {
        "nav": "juebot",
        "page.title": "juebot",
        "page.subtitle": "只读管理 · Host 诊断与接入前置",
        "action.refresh": "刷新状态",
        "action.refreshing": "正在读取…",
        "action.back": "返回对话",
        "host.title": "Host 诊断事实",
        "host.description": "这些结果来自当前控制面的 Host 激活时探测。刷新只读取同一份快照，不会重新探测或打开业务数据库。",
        "snapshot.waiting": "尚未取得 Host 快照",
        "snapshot.loading": "正在读取 Host 快照",
        "snapshot.ready": "Host 诊断检查通过",
        "snapshot.issues": "Host 已返回诊断结果，存在未通过或未执行项",
        "snapshot.retained": "正在展示先前取得的 Host 激活快照",
        "snapshot.stale": "读取失败：下方保留的是旧快照，不能视为最新状态。",
        "snapshot.refreshingOld": "正在刷新：下方暂留旧快照，尚未确认读取成功。",
        "snapshot.unknown": "未知 / 未取得",
        "error.network": "状态服务不可用。未推断 Host 或业务能力正在运行。",
        "error.http": "状态读取未成功；服务可能尚未就绪或当前访问未获准。",
        "error.invalid": "状态响应不符合约定，已拒绝作为诊断事实展示。",
        "error.timeout": "状态读取超时。可以稍后再次刷新。",
        "fact.version": "控制面版本",
        "fact.node": "Host Node",
        "fact.platform": "Host 平台",
        "fact.architecture": "Host 架构",
        "fact.sqlite": "Host SQLite",
        "fact.captured": "Host 激活时取样（UTC）",
        "fact.sqliteMissing": "未取得 SQLite 版本",
        "check.title": "Host 内存诊断检查",
        "check.driver": "SQLite 驱动",
        "check.schema": "诊断 schema",
        "check.fts5": "FTS5",
        "check.shortQuery": "中文短词回退",
        "check.privacy": "合成权限隔离反例",
        "check.cleanup": "诊断资源清理",
        "check.ok": "通过",
        "check.unavailable": "不可用",
        "check.error": "未通过",
        "check.notRun": "未执行",
        "check.notNeeded": "无需清理",
        "check.limitation": "内存合成诊断不等于持久存储、真实聊天隐私、生产规模或崩溃恢复已验收。",
        "probe.moduleUnavailable": "当前 Host 无法使用 Node 内置 SQLite。",
        "probe.openFailed": "Host 未能打开诊断数据库。",
        "probe.schemaFailed": "诊断 schema 或检索检查未通过。",
        "probe.roundtripFailed": "合成数据往返或权限隔离检查未通过。",
        "probe.cleanupFailed": "诊断资源清理未通过。",
        "boundary.title": "能力边界：本控制面不启动业务",
        "boundary.description": "以下是 Host 返回的默认声明及本控制面的行为范围，不是整个 Loader 的实时启停清单。此页面没有业务配置或执行入口。",
        "boundary.backendLabel": "存储后端默认",
        "boundary.backendValue": "声明为默认禁用；不代表其他 Loader 行的当前状态",
        "boundary.storageLabel": "持久数据库",
        "boundary.storageValue": "本控制面不打开持久数据库",
        "boundary.qqLabel": "QQ / SnowLuma",
        "boundary.qqValue": "本控制面未连接",
        "boundary.modelsLabel": "模型服务",
        "boundary.modelsValue": "本控制面未连接",
        "boundary.codeLabel": "Code 执行链路",
        "boundary.codeValue": "本控制面未连接",
        "pending.title": "待确认前置",
        "pending.description": "这些事项仍需独立确认或验收；看到本页或诊断通过不会授予数据、模型、QQ 或 Code 权限。",
        "pending.models": "聊天、学习、嵌入及 Code 的模型选择与预算。",
        "pending.admin": "管理员 QQ 号、身份绑定及私聊校验。",
        "pending.scope": "允许接收、保存、学习和发送的群与私聊范围。",
        "pending.retention": "数据保留、删除、备份及是否导入历史。",
        "pending.code": "Code 专用工作区、工具权限和高风险动作处理。",
        "pending.persistence": "Host 持久存储集成、规模与崩溃恢复验收；不能用内存探测替代。",
        "pending.ownership": "与旧桥接项目使用同一 QQ 账号时的互斥与切换。",
        "pending.snowluma": "SnowLuma 实际版本、连接配置与真实收发确认。",
        "pending.recovery": "排队与重启恢复策略仍未决；关闭 Code 不终止已运行任务。",
        "page.note": "本页不是 LLM 聊天界面；不发送消息，不启用模型，不执行 Code，不保存业务配置。"
      },
      "en": {
        "nav": "juebot",
        "page.title": "juebot",
        "page.subtitle": "Read-only management · Host diagnostics and prerequisites",
        "action.refresh": "Refresh status",
        "action.refreshing": "Reading…",
        "action.back": "Back to conversation",
        "host.title": "Host diagnostic facts",
        "host.description": "These results were sampled when this console's Host half activated. Refresh only reads that snapshot; it does not rerun probes or open a business database.",
        "snapshot.waiting": "No Host snapshot received",
        "snapshot.loading": "Reading the Host snapshot",
        "snapshot.ready": "Host diagnostic checks passed",
        "snapshot.issues": "Host diagnostics received, with failed or unexecuted checks",
        "snapshot.retained": "Showing a previously received Host-activation snapshot",
        "snapshot.stale": "Read failed: the retained snapshot below is old and must not be treated as current.",
        "snapshot.refreshingOld": "Refreshing: the previous snapshot remains below; a new read has not succeeded yet.",
        "snapshot.unknown": "Unknown / not received",
        "error.network": "The status service is unavailable. No running Host or business capability is inferred.",
        "error.http": "The status read failed; the service may not be ready or access may not be authorized.",
        "error.invalid": "The response does not match the status contract and was rejected as diagnostic evidence.",
        "error.timeout": "The status read timed out. You can refresh again later.",
        "fact.version": "Console version",
        "fact.node": "Host Node",
        "fact.platform": "Host platform",
        "fact.architecture": "Host architecture",
        "fact.sqlite": "Host SQLite",
        "fact.captured": "Sampled at Host activation (UTC)",
        "fact.sqliteMissing": "SQLite version not obtained",
        "check.title": "Host in-memory diagnostic checks",
        "check.driver": "SQLite driver",
        "check.schema": "Diagnostic schema",
        "check.fts5": "FTS5",
        "check.shortQuery": "Chinese short-query fallback",
        "check.privacy": "Synthetic permission-isolation cases",
        "check.cleanup": "Diagnostic resource cleanup",
        "check.ok": "Passed",
        "check.unavailable": "Unavailable",
        "check.error": "Failed",
        "check.notRun": "Not run",
        "check.notNeeded": "Not needed",
        "check.limitation": "Synthetic in-memory diagnostics do not verify persistent storage, real-chat privacy, production scale, or crash recovery.",
        "probe.moduleUnavailable": "This Host cannot use the built-in Node SQLite module.",
        "probe.openFailed": "The Host could not open its diagnostic database.",
        "probe.schemaFailed": "A diagnostic schema or retrieval check failed.",
        "probe.roundtripFailed": "A synthetic round-trip or permission-isolation check failed.",
        "probe.cleanupFailed": "Diagnostic resource cleanup failed.",
        "boundary.title": "Capability boundary: this console starts no business operations",
        "boundary.description": "These are the Host's declared defaults and this console's behavior, not a live inventory of all Loader entries. This page provides no business configuration or execution controls.",
        "boundary.backendLabel": "Storage backend default",
        "boundary.backendValue": "Declared disabled by default; not the live state of other Loader entries",
        "boundary.storageLabel": "Persistent database",
        "boundary.storageValue": "Not opened by this console",
        "boundary.qqLabel": "QQ / SnowLuma",
        "boundary.qqValue": "Not connected by this console",
        "boundary.modelsLabel": "Model services",
        "boundary.modelsValue": "Not connected by this console",
        "boundary.codeLabel": "Code execution",
        "boundary.codeValue": "Not connected by this console",
        "pending.title": "Unresolved prerequisites",
        "pending.description": "These need separate confirmation or verification. Displaying this page or passing diagnostics grants no data, model, QQ, or Code permissions.",
        "pending.models": "Model choices and budgets for chat, learning, embeddings, and Code.",
        "pending.admin": "Administrator QQ identity, binding, and private-message verification.",
        "pending.scope": "Authorized groups and private chats for receiving, saving, learning, and sending.",
        "pending.retention": "Retention, deletion, backups, and whether to import history.",
        "pending.code": "Dedicated Code workspace, tool permissions, and high-risk actions.",
        "pending.persistence": "Host persistence integration, scale, and crash-recovery verification; in-memory probes are not substitutes.",
        "pending.ownership": "Exclusive ownership and switchover when an older bridge uses the same QQ account.",
        "pending.snowluma": "Actual SnowLuma version, connection configuration, and real send/receive confirmation.",
        "pending.recovery": "Queue and restart recovery remain unresolved; disabling Code does not stop already running tasks.",
        "page.note": "This is not an LLM chat interface. It sends no messages, enables no models, executes no Code, and saves no business configuration."
      }
    };
    // END_DICTIONARIES

    const CHECK_LABELS = {
      "driver": "check.driver", "schema": "check.schema", "fts5": "check.fts5",
      "shortQuery": "check.shortQuery", "privacy": "check.privacy", "cleanup": "check.cleanup"
    };
    const CHECK_VALUES = {
      "driver": ["ok", "unavailable", "error"],
      "schema": ["ok", "error", "not-run"],
      "fts5": ["ok", "error", "not-run"],
      "shortQuery": ["ok", "error", "not-run"],
      "privacy": ["ok", "error", "not-run"],
      "cleanup": ["ok", "error", "not-needed"]
    };
    const CHECK_TEXT = {
      "ok": "check.ok", "unavailable": "check.unavailable", "error": "check.error",
      "not-run": "check.notRun", "not-needed": "check.notNeeded"
    };
    const FAILURE_TEXT = {
      "SQLITE_MODULE_UNAVAILABLE": "probe.moduleUnavailable",
      "SQLITE_OPEN_FAILED": "probe.openFailed",
      "SCHEMA_PROBE_FAILED": "probe.schemaFailed",
      "ROUNDTRIP_FAILED": "probe.roundtripFailed",
      "CLEANUP_FAILED": "probe.cleanupFailed"
    };
    const MODULE_ROWS = [
      ["boundary.backendLabel", "boundary.backendValue"],
      ["boundary.storageLabel", "boundary.storageValue"],
      ["boundary.qqLabel", "boundary.qqValue"],
      ["boundary.modelsLabel", "boundary.modelsValue"],
      ["boundary.codeLabel", "boundary.codeValue"]
    ];
    const PENDING_ROWS = [
      ["JUEBOT-Q001", "pending.models"], ["JUEBOT-Q002", "pending.admin"],
      ["JUEBOT-Q003", "pending.scope"], ["JUEBOT-Q004", "pending.retention"],
      ["JUEBOT-Q005", "pending.code"], ["JUEBOT-Q011", "pending.persistence"],
      ["JUEBOT-Q012", "pending.ownership"], ["JUEBOT-Q015", "pending.snowluma"],
      ["JUEBOT-Q006 / Q007", "pending.recovery"]
    ];
    const STATUS_FIELDS = [
      'schemaVersion', 'packageVersion', 'capturedAt', 'mode', 'hostNode', 'platform',
      'architecture', 'sqliteVersion', 'checks', 'failureCode', 'backendDefaultDisabled',
      'persistentStorage', 'qq', 'models', 'code'
    ];

    function hasExactKeys(value, keys) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length
        && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
    }

    // Reject unknown versions, fields, or enums before any returned values reach the view.
    function validateSnapshot(value) {
      if (!hasExactKeys(value, STATUS_FIELDS)
        || value.schemaVersion !== 1 || value.packageVersion !== '0.1.0-dev.2'
        || value.mode !== 'diagnostics-only' || value.backendDefaultDisabled !== true
        || value.persistentStorage !== 'not-opened-by-console'
        || value.qq !== 'not-connected' || value.models !== 'not-connected'
        || value.code !== 'not-connected') return null;
      if (typeof value.hostNode !== 'string'
        || !/^v?\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][a-zA-Z0-9.-]{1,32})?$/.test(value.hostNode)
        || typeof value.platform !== 'string' || !/^[a-z0-9_-]{1,24}$/.test(value.platform)
        || typeof value.architecture !== 'string' || !/^[a-z0-9_-]{1,24}$/.test(value.architecture)
        || (value.sqliteVersion !== null && (typeof value.sqliteVersion !== 'string'
          || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value.sqliteVersion)))) return null;
      if (typeof value.capturedAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.capturedAt)
        || !Number.isFinite(Date.parse(value.capturedAt))
        || new Date(value.capturedAt).toISOString() !== value.capturedAt) return null;
      if (!hasExactKeys(value.checks, Object.keys(CHECK_VALUES))
        || !Object.entries(CHECK_VALUES).every(([key, values]) => values.includes(value.checks[key]))
        || (value.failureCode !== null
          && !Object.prototype.hasOwnProperty.call(FAILURE_TEXT, value.failureCode))) return null;
      return Object.freeze({ ...value, checks: Object.freeze({ ...value.checks }) });
    }

    function diagnosticsPassed(snapshot) {
      return snapshot !== null && snapshot.failureCode === null && snapshot.sqliteVersion !== null
        && Object.keys(CHECK_VALUES).every(key => snapshot.checks[key] === 'ok');
    }

    const STYLES = `
.juebot-console{box-sizing:border-box;height:100%;min-height:0;min-width:0;overflow:auto;padding:24px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit;line-height:1.55}
.juebot-console *{box-sizing:border-box}
.juebot-console .juebot-content{width:100%;max-width:960px;margin:0 auto}
.juebot-console .juebot-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:24px}
.juebot-console h1{font-size:22px;line-height:1.3;margin:0 0 6px;font-weight:600}
.juebot-console h2{font-size:16px;line-height:1.4;margin:0 0 8px;font-weight:600}
.juebot-console h3{font-size:14px;margin:20px 0 8px;font-weight:600}
.juebot-console p{margin:0 0 12px}
.juebot-console .juebot-muted{color:var(--dsw-alias-label-secondary);font-size:13px}
.juebot-console .juebot-actions{display:flex;gap:8px;flex-wrap:wrap}
.juebot-console button{font:inherit;font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 12px;cursor:pointer}
.juebot-console button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.juebot-console button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.juebot-console button:disabled{color:var(--dsw-alias-label-secondary);cursor:wait}
.juebot-console .juebot-section{padding:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);margin-bottom:16px}
.juebot-console .juebot-notice{padding:10px 12px;margin:12px 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);font-size:13px}
.juebot-console [data-tone=idle]{color:var(--dsw-alias-label-secondary)}
.juebot-console [data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}
.juebot-console [data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.juebot-console [data-tone=success]{color:var(--dsw-alias-state-success-primary)}
.juebot-console dl{margin:12px 0 0}
.juebot-console .juebot-row{display:grid;grid-template-columns:minmax(130px,180px) minmax(0,1fr);gap:12px;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px}
.juebot-console .juebot-row:last-child{border-bottom:0}
.juebot-console dt{color:var(--dsw-alias-label-secondary)}
.juebot-console dd{margin:0;overflow-wrap:anywhere}
.juebot-console .juebot-checks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 20px;list-style:none;padding:0;margin:0 0 12px}
.juebot-console .juebot-check{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:13px;padding:7px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.juebot-console .juebot-check strong{font-size:12px;font-weight:500;white-space:nowrap}
.juebot-console .juebot-pending{list-style:none;padding:0;margin:8px 0 0}
.juebot-console .juebot-pending li{padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px}
.juebot-console .juebot-pending li:last-child{border-bottom:0}
.juebot-console .juebot-question{display:block;color:var(--dsw-alias-label-secondary);font-size:11px;margin-bottom:3px}
.juebot-console .juebot-footnote{padding:0 2px 16px}
@media(max-width:640px){.juebot-console{padding:16px}.juebot-console .juebot-section{padding:16px}.juebot-console .juebot-checks{grid-template-columns:1fr}.juebot-console .juebot-row{grid-template-columns:1fr;gap:3px}}
`;

    function PanelIcon({ size, active }) {
      const pixels = Number.isFinite(size) && size > 0 ? size : 20;
      return h('svg', {
        width: pixels, height: pixels, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: active ? 2 : 1.65,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        focusable: 'false', style: { display: 'block' }
      }, h('rect', { x: 4, y: 7, width: 16, height: 13, rx: 4 }),
      h('path', { d: 'M12 7V3m-3 0h6M8 16h8' }),
      h('circle', { cx: 8.5, cy: 12, r: 0.7, fill: 'currentColor', stroke: 'none' }),
      h('circle', { cx: 15.5, cy: 12, r: 0.7, fill: 'currentColor', stroke: 'none' }));
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NAMESPACE, DICTIONARIES), 'juebot: locale dictionaries');
        const label = ctx.locale.bind(NAMESPACE);

        function JuebotPage({ t }) {
          if (typeof t !== 'function') t = label;
          const [state, setState] = React.useState({ phase: 'idle', snapshot: null, error: null });
          const mounted = React.useRef(false);
          const sequence = React.useRef(0);
          const request = React.useRef(null);
          const deadline = React.useRef(null);

          const refresh = React.useCallback(async () => {
            const revision = ++sequence.current;
            if (deadline.current !== null) clearTimeout(deadline.current);
            if (request.current) request.current.abort();
            const controller = new AbortController();
            request.current = controller;
            let timedOut = false;
            let failure = 'error.network';
            const timeout = setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, REQUEST_TIMEOUT_MS);
            deadline.current = timeout;
            setState(previous => ({ phase: 'loading', snapshot: previous.snapshot, error: null }));
            try {
              const response = await fetch(STATUS_URL, {
                method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal
              });
              if (!response.ok) {
                failure = 'error.http';
                throw new Error('STATUS_READ_FAILED');
              }
              failure = 'error.invalid';
              const snapshot = validateSnapshot(await response.json());
              if (snapshot === null) throw new Error('INVALID_STATUS_SNAPSHOT');
              if (mounted.current && revision === sequence.current && !controller.signal.aborted) {
                setState({ phase: 'ready', snapshot, error: null });
              }
            } catch {
              if (!mounted.current || revision !== sequence.current) return;
              if (controller.signal.aborted && !timedOut) return;
              setState(previous => ({
                phase: 'error', snapshot: previous.snapshot, error: timedOut ? 'error.timeout' : failure
              }));
            } finally {
              clearTimeout(timeout);
              if (revision === sequence.current) {
                request.current = null;
                deadline.current = null;
              }
            }
          }, []);

          React.useEffect(() => {
            mounted.current = true;
            void refresh();
            return () => {
              mounted.current = false;
              ++sequence.current;
              if (deadline.current !== null) clearTimeout(deadline.current);
              deadline.current = null;
              if (request.current) request.current.abort();
              request.current = null;
            };
          }, [refresh]);

          const { phase, snapshot } = state;
          const fresh = phase === 'ready';
          const mayUseSuccess = fresh && diagnosticsPassed(snapshot);
          const stale = snapshot !== null && !fresh;
          const unknown = t('snapshot.unknown');
          const summaryKey = phase === 'loading' ? 'snapshot.loading'
            : fresh ? (mayUseSuccess ? 'snapshot.ready' : 'snapshot.issues')
              : stale ? 'snapshot.retained' : 'snapshot.waiting';
          const facts = [
            ['fact.version', snapshot ? snapshot.packageVersion : unknown],
            ['fact.node', snapshot ? snapshot.hostNode : unknown],
            ['fact.platform', snapshot ? snapshot.platform : unknown],
            ['fact.architecture', snapshot ? snapshot.architecture : unknown],
            ['fact.sqlite', snapshot ? (snapshot.sqliteVersion ?? t('fact.sqliteMissing')) : unknown],
            ['fact.captured', snapshot
              ? h('time', { dateTime: snapshot.capturedAt }, snapshot.capturedAt) : unknown]
          ];
          const row = (key, value) => h('div', { className: 'juebot-row', key },
            h('dt', null, t(key)), h('dd', null, value));

          return h('section', { className: 'juebot-console', 'aria-labelledby': 'juebot-title' },
            h('style', null, STYLES),
            h('div', { className: 'juebot-content' },
              h('header', { className: 'juebot-header' },
                h('div', null, h('h1', { id: 'juebot-title' }, t('page.title')),
                  h('p', { className: 'juebot-muted' }, t('page.subtitle'))),
                h('div', { className: 'juebot-actions' },
                  h('button', { type: 'button', disabled: phase === 'loading', onClick: refresh },
                    t(phase === 'loading' ? 'action.refreshing' : 'action.refresh')),
                  h('button', { type: 'button', onClick: () => ctx.layout.selectPanel(null) }, t('action.back')))),
              h('section', { className: 'juebot-section', 'aria-labelledby': 'juebot-host-title', 'aria-busy': phase === 'loading' },
                h('h2', { id: 'juebot-host-title' }, t('host.title')),
                h('p', { className: 'juebot-muted' }, t('host.description')),
                h('div', { className: 'juebot-notice', role: 'status', 'aria-live': 'polite',
                  'data-tone': mayUseSuccess ? 'success' : fresh || state.error ? 'warn' : 'idle' },
                  h('div', null, t(summaryKey)),
                  state.error ? h('div', null, t(state.error)) : null,
                  stale ? h('div', null, t(phase === 'loading' ? 'snapshot.refreshingOld' : 'snapshot.stale')) : null),
                h('dl', null, facts.map(([key, value]) => row(key, value))),
                h('h3', null, t('check.title')),
                h('ul', { className: 'juebot-checks' }, Object.entries(CHECK_LABELS).map(([key, text]) => {
                  const value = snapshot ? snapshot.checks[key] : null;
                  const tone = !fresh ? 'idle' : value === 'error' || value === 'unavailable' ? 'error'
                    : value === 'ok' && mayUseSuccess ? 'success' : 'idle';
                  return h('li', { className: 'juebot-check', key }, h('span', null, t(text)),
                    h('strong', { 'data-tone': tone }, value ? t(CHECK_TEXT[value]) : unknown));
                })),
                snapshot && snapshot.failureCode ? h('p', { 'data-tone': fresh ? 'error' : 'idle' },
                  t(FAILURE_TEXT[snapshot.failureCode])) : null,
                h('p', { className: 'juebot-muted' }, t('check.limitation'))),
              h('section', { className: 'juebot-section', 'aria-labelledby': 'juebot-boundary-title' },
                h('h2', { id: 'juebot-boundary-title' }, t('boundary.title')),
                h('p', { className: 'juebot-muted' }, t('boundary.description')),
                h('dl', null, MODULE_ROWS.map(([key, value]) => row(key, snapshot ? t(value) : unknown)))),
              h('section', { className: 'juebot-section', 'aria-labelledby': 'juebot-pending-title' },
                h('h2', { id: 'juebot-pending-title' }, t('pending.title')),
                h('p', { className: 'juebot-muted' }, t('pending.description')),
                h('ul', { className: 'juebot-pending' }, PENDING_ROWS.map(([id, text]) =>
                  h('li', { key: id }, h('span', { className: 'juebot-question' }, id), h('span', null, t(text)))))),
              h('p', { className: 'juebot-muted juebot-footnote' }, t('page.note'))));
        }

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, locale: NAMESPACE
        }, JuebotPage));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => label('nav')
        }, PanelIcon));
      }
    };
  }
});
