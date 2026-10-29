(function () {
const definitions = [];
const capture = definition => definitions.push(definition);
capture({
  id: '@local/dsh-juebot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const PANEL_ID = 'juebot-setup';
    const NAMESPACE = 'juebot';
    const PACKAGE_VERSION = '0.3.0-dev.5';
    const REQUEST_TIMEOUT_MS = 8000;
    const URLS = {
      "read": "api/juebot/settings",
      "identity": "api/juebot/settings/identity",
      "admin": "api/juebot/settings/admin",
      "check": "api/juebot/settings/path/check",
      "confirm": "api/juebot/settings/path/confirm",
      "clear": "api/juebot/settings/path/clear"
    };
    const DICTIONARIES = {
      "zh": {
        "nav": "juebot",
        "page.title": "juebot 配置",
        "page.subtitle": "身份配置、管理员登记与数据路径候选；不启动业务。",
        "page.version": "候选控制面版本",
        "page.revision": "配置版本",
        "page.unknown": "尚未读取",
        "page.inert": "业务未启动：管理员未验证，存储、QQ、模型与 Code 均未启用。",
        "page.stale": "以下为先前读取的配置，尚未确认最新状态。写入前请重新载入。",
        "page.busy": "请求处理中…",
        "page.dirty": "有未保存草稿。刷新会保留已修改字段；离开页面可能丢失草稿。",
        "page.saved": "配置已保存；没有启动业务。",
        "page.loaded": "已读取当前配置。",
        "page.retained": "已重新载入，未保存字段仍保留为草稿。请核对当前已保存值后再保存。",
        "page.mutationUnknown": "本次写入没有得到有效成功回执，可能已保存。不要自动重试；请重新载入并核对。",
        "action.refresh": "重新载入（保留草稿）",
        "action.discard": "丢弃草稿并重新载入",
        "action.back": "返回对话",
        "action.saveIdentity": "保存身份",
        "action.saveAdmin": "登记管理员 QQ",
        "action.clearAdmin": "清除管理员登记",
        "action.checkPath": "校验候选路径",
        "action.confirmPath": "确认并保存候选",
        "action.clearPath": "仅清除路径配置",
        "identity.title": "身份",
        "identity.description": "仅更改名称、身份模式和人格卡，不改变任何授权或业务开关。",
        "identity.name": "名字",
        "identity.nameHint": "最多 64 个字符；不能为空。保存时去除首尾空白。",
        "identity.mode": "身份模式",
        "identity.juejue": "撅撅 bot 模式",
        "identity.persona": "人格 bot 模式",
        "identity.card": "人格卡",
        "identity.cardHint": "最多 8000 个字符；清空后保存会移除人格卡。模式切换不会自动删除它。",
        "identity.savedName": "当前已保存名字",
        "identity.savedMode": "当前已保存模式",
        "identity.savedCard": "当前已保存人格卡",
        "identity.noCard": "未设置",
        "identity.cardLength": "字符",
        "identity.invalid": "请检查名字、模式和人格卡长度；不接受控制字符。",
        "admin.title": "管理员 QQ 登记",
        "admin.description": "仅预登记或清除个人 QQ 号码，不支持官方机器人 OpenID，不完成身份验证，也不启用 Code。已登记号码始终等待 QQ 私聊验证。",
        "admin.number": "管理员 QQ 号",
        "admin.numberHint": "按文本保存，1–20 位数字，首位不能是 0。",
        "admin.current": "当前已登记 QQ",
        "admin.unconfigured": "未登记",
        "admin.pending": "已登记 · 待 QQ 私聊验证（pending-proof）",
        "admin.epoch": "登记版本",
        "admin.ack": "我确认登记或清除以上管理员信息，并重置其绑定状态；这不是完成身份验证。",
        "admin.invalid": "请输入合法的 QQ 数字字符串；清除请使用专用按钮。",
        "path.title": "数据路径候选",
        "path.description": "填写本机绝对 .sqlite 文件路径，先校验再单独确认。此处只保存候选，不创建、迁移或打开数据库。",
        "path.input": "候选 .sqlite 路径",
        "path.inputHint": "最多 4096 个字符。修改输入、重新载入或保存其他配置后，需要重新校验。",
        "path.current": "当前已保存候选",
        "path.empty": "未设置",
        "path.confirmed": "候选已确认 · 数据库未打开",
        "path.unconfirmed": "候选尚未确认",
        "path.checked": "候选元数据校验通过；数据库未打开。",
        "path.canonical": "规范化路径",
        "path.exists": "目标文件已存在",
        "path.missing": "目标文件尚不存在；本次校验未创建它",
        "path.expiry": "本次校验到期时间（UTC）",
        "path.expired": "本次校验已过期，请重新校验后再确认。",
        "path.ack": "我确认上述规范化候选路径；仅保存配置，不授权创建或打开数据库。",
        "path.clearAck": "我确认仅清除已保存的路径配置，不删除任何文件。",
        "path.invalid": "请填写不含控制字符的非空 .sqlite 路径；具体路径限制由 Host 校验。",
        "boundary.title": "权限与数据边界",
        "boundary.owner": "页面使用同源 owner 认证。owner API 权限不等于每次真人点击证明，也不是 QQ 身份验证。",
        "boundary.userOnly": "管理员登记、清除与数据路径确认是用户操作，不提供 Agent 工具；身份文本更新共享同一 Host 校验。",
        "boundary.path": "路径元数据检查不是 OS 沙箱，也不是正式数据库验收。确认不授予创建、打开数据库或启用业务的权限。",
        "boundary.scope": "本页只报告该控制面的停用边界，不代表整个 Loader 中其他插件的状态。",
        "error.network": "请求失败，请检查连接后重新载入。",
        "error.timeout": "请求超过 8 秒，已停止等待。",
        "error.http": "Host 未接受请求，请重新载入后核对。",
        "error.auth": "访问未获准，请通过当前 DSH 页面重新认证。",
        "error.invalid": "响应格式、版本或停用声明不符合约定，未显示为成功。",
        "error.conflict": "配置版本已变化（409）；草稿已保留。请重新载入、核对已保存值，再决定是否保存。",
        "error.input": "Host 拒绝了输入，请检查字段、长度和确认选项。",
        "error.path": "候选路径不符合 Host 限制，请修改后重新校验。",
        "error.recheck": "路径校验已失效、到期或目标发生变化，请重新校验。",
        "error.limit": "待确认路径数量达到上限，请稍后重试。",
        "error.storage": "配置存储当前不可用，未确认保存成功。"
      },
      "en": {
        "nav": "juebot",
        "page.title": "juebot settings",
        "page.subtitle": "Identity, administrator registration and a data-path candidate; no business activation.",
        "page.version": "Candidate console version",
        "page.revision": "Settings revision",
        "page.unknown": "Not loaded",
        "page.inert": "Business operations are off: administrator unverified; storage, QQ, models and Code disabled.",
        "page.stale": "These are previously loaded settings, not a confirmed current snapshot. Reload before writing.",
        "page.busy": "Request in progress…",
        "page.dirty": "There are unsaved drafts. Reload preserves edited fields; leaving this page may discard drafts.",
        "page.saved": "Settings saved; no business operations started.",
        "page.loaded": "Current settings loaded.",
        "page.retained": "Reloaded while retaining edited fields as drafts. Compare the saved values before saving again.",
        "page.mutationUnknown": "This write has no valid success receipt and may already have committed. Do not retry automatically; reload and compare.",
        "action.refresh": "Reload (keep drafts)",
        "action.discard": "Discard drafts and reload",
        "action.back": "Back to conversation",
        "action.saveIdentity": "Save identity",
        "action.saveAdmin": "Register administrator QQ",
        "action.clearAdmin": "Clear administrator registration",
        "action.checkPath": "Check candidate path",
        "action.confirmPath": "Confirm and save candidate",
        "action.clearPath": "Clear path configuration only",
        "identity.title": "Identity",
        "identity.description": "Edit only the name, identity mode and persona card; no authority or business switch changes.",
        "identity.name": "Name",
        "identity.nameHint": "At most 64 characters, not empty. Surrounding whitespace is removed when saved.",
        "identity.mode": "Identity mode",
        "identity.juejue": "Juejue bot mode",
        "identity.persona": "Persona bot mode",
        "identity.card": "Persona card",
        "identity.cardHint": "At most 8000 characters. Saving an empty card removes it; changing mode does not erase it.",
        "identity.savedName": "Currently saved name",
        "identity.savedMode": "Currently saved mode",
        "identity.savedCard": "Currently saved persona card",
        "identity.noCard": "Not configured",
        "identity.cardLength": "characters",
        "identity.invalid": "Check the name, mode and persona-card length; control characters are not accepted.",
        "admin.title": "Administrator QQ registration",
        "admin.description": "Pre-register or clear a personal QQ number only; official bot OpenID is not supported. This neither verifies the identity nor enables Code. A registered number always awaits QQ private-message verification.",
        "admin.number": "Administrator QQ number",
        "admin.numberHint": "Stored as text: 1–20 digits, with no leading zero.",
        "admin.current": "Currently registered QQ",
        "admin.unconfigured": "Not registered",
        "admin.pending": "Registered · awaiting QQ private-message verification (pending-proof)",
        "admin.epoch": "Registration epoch",
        "admin.ack": "I confirm registering or clearing this administrator information and resetting its binding state; this does not verify the identity.",
        "admin.invalid": "Enter a valid QQ digit string. Use the dedicated button to clear registration.",
        "path.title": "Data-path candidate",
        "path.description": "Enter an absolute local .sqlite file path, check it, then confirm separately. This saves a candidate only; it never creates, migrates or opens the database.",
        "path.input": "Candidate .sqlite path",
        "path.inputHint": "At most 4096 characters. Editing the input, reloading or saving other settings requires a new check.",
        "path.current": "Currently saved candidate",
        "path.empty": "Not configured",
        "path.confirmed": "Candidate confirmed · database not opened",
        "path.unconfirmed": "Candidate not yet confirmed",
        "path.checked": "Candidate metadata check passed; the database was not opened.",
        "path.canonical": "Canonical path",
        "path.exists": "The target file exists",
        "path.missing": "The target file does not exist; this check did not create it",
        "path.expiry": "This check expires at (UTC)",
        "path.expired": "This check has expired. Check the path again before confirming.",
        "path.ack": "I confirm the canonical candidate shown above: save configuration only, without authorizing database creation or opening.",
        "path.clearAck": "I confirm clearing the saved path configuration only, without deleting any files.",
        "path.invalid": "Enter a nonempty .sqlite path without control characters; the Host enforces path restrictions.",
        "boundary.title": "Authority and data boundaries",
        "boundary.owner": "This page uses same-origin owner authentication. Owner API authority is not proof of a human click each time, or proof of QQ identity.",
        "boundary.userOnly": "Administrator registration, clearing and data-path confirmation are user actions with no Agent tool. Identity edits share the same Host validation.",
        "boundary.path": "Path metadata checks are not an OS sandbox or production database verification. Confirmation grants no permission to create or open a database or start business operations.",
        "boundary.scope": "This page reports only this console's inactive boundaries, not the state of other Loader plugins.",
        "error.network": "The request failed. Check the connection and reload.",
        "error.timeout": "The request exceeded 8 seconds; waiting was aborted.",
        "error.http": "The Host did not accept the request. Reload and compare.",
        "error.auth": "Access was not authorized. Authenticate through the current DSH page again.",
        "error.invalid": "The response shape, version or inactive declarations do not match the contract; no success is shown.",
        "error.conflict": "The settings revision changed (409). Drafts were preserved. Reload and compare saved values before deciding to save again.",
        "error.input": "The Host rejected the input. Check fields, lengths and acknowledgement options.",
        "error.path": "The candidate path violates Host restrictions. Edit it and check again.",
        "error.recheck": "The path check expired, became invalid or the target changed. Check it again.",
        "error.limit": "Too many pending path checks. Try again later.",
        "error.storage": "Settings storage is unavailable; a successful save was not confirmed."
      }
    };
    // END_DICTIONARIES
    const ERROR_TEXT = {
      "CONTROL_REVISION_CONFLICT": "error.conflict",
      "PATH_CHECK_REQUIRED": "error.recheck",
      "PATH_CHANGED_RECHECK": "error.recheck",
      "PATH_CHECK_LIMIT": "error.limit",
      "INVALID_STORAGE_PATH": "error.path",
      "STORAGE_INSIDE_PACKAGE": "error.path",
      "STORAGE_PARENT_NOT_DIRECTORY": "error.path",
      "STORAGE_PATH_NOT_REGULAR_FILE": "error.path",
      "INVALID_DATA_CANDIDATE": "error.path",
      "INVALID_PATH_OBSERVATION": "error.path",
      "INVALID_CONTROL_INPUT": "error.input",
      "UNKNOWN_CONTROL_FIELD": "error.input",
      "MISSING_CONTROL_FIELD": "error.input",
      "INVALID_CONTROL_REVISION": "error.input",
      "INVALID_CONTROL_TEXT": "error.input",
      "INVALID_IDENTITY_NAME": "error.input",
      "INVALID_IDENTITY_MODE": "error.input",
      "EMPTY_IDENTITY_PATCH": "error.input",
      "INVALID_ADMIN_QQ": "error.input",
      "USER_ACKNOWLEDGEMENT_REQUIRED": "error.input",
      "CONTROL_CLOSED": "error.storage",
      "CONTROL_REVISION_EXHAUSTED": "error.storage"
    };
    const STATE_FIELDS = ['schemaVersion', 'profileKey', 'revision', 'identity', 'admin', 'dataPath'];
    const OPERATIONAL_FIELDS = ['adminVerified', 'storageBackendEnabled', 'qqConnected', 'modelsConnected', 'codeEnabled'];
    const DRAFT_FIELDS = ['name', 'mode', 'personaCard', 'qq', 'candidate'];
    const EMPTY_ACK = { admin: false, path: false, clearPath: false };

    function hasExactKeys(value, keys) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === keys.length
        && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
    }
    function isText(value, limit, multiline = false) {
      return typeof value === 'string' && value.length <= limit
        && !(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u).test(value);
    }
    function isRevision(value) { return Number.isSafeInteger(value) && value >= 0; }
    function isHash(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
    function isQQ(value) { return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value); }
    function isDate(value) {
      return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
        && new Date(value).toISOString() === value;
    }
    function isPathText(value) { return isText(value, 4096) && value.trim().length > 0; }

    // Validate the full owner-only shape before retaining any fields in component state.
    function validateControl(value) {
      if (!hasExactKeys(value, STATE_FIELDS) || value.schemaVersion !== 1
        || !isHash(value.profileKey) || !isRevision(value.revision)) return null;
      const { identity, admin, dataPath } = value;
      if (!hasExactKeys(identity, ['name', 'mode', 'personaCard'])
        || !isText(identity.name, 64) || identity.name.trim() !== identity.name || !identity.name.length
        || !['juejue', 'persona'].includes(identity.mode)
        || (identity.personaCard !== null && !isText(identity.personaCard, 8000, true))) return null;
      if (!hasExactKeys(admin, ['qq', 'bindingEpoch', 'proofState']) || !isRevision(admin.bindingEpoch)
        || (admin.qq !== null && !isQQ(admin.qq))
        || admin.proofState !== (admin.qq === null ? 'unconfigured' : 'pending-proof')) return null;
      if (!hasExactKeys(dataPath, ['candidate', 'confirmedCandidate', 'approvedAt', 'fingerprint'])
        || (dataPath.candidate !== null && !isPathText(dataPath.candidate))) return null;
      if (dataPath.confirmedCandidate === null) {
        if (dataPath.approvedAt !== null || dataPath.fingerprint !== null) return null;
      } else if (!isPathText(dataPath.confirmedCandidate) || dataPath.candidate !== dataPath.confirmedCandidate
        || !isDate(dataPath.approvedAt) || !isHash(dataPath.fingerprint)) return null;
      return Object.freeze({ ...value, identity: Object.freeze({ ...identity }),
        admin: Object.freeze({ ...admin }), dataPath: Object.freeze({ ...dataPath }) });
    }
    function validateStateEnvelope(value, previous) {
      if (!hasExactKeys(value, ['ok', 'state', 'operational']) || value.ok !== true
        || !hasExactKeys(value.operational, OPERATIONAL_FIELDS)
        || !OPERATIONAL_FIELDS.every(key => value.operational[key] === false)) return null;
      const state = validateControl(value.state);
      if (!state || (previous && (state.profileKey !== previous.profileKey || state.revision < previous.revision))) return null;
      return state;
    }
    function validateCheckEnvelope(value, expectedRevision) {
      if (!hasExactKeys(value, ['ok', 'check']) || value.ok !== true) return null;
      const check = value.check;
      if (!hasExactKeys(check, ['revision', 'token', 'expiresAt', 'observation', 'opensDatabase'])
        || !isRevision(check.revision) || check.revision !== expectedRevision || check.opensDatabase !== false
        || !isText(check.token, 128) || check.token.length < 16 || !isDate(check.expiresAt)
        || Date.parse(check.expiresAt) <= Date.now()
        || !hasExactKeys(check.observation, ['canonicalPath', 'fingerprint', 'exists'])
        || !isPathText(check.observation.canonicalPath) || !isHash(check.observation.fingerprint)
        || typeof check.observation.exists !== 'boolean') return null;
      return Object.freeze({ ...check, observation: Object.freeze({ ...check.observation }) });
    }
    function errorKey(value, status) {
      if (status === 401 || status === 403) return 'error.auth';
      if (!hasExactKeys(value, ['ok', 'error']) || value.ok !== false
        || !hasExactKeys(value.error, ['code']) || typeof value.error.code !== 'string'
        || !/^[A-Z][A-Z0-9_]{0,95}$/.test(value.error.code)) return 'error.invalid';
      if (status === 409 && !['CONTROL_REVISION_CONFLICT', 'PATH_CHECK_REQUIRED', 'PATH_CHANGED_RECHECK'].includes(value.error.code)) return 'error.http';
      return Object.prototype.hasOwnProperty.call(ERROR_TEXT, value.error.code) ? ERROR_TEXT[value.error.code] : 'error.http';
    }
    function draftOf(state) {
      return { name: state.identity.name, mode: state.identity.mode, personaCard: state.identity.personaCard ?? '',
        qq: state.admin.qq ?? '', candidate: state.dataPath.candidate ?? '' };
    }
    function dirtyFields(view) {
      if (!view.saved) return [];
      const saved = draftOf(view.saved);
      return DRAFT_FIELDS.filter(key => view.draft[key] !== saved[key]);
    }
    function acceptState(previous, saved, replaceAll, committedFields, notice) {
      const values = draftOf(saved);
      const dirty = dirtyFields(previous);
      const draft = { ...values };
      if (!replaceAll) for (const key of dirty) {
        if (!committedFields.includes(key)) draft[key] = previous.draft[key];
      }
      const next = { ...previous, saved, draft, fresh: true, error: null, notice,
        check: null, checkInput: null, ack: { ...EMPTY_ACK } };
      if (notice === 'page.loaded' && dirtyFields(next).length) next.notice = 'page.retained';
      return next;
    }
    function initialView() {
      return { saved: null, draft: { name: '', mode: 'juejue', personaCard: '', qq: '', candidate: '' },
        fresh: false, busy: null, error: null, notice: null, check: null, checkInput: null, ack: { ...EMPTY_ACK } };
    }

    const STYLES = `
.juebot-console{box-sizing:border-box;height:100%;min-height:0;min-width:0;overflow:auto;padding:24px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit;line-height:1.55}
.juebot-console *{box-sizing:border-box}
.juebot-console .juebot-content{width:100%;max-width:920px;margin:0 auto}
.juebot-console .juebot-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.juebot-console h1{font-size:22px;line-height:1.3;margin:0 0 6px;font-weight:600}
.juebot-console h2{font-size:16px;line-height:1.4;margin:0 0 8px;font-weight:600}
.juebot-console p{margin:0 0 12px}
.juebot-console .juebot-muted{color:var(--dsw-alias-label-secondary);font-size:13px}
.juebot-console .juebot-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.juebot-console button{font:inherit;font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 12px;cursor:pointer}
.juebot-console button:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.juebot-console button:focus-visible,.juebot-console input:focus-visible,.juebot-console select:focus-visible,.juebot-console textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.juebot-console button:disabled{color:var(--dsw-alias-label-secondary);cursor:not-allowed}
.juebot-console .juebot-section{padding:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);margin-bottom:16px}
.juebot-console .juebot-notice{padding:10px 12px;margin:12px 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);font-size:13px;overflow-wrap:anywhere}
.juebot-console [data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}
.juebot-console [data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.juebot-console [data-tone=success]{color:var(--dsw-alias-state-success-primary)}
.juebot-console .juebot-fields{display:grid;gap:14px;border:0;padding:0;margin:16px 0 0;min-width:0}
.juebot-console .juebot-field{display:grid;gap:5px;min-width:0;font-size:14px}
.juebot-console input:not([type=checkbox]),.juebot-console textarea,.juebot-console select{display:block;width:100%;min-width:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;font:inherit;font-size:14px;padding:9px 10px}
.juebot-console textarea{resize:vertical;min-height:140px;line-height:1.5}
.juebot-console .juebot-ack{display:flex;align-items:flex-start;gap:9px;margin-top:14px;font-size:13px}
.juebot-console .juebot-ack input{flex:none;margin:4px 0 0;accent-color:var(--dsw-alias-brand-primary)}
.juebot-console dl{margin:12px 0}
.juebot-console .juebot-row{display:grid;grid-template-columns:minmax(130px,190px) minmax(0,1fr);gap:12px;padding:7px 0;font-size:13px}
.juebot-console dt{color:var(--dsw-alias-label-secondary)}
.juebot-console dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
.juebot-console .juebot-clear{border-top:1px solid var(--dsw-alias-border-l1);margin-top:18px;padding-top:2px}
.juebot-console .juebot-footnote{padding:4px 2px 20px}
@media(max-width:640px){.juebot-console{padding:16px}.juebot-console .juebot-section{padding:16px}.juebot-console .juebot-row{grid-template-columns:1fr;gap:3px}}
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
          const [view, setView] = React.useState(initialView);
          const current = React.useRef(view);
          const mounted = React.useRef(false);
          const sequence = React.useRef(0);
          const request = React.useRef(null);
          const deadline = React.useRef(null);
          // Update the ref synchronously: a second event cannot overtake an acknowledgement or edit.
          const update = React.useCallback(change => {
            const next = change(current.current);
            current.current = next;
            setView(next);
          }, []);

          const send = React.useCallback(async (operation, body = null, options = {}) => {
            if (!mounted.current || current.current.busy) return;
            if (!Object.prototype.hasOwnProperty.call(URLS, operation)) return;
            const previousSaved = current.current.saved;
            const expectedRevision = body?.expectedRevision;
            const isWrite = operation !== 'read' && operation !== 'check';
            const candidateInput = operation === 'check' ? current.current.draft.candidate : null;
            const serial = ++sequence.current;
            if (deadline.current !== null) clearTimeout(deadline.current);
            if (request.current) request.current.abort();
            const controller = new AbortController();
            request.current = controller;
            let timedOut = false;
            let failure = 'error.network';
            const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
            deadline.current = timeout;
            update(previous => ({ ...previous, busy: operation, error: null, notice: null,
              check: null, checkInput: null, ack: { ...EMPTY_ACK } }));
            try {
              const response = await fetch(URLS[operation], {
                method: operation === 'read' ? 'GET' : 'POST',
                credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
                signal: controller.signal,
                headers: { Accept: 'application/json', ...(body === null ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === null ? {} : { body: JSON.stringify(body) })
              });
              if (response.status === 401 || response.status === 403) { failure = 'error.auth'; throw new Error('REQUEST_UNAUTHORIZED'); }
              failure = 'error.invalid';
              if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
                throw new Error('INVALID_RESPONSE_TYPE');
              }
              const envelope = await response.json();
              if (!response.ok || envelope?.ok === false) {
                failure = errorKey(envelope, response.status);
                throw new Error('REQUEST_REJECTED');
              }
              const result = operation === 'check'
                ? validateCheckEnvelope(envelope, expectedRevision)
                : validateStateEnvelope(envelope, previousSaved);
              if (result === null) throw new Error('INVALID_RESPONSE_ENVELOPE');
              if (!mounted.current || serial !== sequence.current || controller.signal.aborted) return;
              if (operation === 'check') {
                update(previous => ({ ...previous, check: result, checkInput: candidateInput,
                  notice: 'path.checked', error: null }));
              } else {
                const committed = operation === 'identity' ? Object.keys(body.patch)
                  : operation === 'admin' ? ['qq'] : operation === 'confirm' || operation === 'clear' ? ['candidate'] : [];
                update(previous => acceptState(previous, result, options.discard === true, committed,
                  operation === 'read' ? 'page.loaded' : 'page.saved'));
              }
            } catch {
              if (!mounted.current || serial !== sequence.current) return;
              if (controller.signal.aborted && !timedOut) return;
              update(previous => ({ ...previous,
                fresh: failure === 'error.recheck' || (operation === 'check' && failure !== 'error.conflict' && failure !== 'error.auth') ? previous.fresh : false,
                error: timedOut ? 'error.timeout' : failure,
                notice: isWrite && failure !== 'error.conflict' && failure !== 'error.recheck' ? 'page.mutationUnknown' : null,
                check: null, checkInput: null, ack: { ...EMPTY_ACK } }));
            } finally {
              clearTimeout(timeout);
              if (mounted.current && serial === sequence.current) {
                request.current = null;
                deadline.current = null;
                update(previous => ({ ...previous, busy: null }));
              }
            }
          }, [update]);

          React.useEffect(() => {
            mounted.current = true;
            void send('read');
            return () => {
              mounted.current = false;
              ++sequence.current;
              if (deadline.current !== null) clearTimeout(deadline.current);
              deadline.current = null;
              if (request.current) request.current.abort();
              request.current = null;
              // A StrictMode setup after cleanup must not inherit an abandoned busy request.
              current.current = { ...current.current, busy: null };
            };
          }, [send]);
          React.useEffect(() => {
            if (!view.check) return;
            const token = view.check.token;
            const expires = setTimeout(() => {
              if (!mounted.current) return;
              update(previous => previous.check?.token === token ? { ...previous, check: null, checkInput: null,
                ack: { ...previous.ack, path: false }, notice: 'path.expired' } : previous);
            }, Math.min(2147483647, Math.max(0, Date.parse(view.check.expiresAt) - Date.now())));
            return () => clearTimeout(expires);
          }, [view.check, update]);

          function edit(field, value) {
            if (current.current.busy || !DRAFT_FIELDS.includes(field)) return;
            update(previous => ({ ...previous, draft: { ...previous.draft, [field]: value },
              notice: null,
              ...(field === 'candidate' ? { check: null, checkInput: null, ack: { ...previous.ack, path: false, clearPath: false } }
                : field === 'qq' ? { ack: { ...previous.ack, admin: false } } : {}) }));
          }
          function acknowledge(field, value) {
            if (current.current.busy) return;
            update(previous => ({ ...previous, ack: { ...previous.ack, [field]: value === true } }));
          }
          function canWrite() { return current.current.saved && current.current.fresh && !current.current.busy; }
          function saveIdentity() {
            if (!canWrite()) return;
            const state = current.current;
            if (!isText(state.draft.name, 64) || !state.draft.name.trim()
              || !['juejue', 'persona'].includes(state.draft.mode) || !isText(state.draft.personaCard, 8000, true)) return;
            const patch = {};
            for (const key of ['name', 'mode', 'personaCard']) {
              if (dirtyFields(state).includes(key)) patch[key] = key === 'personaCard' && !state.draft[key].trim() ? null : state.draft[key];
            }
            if (!Object.keys(patch).length) return;
            void send('identity', { expectedRevision: state.saved.revision, patch });
          }
          function saveAdmin(clear) {
            if (!canWrite() || !current.current.ack.admin) return;
            const state = current.current;
            const qq = clear ? null : state.draft.qq.trim();
            if (qq !== null && !isQQ(qq)) return;
            if (qq === state.saved.admin.qq) return;
            void send('admin', { expectedRevision: state.saved.revision, qq, acknowledgeReset: true });
          }
          function checkPath() {
            if (!canWrite() || !isPathText(current.current.draft.candidate)
              || !/\.sqlite$/i.test(current.current.draft.candidate.trim())) return;
            void send('check', { expectedRevision: current.current.saved.revision, candidate: current.current.draft.candidate });
          }
          function confirmPath() {
            if (!canWrite()) return;
            const state = current.current;
            if (!state.ack.path || !state.check || state.checkInput !== state.draft.candidate
              || state.check.revision !== state.saved.revision || Date.parse(state.check.expiresAt) <= Date.now()) {
              update(previous => ({ ...previous, check: null, checkInput: null,
                ack: { ...previous.ack, path: false }, notice: 'path.expired' }));
              return;
            }
            void send('confirm', { expectedRevision: state.saved.revision, token: state.check.token, acknowledge: true });
          }
          function clearPath() {
            if (!canWrite() || !current.current.ack.clearPath || current.current.saved.dataPath.candidate === null) return;
            void send('clear', { expectedRevision: current.current.saved.revision, acknowledge: true });
          }

          const { saved, draft, check, ack, busy } = view;
          const dirty = dirtyFields(view);
          const hasDraft = dirty.length > 0 || check !== null || Object.values(ack).some(Boolean);
          const unavailable = Boolean(busy) || !saved || !view.fresh;
          const invalidIdentity = !isText(draft.name, 64) || !draft.name.trim()
            || !['juejue', 'persona'].includes(draft.mode) || !isText(draft.personaCard, 8000, true);
          const invalidQQ = !isQQ(draft.qq.trim());
          const invalidPath = !isPathText(draft.candidate) || !/\.sqlite$/i.test(draft.candidate.trim());
          const row = (key, value) => h('div', { className: 'juebot-row', key }, h('dt', null, t(key)), h('dd', null, value));
          const checkbox = (field, key, disabled) => h('label', { className: 'juebot-ack' },
            h('input', { type: 'checkbox', checked: ack[field], disabled,
              onChange: event => acknowledge(field, event.target.checked) }), h('span', null, t(key)));
          const button = (key, onClick, disabled) => h('button', { type: 'button', disabled, onClick }, t(key));
          return h('section', { className: 'juebot-console', 'aria-labelledby': 'juebot-title', 'aria-busy': Boolean(busy) },
            h('style', null, STYLES),
            h('div', { className: 'juebot-content' },
              h('header', { className: 'juebot-header' },
                h('div', null, h('h1', { id: 'juebot-title' }, t('page.title')),
                  h('p', { className: 'juebot-muted' }, t('page.subtitle')),
                  h('div', { className: 'juebot-muted' }, t('page.version'), ': ', PACKAGE_VERSION, ' · ',
                    t('page.revision'), ': ', saved ? saved.revision : t('page.unknown'))),
                h('div', { className: 'juebot-actions' },
                  button('action.refresh', () => { void send('read'); }, Boolean(busy)),
                  button('action.discard', () => { void send('read', null, { discard: true }); }, Boolean(busy) || !hasDraft),
                  button('action.back', () => ctx.layout.selectPanel(null), Boolean(busy)))),
              h('div', { className: 'juebot-notice', role: 'status', 'aria-live': 'polite', 'aria-atomic': true },
                h('div', null, t(saved && view.fresh ? 'page.inert' : saved ? 'page.stale' : 'page.unknown')),
                busy ? h('div', null, t('page.busy')) : null,
                hasDraft ? h('div', { 'data-tone': 'warn' }, t('page.dirty')) : null,
                view.notice ? h('div', { 'data-tone': view.notice === 'page.saved' && !busy && view.fresh ? 'success' : undefined }, t(view.notice)) : null,
                view.error ? h('div', { 'data-tone': 'error', role: 'alert' }, t(view.error)) : null),
              h('section', { className: 'juebot-section', 'aria-labelledby': 'juebot-identity-title' },
                h('h2', { id: 'juebot-identity-title' }, t('identity.title')),
                h('p', { className: 'juebot-muted' }, t('identity.description')),
                saved ? h('dl', null,
                  row('identity.savedName', saved.identity.name),
                  row('identity.savedMode', t(saved.identity.mode === 'juejue' ? 'identity.juejue' : 'identity.persona')),
                  row('identity.savedCard', saved.identity.personaCard === null ? t('identity.noCard')
                    : `${saved.identity.personaCard.length} ${t('identity.cardLength')}`)) : null,
                h('fieldset', { className: 'juebot-fields', disabled: Boolean(busy) || !saved },
                  h('label', { className: 'juebot-field' }, h('span', null, t('identity.name')),
                    h('input', { type: 'text', value: draft.name, maxLength: 64, autoComplete: 'off',
                      'aria-describedby': 'juebot-name-hint', onChange: event => edit('name', event.target.value) }),
                    h('span', { className: 'juebot-muted', id: 'juebot-name-hint' }, t('identity.nameHint'))),
                  h('label', { className: 'juebot-field' }, h('span', null, t('identity.mode')),
                    h('select', { value: draft.mode, onChange: event => edit('mode', event.target.value) },
                      h('option', { value: 'juejue' }, t('identity.juejue')), h('option', { value: 'persona' }, t('identity.persona')))),
                  h('label', { className: 'juebot-field' }, h('span', null, t('identity.card')),
                    h('textarea', { value: draft.personaCard, maxLength: 8000, rows: 6, spellCheck: false,
                      'aria-describedby': 'juebot-card-hint', onChange: event => edit('personaCard', event.target.value) }),
                    h('span', { className: 'juebot-muted', id: 'juebot-card-hint' }, t('identity.cardHint')))),
                saved && invalidIdentity ? h('p', { 'data-tone': 'error' }, t('identity.invalid')) : null,
                h('div', { className: 'juebot-actions' }, button('action.saveIdentity', saveIdentity,
                  unavailable || invalidIdentity || !dirty.some(key => ['name', 'mode', 'personaCard'].includes(key))))),
              h('section', { className: 'juebot-section', 'aria-labelledby': 'juebot-admin-title' },
                h('h2', { id: 'juebot-admin-title' }, t('admin.title')),
                h('p', { className: 'juebot-muted' }, t('admin.description')),
                saved ? h('dl', null, row('admin.current', saved.admin.qq ?? t('admin.unconfigured')),
                  row('admin.epoch', saved.admin.bindingEpoch)) : null,
                saved ? h('p', { className: 'juebot-muted' }, t(saved.admin.proofState === 'pending-proof' ? 'admin.pending' : 'admin.unconfigured')) : null,
                h('label', { className: 'juebot-field' }, h('span', null, t('admin.number')),
                  h('input', { type: 'text', inputMode: 'numeric', value: draft.qq, maxLength: 20,
                    autoComplete: 'off', spellCheck: false, disabled: Boolean(busy) || !saved,
                    'aria-describedby': 'juebot-qq-hint', onChange: event => edit('qq', event.target.value) }),
                  h('span', { className: 'juebot-muted', id: 'juebot-qq-hint' }, t('admin.numberHint'))),
                draft.qq && invalidQQ ? h('p', { 'data-tone': 'error' }, t('admin.invalid')) : null,
                checkbox('admin', 'admin.ack', unavailable),
                h('div', { className: 'juebot-actions' },
                  button('action.saveAdmin', () => saveAdmin(false), unavailable || invalidQQ || !ack.admin || draft.qq.trim() === saved?.admin.qq),
                  button('action.clearAdmin', () => saveAdmin(true), unavailable || !ack.admin || saved?.admin.qq === null))),
              h('section', { className: 'juebot-section', 'aria-labelledby': 'juebot-path-title' },
                h('h2', { id: 'juebot-path-title' }, t('path.title')),
                h('p', { className: 'juebot-muted' }, t('path.description')),
                saved ? h('dl', null, row('path.current', saved.dataPath.candidate ?? t('path.empty'))) : null,
                saved?.dataPath.candidate ? h('p', { className: 'juebot-muted' },
                  t(saved.dataPath.confirmedCandidate === null ? 'path.unconfirmed' : 'path.confirmed')) : null,
                h('label', { className: 'juebot-field' }, h('span', null, t('path.input')),
                  h('input', { type: 'text', value: draft.candidate, maxLength: 4096, autoComplete: 'off',
                    spellCheck: false, disabled: Boolean(busy) || !saved, 'aria-describedby': 'juebot-path-hint',
                    onChange: event => edit('candidate', event.target.value) }),
                  h('span', { className: 'juebot-muted', id: 'juebot-path-hint' }, t('path.inputHint'))),
                draft.candidate && invalidPath ? h('p', { 'data-tone': 'error' }, t('path.invalid')) : null,
                h('div', { className: 'juebot-actions' }, button('action.checkPath', checkPath, unavailable || invalidPath)),
                check ? h('div', { className: 'juebot-notice' },
                  h('div', null, t('path.checked')),
                  h('dl', null, row('path.canonical', check.observation.canonicalPath),
                    row('path.expiry', h('time', { dateTime: check.expiresAt }, check.expiresAt))),
                  h('p', null, t(check.observation.exists ? 'path.exists' : 'path.missing')),
                  checkbox('path', 'path.ack', unavailable),
                  h('div', { className: 'juebot-actions' }, button('action.confirmPath', confirmPath,
                    unavailable || !ack.path || check.revision !== saved?.revision || view.checkInput !== draft.candidate
                      || Date.parse(check.expiresAt) <= Date.now()))) : null,
                saved?.dataPath.candidate !== null && saved ? h('div', { className: 'juebot-clear' },
                  checkbox('clearPath', 'path.clearAck', unavailable),
                  h('div', { className: 'juebot-actions' }, button('action.clearPath', clearPath, unavailable || !ack.clearPath))) : null),
              h('footer', { className: 'juebot-footnote juebot-muted', 'aria-labelledby': 'juebot-boundary-title' },
                h('h2', { id: 'juebot-boundary-title' }, t('boundary.title')),
                h('p', null, t('boundary.owner')), h('p', null, t('boundary.userOnly')),
                h('p', null, t('boundary.path')), h('p', null, t('boundary.scope')))));
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

capture({
  id: '@local/dsh-juebot',
  factory(require) {
    const React = require('react'), h = React.createElement;
    const PANEL = 'juebot', NS = 'juebot-agent';
    const DICTIONARIES = { zh: { nav: '撅撅', title: '撅撅 · 会话与审核', empty: '暂无已授权数据', unconfigured: '尚未配置或当前服务不可用', refresh: '刷新' },
      en: { nav: 'juebot', title: 'juebot · Conversations and review', empty: 'No authorized data', unconfigured: 'Not configured or unavailable', refresh: 'Refresh' } };
    const style = `.juebot-agent{height:100%;overflow:auto;box-sizing:border-box;padding:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit}.juebot-agent *{box-sizing:border-box}.juebot-agent .columns{display:grid;grid-template-columns:minmax(180px,24%) minmax(250px,1fr) minmax(230px,30%);gap:16px}.juebot-agent section{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px;min-width:0;margin-bottom:12px;background:var(--dsw-alias-bg-layer-1)}.juebot-agent button,.juebot-agent input,.juebot-agent textarea,.juebot-agent select{font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:7px;margin:3px;max-width:100%}.juebot-agent button{cursor:pointer}.juebot-agent button:disabled{opacity:.5;cursor:not-allowed}.juebot-agent button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary)}.juebot-agent textarea{width:100%;min-height:70px}.juebot-agent pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;font:inherit;font-size:12px}.juebot-agent .muted{color:var(--dsw-alias-label-secondary)}.juebot-agent .error{color:var(--dsw-alias-state-error-primary)}@media(max-width:900px){.juebot-agent .columns{grid-template-columns:1fr}}`;
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const items = value => Array.isArray(value?.items) ? value.items : [];
    const pretty = value => JSON.stringify(value, null, 2);
    function PanelIcon({ size = 22, active }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: active ? 2 : 1.5, 'aria-hidden': true },
        h('rect', { x: 4, y: 6, width: 16, height: 15, rx: 4 }), h('path', { d: 'M12 6V2M8 13h1m6 0h1M8 17h8' }));
    }
    return { inject: ['slots', 'locale', 'layout'], apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'juebot: agent locale');
      const label = ctx.locale.bind(NS);
      function AgentPage({ t = label }) {
        const [view, setView] = React.useState({ status: null, conversations: null, creations: null, outbox: null, code: null,
          events: null, settings: null, memory: null, self: null, creation: null, identity: null, learning: null, growth: null, mediaReady: {}, subtitleText: {}, bodies: {}, error: null, notice: null });
        const [selected, select] = React.useState(null), [tab, setTab] = React.useState('消息');
        const [prompt, setPrompt] = React.useState(''), [localText, setLocalText] = React.useState(''), [reason, setReason] = React.useState(''), [phrase, setPhrase] = React.useState('');
        const [profile, setProfile] = React.useState({ name: '', mode: 'juejue', roleCore: '' });
        const [restoreVersion, setRestoreVersion] = React.useState('');
        const [busy, setBusy] = React.useState(false);
        const mounted = React.useRef(false), controllers = React.useRef(new Set()), activeKey = React.useRef(null), activeWork = React.useRef(null), versions = React.useRef(new Map());
        const call = async (name, options = {}) => {
          const { query = {}, body = null, method = 'GET' } = options;
          const serial = (versions.current.get(name) ?? 0) + 1; versions.current.set(name, serial);
          const controller = new AbortController(); controllers.current.add(controller);
          const timeout = setTimeout(() => {
            if (mounted.current && method !== 'GET') setView(previous => ({ ...previous, notice: '写入结果未确认，请刷新核对；不会自动重试。' }));
            controller.abort();
          }, 8000);
          try {
            const qs = new URLSearchParams(query).toString();
            const response = await fetch('api/juebot/agent/' + name + (qs ? '?' + qs : ''), { method,
              credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
              headers: { Accept: 'application/json', ...(body === null ? {} : { 'Content-Type': 'application/json' }) },
              ...(body === null ? {} : { body: JSON.stringify(body) }) });
            if (controller.signal.aborted || !mounted.current || versions.current.get(name) !== serial) return null;
            if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw Error('INVALID_RESPONSE');
            const envelope = await response.json();
            if (!response.ok || !object(envelope) || envelope.ok !== true || !Object.hasOwn(envelope, 'data')) {
              const code = envelope?.error?.code;
              throw Error(typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'REQUEST_FAILED');
            }
            if (controller.signal.aborted || !mounted.current || versions.current.get(name) !== serial) return null;
            return envelope.data;
          } catch (error) {
            if (mounted.current && !controller.signal.aborted && versions.current.get(name) === serial) setView(previous => ({ ...previous,
              error: ['AGENT_UNAVAILABLE', 'STORAGE_FAILURE', 'NOT_CONFIGURED'].includes(error.message) ? t('unconfigured')
                : error.message === 'INTENTION_UNAVAILABLE' ? '原意愿已过期或其依据已失效，不能恢复；需形成新的有效意愿。'
                : ['CREATION_WORKFLOW_INVALID', 'CREATION_SOURCE_REVOKED', 'CREATION_SOURCE_CHANGED', 'CREATION_PUBLISH_NOT_AUTHORIZED', 'POLICY_CHANGED'].includes(error.message)
                  ? '来源、身份或权限已变化，恢复被拒绝。请核对当前授权。' : '请求未完成，请刷新核对。',
              ...(method !== 'GET' ? { notice: '写入结果未确认；不会自动重试。' } : {}) }));
            return null;
          } finally { clearTimeout(timeout); controllers.current.delete(controller); }
        };
        const load = async (name, query = {}, key = null) => {
          if (name === 'creation') activeWork.current = query.id;
          const data = await call(name, { query });
          if (data === null || !mounted.current || (key !== null && activeKey.current !== key)) return;
          if (name === 'creation' && activeWork.current !== query.id) return;
          setView(previous => ({ ...previous, [name]: data }));
          if (name === 'settings') setPrompt(data.local?.prompt ?? '');
          if (name === 'identity' && object(data.profile)) setProfile(data.profile);
        };
        const refresh = async () => {
          if (!mounted.current) return;
          setView(previous => ({ ...previous, error: null }));
          const key = activeKey.current;
          await Promise.all([...['status', 'conversations', 'creations', 'outbox', 'code', 'identity', 'learning'].map(name => load(name)),
            ...(activeWork.current === null ? [] : [load('creation', { id: activeWork.current })]),
            ...(key === null ? [] : ['settings', 'events', 'memory', 'self', 'growth'].map(name => load(name, { key }, key)))]);
        };
        React.useEffect(() => {
          mounted.current = true; void refresh();
          return () => { mounted.current = false; for (const controller of controllers.current) controller.abort(); controllers.current.clear(); };
        }, []);
        React.useEffect(() => {
          activeKey.current = selected;
          setView(previous => ({ ...previous, events: null, settings: null, memory: null, self: null, growth: null, bodies: {} }));
          if (selected !== null) for (const name of ['events', 'settings', 'memory', 'self', 'growth']) void load(name, { key: selected }, selected);
        }, [selected]);
        const mutate = async (name, body) => {
          if (busy) return;
          setBusy(true); setView(previous => ({ ...previous, error: null, notice: null }));
          try {
            const data = await call(name, { method: 'POST', body });
            if (data !== null && mounted.current) {
              setView(previous => ({ ...previous, notice: name === 'creation-recovery' && data.status === 'failed'
                ? '恢复未完成；草稿已保留，请核对失败状态。不会自动重试。' : '操作已确认；已重新读取当前状态。' }));
              await refresh();
            }
          } finally { if (mounted.current) setBusy(false); }
        };
        const button = (text, onClick, disabled = false) => h('button', { type: 'button', onClick, disabled: disabled || busy }, text);
        const selectConversation = key => {
          activeKey.current = key;
          setView(previous => ({ ...previous, events: null, settings: null, memory: null, self: null, growth: null, bodies: {} }));
          select(key);
        };
        const section = (title, ...children) => h('section', null, h('h3', null, title), ...children);
        const empty = () => h('p', { className: 'muted' }, t('empty'));
        const selectedRecord = items(view.conversations).find(item => item.key === selected);
        const eventRows = items(view.events);
        const readBody = async event => {
          const key = activeKey.current;
          const data = await call('body', { query: { key, sequence: String(event.bodyRef ?? event.sequence) } });
          if (data !== null && mounted.current && activeKey.current === key) setView(previous => ({ ...previous, bodies: { ...previous.bodies, [event.sequence]: data.body } }));
        };
        const work = view.creation?.value;
        const canRecover = work?.workflow && ['planning', 'producing', 'failed'].includes(work.workflow.phase)
          && work.workflow.reasonCode !== 'HUMAN_ABANDONED' && !work.approval && !work.submission;
        const manifest = work?.final?.manifest;
        const references = manifest ? [manifest.video, manifest.cover, ...(manifest.audio ?? []), ...(manifest.subtitles ?? []), ...(manifest.attachments ?? [])].filter(Boolean) : [];
        const mediaKey = reference => `${work?.id}:${work?.version}:${reference.previewRef}:${reference.sha256}`;
        const mediaUrl = reference => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(reference?.previewRef ?? '') && /^[a-f0-9]{64}$/.test(reference?.sha256 ?? '')
          ? 'api/juebot/agent/media?ref=' + encodeURIComponent(reference.previewRef) : null;
        const markMedia = (reference, ready) => { if (mounted.current) setView(previous => ({ ...previous, mediaReady: { ...previous.mediaReady, [mediaKey(reference)]: ready } })); };
        React.useEffect(() => {
          const controller = new AbortController(); controllers.current.add(controller);
          const timeout = setTimeout(() => controller.abort(), 8000);
          const pending = references.filter(reference => view.creation?.assetKinds?.[reference.previewRef] === 'subtitles');
          void Promise.all(pending.map(async reference => {
            let reader;
            try {
              const url = mediaUrl(reference); if (!url) return;
              const response = await fetch(url, { method: 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
              if (!response.ok || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/vtt' || !response.body) throw Error('INVALID_SUBTITLE');
              reader = response.body.getReader(); const parts = []; let size = 0;
              for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 262144) throw Error('SUBTITLE_TOO_LARGE'); parts.push(part.value); }
              const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
              const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (!text.startsWith('WEBVTT')) throw Error('INVALID_SUBTITLE');
              if (!mounted.current || controller.signal.aborted) return;
              setView(previous => ({ ...previous, subtitleText: { ...previous.subtitleText, [mediaKey(reference)]: text }, mediaReady: { ...previous.mediaReady, [mediaKey(reference)]: true } }));
            } catch { if (!controller.signal.aborted) markMedia(reference, false); }
            finally { try { void reader?.cancel().catch(() => {}); reader?.releaseLock(); } catch {} }
          })).finally(() => { clearTimeout(timeout); controllers.current.delete(controller); });
          return () => { clearTimeout(timeout); controller.abort(); controllers.current.delete(controller); };
        }, [work?.id, work?.version]);
        const mediaVerified = references.every(reference => mediaUrl(reference) && view.creation?.assetKinds?.[reference.previewRef] && view.mediaReady[mediaKey(reference)] === true);
        const assetPreview = reference => {
          if (!reference) return null;
          const url = mediaUrl(reference), kind = view.creation?.assetKinds?.[reference.previewRef];
          if (!url || !['video', 'audio', 'image', 'subtitles'].includes(kind)) return h('p', { className: 'error' }, '媒体类型或受控预览不可用，不能批准。');
          const common = { key: mediaKey(reference), src: url, onError: () => markMedia(reference, false), style: { maxWidth: '100%' } };
          let preview;
          if (kind === 'image') preview = h('img', { ...common, alt: '审核作品图片', onLoad: () => markMedia(reference, true) });
          else if (kind === 'audio') preview = h('audio', { ...common, controls: true, preload: 'metadata', onLoadedMetadata: () => markMedia(reference, true) });
          else if (kind === 'video') preview = h('video', { ...common, controls: true, preload: 'metadata', onLoadedMetadata: () => markMedia(reference, true) },
            ...(manifest?.subtitles ?? []).filter(item => mediaUrl(item)).map(item => h('track', { key: item.previewRef, kind: 'subtitles', label: item.previewRef, src: mediaUrl(item), srcLang: 'zh', default: true, onError: () => markMedia(item, false) })));
          else preview = h('pre', null, view.subtitleText[mediaKey(reference)] ?? '正在读取受控字幕预览…');
          return h('div', { key: mediaKey(reference) }, h('p', null, `${kind} · SHA-256：${reference.sha256}`), preview,
            view.mediaReady[mediaKey(reference)] === false ? h('p', { className: 'error' }, '预览加载失败，不能批准。') : null);
        };
        return h('div', { className: 'juebot-agent' }, h('style', null, style),
          h('h2', null, t('title')), button(t('refresh'), () => { void refresh(); }),
          button('返回对话', () => ctx.layout.selectPanel('conversation')),
          view.error ? h('p', { className: 'error', role: 'alert' }, view.error) : null,
          view.notice ? h('p', { role: 'status' }, view.notice) : null,
          h('p', { className: 'muted' }, '候选控制台；能力与数据按实际接线显示。没有接入时不显示虚构会话。'),
          section('撅撅状态', view.status ? h('div', null,
            h('p', null, `${view.status.name ?? '未配置'} · ${view.status.mode ?? '未配置'} · ${view.status.runtime ?? '未知'}`),
            h('p', null, `模型：${view.status.modelConfigured ? '已配置' : '未配置'}；出站：${view.status.paused ? '暂停' : '按权限控制'}`),
            h('pre', null, pretty(view.status.capabilities ?? [])),
            button(view.status.paused ? '解除出站暂停' : '暂停全部出站', () => { void mutate('pause', { expectedRevision: view.status.pauseRevision, paused: !view.status.paused }); }, !Number.isSafeInteger(view.status.pauseRevision))) : empty()),
          section('身份与角色核心', !view.identity ? empty() : h('div', null,
            h('label', null, '名字', h('input', { value: profile.name ?? '', maxLength: 128, onChange: event => setProfile(previous => ({ ...previous, name: event.target.value })) })),
            h('label', null, '模式', h('select', { value: profile.mode ?? 'juejue', onChange: event => {
              const mode = event.target.value; if (!['juejue', 'persona'].includes(mode)) return;
              const saved = view.identity?.profiles?.[mode];
              setProfile(previous => object(saved) && saved.mode === mode ? { ...saved } : { ...previous, mode });
              setView(previous => ({ ...previous, notice: object(saved) && saved.mode === mode
                ? '已载入目标模式的已保存档案；点击保存身份后才切换。' : '目标模式尚无保存档案，当前内容仅作草稿；请核对并显式保存。' }));
            } }, h('option', { value: 'juejue' }, '撅撅'), h('option', { value: 'persona' }, '人格'))),
            h('label', null, '角色核心', h('textarea', { value: profile.roleCore ?? '', onChange: event => setProfile(previous => ({ ...previous, roleCore: event.target.value })) })),
            button('保存身份', () => { void mutate('identity', { expectedRevision: view.identity.revision, profile }); }))),
          h('div', { className: 'columns' },
            h('div', null, section('会话列表', ...(!items(view.conversations).length ? [empty()] : items(view.conversations).map(item =>
              h('div', { key: item.key }, button(`${item.synthetic ? '[合成] ' : ''}${item.label || item.kind || '会话'} · ${item.status ?? '未知'}`, () => selectConversation(item.key)),
                h('small', null, `${item.connector ?? ''} / ${item.kind ?? ''}`))))),
              section('创作审核', ...(!items(view.creations).length ? [empty()] : items(view.creations).map(item =>
                h('div', { key: item.id }, button(`${item.id} · ${item.action} · ${item.stage} · v${item.version}`, () => { void load('creation', { id: item.id }); })))))),
            h('div', null, section(selectedRecord?.label || '当前会话',
              ...['消息', '轨迹', '记忆'].map(name => button(name, () => setTab(name), selected === null)),
              selected === null ? empty() : tab === '记忆'
                ? h('div', null, ...(!items(view.memory).length ? [empty()] : items(view.memory).map(item => h('article', { key: item.id }, h('h4', null, `${item.kind} · ${item.status}`), h('pre', null, item.text)))),
                  h('h4', null, '当前会话来源'), h('p', { className: 'muted' }, '撤销后将停止使用该来源及其派生记忆；此处不授予跨会话共享。'),
                  ...(Array.isArray(view.memory?.sources) && view.memory.sources.length ? view.memory.sources.map(source => h('article', { key: source.id },
                    h('p', null, `${source.id} · v${source.revision} · ${source.domain} · ${source.status}`),
                    h('p', null, `用途：${(source.purposes ?? []).join(' / ')}；期限：${source.expiresAt ?? '无固定期限'}`),
                    view.memory.canManageSources ? button(`撤销来源 ${source.id}`, () => { void mutate('memory', { key: selected, action: 'revoke-source', sourceId: source.id,
                      expectedPolicyRevision: view.memory.policyRevision, nextSourceRevision: source.revision + 1 }); }, source.status !== 'active'
                        || !Number.isSafeInteger(source.revision) || source.revision === Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(view.memory.policyRevision)) : null)) : [empty()]))
                : h('div', null, ...(!eventRows.length ? [empty()] : eventRows.map(event => h('article', { key: event.sequence },
                  h('p', null, `#${event.sequence} · ${event.eventType} · ${event.reasonCode} · ${event.occurredAt}`),
                  tab === '消息' && event.bodyRef ? button('按权限读取正文', () => { void readBody(event); }) : null,
                  Object.hasOwn(view.bodies, event.sequence) ? h('pre', null, view.bodies[event.sequence] ?? '无正文') : null))),
              view.events?.nextCursor ? button('加载后续事件', () => { void load('events', { key: selected, cursor: view.events.nextCursor }, selected); }) : null,
              h('p', { className: 'muted' }, '本地聊天仅供 local-test 会话；由配置的合成/测试模型处理。'),
              h('textarea', { 'aria-label': '本地测试消息', value: localText, disabled: selectedRecord?.connector !== 'local-test' || !view.status?.modelConfigured || busy, onChange: event => setLocalText(event.target.value) }),
              button('发送本地测试', () => { void mutate('local-message', { key: selected, text: localText }); }, selectedRecord?.connector !== 'local-test' || !view.status?.modelConfigured || !localText.trim())),
              work ? section('最终作品审核', h('p', null, `${work.id} · ${work.action} · ${work.stage} · v${work.version}`),
                h('pre', null, pretty(work.final?.manifest ?? { intention: work.intention, brief: work.brief, script: work.script })),
                h('pre', null, pretty({ sources: work.sources, finalHash: work.final?.manifestHash, approval: work.approval, review: work.review, submission: work.submission,
                  workflow: work.workflow, recoveryAudit: view.creation.recoveryAudit })),
                assetPreview(work.final?.manifest?.video), assetPreview(work.final?.manifest?.cover),
                ...(work.final?.manifest?.audio ?? []).map(assetPreview), ...(work.final?.manifest?.subtitles ?? []).map(assetPreview), ...(work.final?.manifest?.attachments ?? []).map(assetPreview),
                h('textarea', { 'aria-label': '审核理由', value: reason, maxLength: 4000, onChange: event => setReason(event.target.value) }),
                canRecover ? h('div', null,
                  h('p', { className: 'muted' }, '恢复须填写理由，并重新执行本地方案和制作；原意愿须仍有效，来源和权限须保持授权。恢复成品须再次人工审核，不会自动发布或自动重试。'),
                  button('人工恢复并重做本地准备', () => { void mutate('creation-recovery', { id: work.id, expectedRevision: view.creation.revision, action: 'recover', reason }); }, !reason.trim()),
                  button('放弃本次创作（不可恢复）', () => { void mutate('creation-recovery', { id: work.id, expectedRevision: view.creation.revision, action: 'abandon', reason }); }, !reason.trim())) : null,
                h('p', { className: 'muted' }, '逐项检查完整作品、来源、账号和目标；全部媒体预览加载后方可批准。脚本不能替代成片审核。'),
                button('批准最终作品（有效30分钟）', () => { void mutate('review', { id: work.id, expectedRevision: view.creation.revision, action: 'approve', expiresAt: Date.now() + 1800000 }); }, work.stage !== 'final-review' || !work.final || !mediaVerified || (work.workflow && work.workflow.phase !== 'ready')),
                button('拒绝', () => { void mutate('review', { id: work.id, expectedRevision: view.creation.revision, action: 'reject', reason }); }, !reason.trim() || work.stage === 'submission'),
                button('要求修改', () => { void mutate('review', { id: work.id, expectedRevision: view.creation.revision, action: 'changes', reason }); }, !reason.trim() || work.stage === 'submission'),
                button('提交已批准作品', () => { void mutate('submit', { id: work.id, expectedRevision: view.creation.revision }); }, work.stage !== 'approved' || !work.approval || work.approval.expiresAt <= Date.now())) : null),
            h('div', null, section('当前会话设置', !view.settings ? empty() : h('div', null,
              h('h4', null, '全局默认 / 局部值 / 最终值'), h('pre', null, pretty(view.settings)),
              h('h4', null, '全局权限（管理者显式设置）'),
              ...['receive', 'save', 'learn', 'reply', 'proactive'].map(permission => h('label', { key: 'global-' + permission },
                h('input', { type: 'checkbox', 'aria-label': '全局权限 ' + permission, checked: view.settings.global?.permissions?.[permission] === true, disabled: busy || view.settings.canManage !== true,
                  onChange: event => { void mutate('settings', { expectedRevision: view.settings.revision, patch: { permissions: { [permission]: event.target.checked } } }); } }),
                ({ receive: '全局接收', save: '全局保存', learn: '全局学习', reply: '全局回复', proactive: '全局主动联系' })[permission])),
              h('h4', null, '当前会话限制（不能突破全局禁用）'),
              h('label', null, '额外语气 Prompt', h('textarea', { value: prompt, onChange: event => setPrompt(event.target.value) })),
              h('p', { className: 'muted' }, '最终生效 Prompt（只读）'), h('pre', null, view.settings.effective?.prompt ?? ''),
              button('保存本会话 Prompt', () => { void mutate('settings', { key: selected, expectedRevision: view.settings.revision, patch: { prompt } }); }),
              ...['receive', 'save', 'learn', 'reply', 'proactive'].map(permission => h('label', { key: permission },
                h('input', { type: 'checkbox', checked: view.settings.effective?.permissions?.[permission] === true, disabled: busy,
                  onChange: event => { void mutate('settings', { key: selected, expectedRevision: view.settings.revision, patch: { permissions: { [permission]: event.target.checked } } }); } }),
                ({ receive: '接收', save: '保存', learn: '学习', reply: '回复', proactive: '主动联系' })[permission])),
              h('label', null, '参与程度（0–1）', h('input', { type: 'number', min: 0, max: 1, step: 0.1,
                value: view.settings.effective?.participation ?? 0, disabled: busy, onChange: event => { void mutate('settings', { key: selected, expectedRevision: view.settings.revision, patch: { participation: Number(event.target.value) } }); } })),
              h('label', null, h('input', { type: 'checkbox', checked: view.settings.effective?.typing?.enabled === true, disabled: busy,
                onChange: event => { void mutate('settings', { key: selected, expectedRevision: view.settings.revision, patch: { typing: { enabled: event.target.checked } } }); } }), '拟人打字等待'),
              h('label', null, '打字速度（字素/秒）', h('input', { type: 'number', min: 0.1, max: 1000, step: 1,
                value: view.settings.effective?.typing?.charsPerSecond ?? 12, disabled: busy, onChange: event => { void mutate('settings', { key: selected, expectedRevision: view.settings.revision, patch: { typing: { charsPerSecond: Number(event.target.value) } } }); } })),
              h('label', null, '禁用的最终表达', h('input', { type: 'text', value: phrase, maxLength: 256, onChange: event => setPhrase(event.target.value) })),
              button('添加本会话禁用短语', () => { void mutate('settings', { key: selected, expectedRevision: view.settings.revision, patch: { expressionRules: [...(view.settings.local?.expressionRules ?? []), { ruleId: 'ui-' + Date.now(), match: 'contains', phrase, action: 'blocked' }] } }); }, !phrase.trim()),
              button('本会话进一步隔离', () => { void mutate('settings', { key: selected, expectedRevision: view.settings.revision, patch: { memoryMode: 'isolated' } }); }),
              button('本会话继承全局记忆规则', () => { void mutate('settings', { key: selected, expectedRevision: view.settings.revision, patch: { memoryMode: 'inherit' } }); }),
              h('p', null, '隔离模式'), button('全局隔离', () => { void mutate('settings', { expectedRevision: view.settings.revision, patch: { mode: 'isolated' } }); }),
              button('受来源授权的共享', () => { void mutate('settings', { expectedRevision: view.settings.revision, patch: { mode: 'shared' } }); })))),
              section('当前会话自我状态', view.self ? h('pre', null, pretty(view.self.value)) : empty()),
              section('学习候选', ...(!items(view.learning).length ? [empty()] : items(view.learning).map(item => h('article', { key: item.id },
                h('pre', null, pretty(item)), button('接受学习候选 ' + item.id, () => { void mutate('learning', { id: item.id, accepted: true }); }, item.status !== 'pending'),
                button('拒绝学习候选 ' + item.id, () => { void mutate('learning', { id: item.id, accepted: false }); }, item.status !== 'pending'))))),
              section('成长版本', view.growth ? h('div', null, h('pre', null, pretty(view.growth)),
                h('label', null, '恢复已存在的成长版本', h('input', { value: restoreVersion, maxLength: 128, onChange: event => setRestoreVersion(event.target.value) })),
                button('恢复指定成长版本', () => { void mutate('growth', { key: selected, command: 'restore', version: restoreVersion, expectedStateRevision: view.growth.revision }); }, selected === null || !restoreVersion.trim() || !Number.isSafeInteger(view.growth.revision)),
                h('p', { className: 'muted' }, '只恢复已存在的适应层版本；不回退已发送内容，不生成虚构评测成绩。')) : empty()),
              section('Code 状态', view.code ? h('div', null, h('p', null, view.code.enabled ? '允许新任务' : '新任务关闭；已有任务及结果保留'),
                button(view.code.enabled ? '关闭新 Code 任务' : '开启新 Code 任务', () => { void mutate('code', { enabled: !view.code.enabled }); }), h('pre', null, pretty(view.code.tasks ?? []))) : empty()),
              section('出站日志', h('p', { className: 'muted' }, '结果不明时仅核对可信平台证据；此操作不会重发或更换账号。'),
                ...(items(view.outbox).length ? items(view.outbox).map(item => h('article', { key: item.id }, h('pre', null, pretty(item)),
                  item.status === 'unknown' ? button('核对发送结果', () => { void mutate('reconcile', { id: item.id, expectedRevision: view.outbox.revision }); }, !Number.isSafeInteger(view.outbox.revision)) : null)) : [empty()])))));
      }
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: NS }, AgentPage));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 40, label: () => label('nav') }, PanelIcon));
    } };
  }
});

if (definitions.length !== 2 || definitions.some(d => d.id !== '@local/dsh-juebot')) throw new Error('JUEBOT_CLIENT_SHAPE');
window.__ModuleLoader__.load({ id: '@local/dsh-juebot', factory(require) {
 const parts = definitions.map(d => d.factory(require));
 return { inject: [...new Set(parts.flatMap(p => p.inject))], apply(ctx) { for (const part of parts) part.apply(ctx); } };
} });
})();
