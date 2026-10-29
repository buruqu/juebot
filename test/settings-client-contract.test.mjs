import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import test from 'node:test';

const clientUrl = new URL('../candidates/0.2.0-dev.1/bundle/client.js', import.meta.url);
const source = readFileSync(clientUrl, 'utf8').replace(/\r\n/g, '\n');
const control = readFileSync(new URL('../src/control.ts', import.meta.url), 'utf8');

// Static contract checks only. Never execute the Client factory or simulate React/DOM/fetch.
function jsonConstant(name) {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, name);
  const valueStart = start + marker.length;
  const end = name === 'DICTIONARIES'
    ? source.indexOf('\n    // END_DICTIONARIES', valueStart)
    : source.indexOf(';', valueStart) + 1;
  assert.ok(end > valueStart, name);
  return JSON.parse(source.slice(valueStart, end).trim().replace(/;$/, ''));
}
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} → ${end}`);
  return source.slice(from, to);
}
function literals(text, name) {
  return [...text.matchAll(new RegExp(`\\b${name}\\(\\s*['"]([^'"]+)['"]`, 'g'))].map(match => match[1]);
}
const dictionaries = jsonConstant('DICTIONARIES');
const styles = source.match(/const STYLES = `([\s\S]*?)`;/)?.[1];
const requestSource = section('const send = React.useCallback(', '\n          React.useEffect(');
const acceptSource = section('function acceptState(', '\n    function initialView(');
const validateSource = section('function validateControl(', '\n    function errorKey(');

// Compiling a Script performs syntax validation; it does not run the module loader or factory.
test('candidate is syntactically valid JS with the original lazy module identity', () => {
  assert.doesNotThrow(() => new Script(source, { filename: fileURLToPath(clientUrl) }));
  assert.match(source, /^window\.__ModuleLoader__\.load\(\{/);
  assert.match(source, /id: '@local\/dsh-juebot'/);
  assert.match(source, /const PACKAGE_VERSION = '0\.2\.0-dev\.1'/);
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
});

test('React is the only import; existing native slot and locale dependencies are retained', () => {
  assert.deepEqual(literals(source, 'require'), ['react']);
  assert.match(source, /inject: \['slots', 'locale', 'layout'\]/);
  assert.doesNotMatch(source, /require\.async|\bimport\s*\(|@deepseek-ai\/dsh-client|host\.call|ctx\.remote/);
  assert.equal((source.match(/ctx\.slots\.inject\(/g) ?? []).length, 2);
  assert.equal((source.match(/ctx\.slots\.register\(/g) ?? []).length, 2);
  assert.match(source, /name: 'main', key: PANEL_ID, locale: NAMESPACE/);
  assert.match(source, /name: 'sidebar\.panellist', id: PANEL_ID, order: 40, label: \(\) => label\('nav'\)/);
  assert.match(source, /const PANEL_ID = 'juebot'/);
});

test('sidebar icon retains original props without owning navigation or another app', () => {
  const icon = section('function PanelIcon(', '\n    return {\n      inject:');
  assert.match(icon, /function PanelIcon\(\{ size, active \}\)/);
  assert.match(icon, /width: pixels, height: pixels/);
  assert.match(icon, /strokeWidth: active \?/);
  assert.doesNotMatch(icon, /onClick|selectPanel|h\('button'/);
  assert.equal((source.match(/selectPanel\(/g) ?? []).length, 1);
  assert.match(source, /\(\) => ctx\.layout\.selectPanel\(null\)/);
  assert.doesNotMatch(source, /\bdocument\.|createRoot|hydrateRoot|ReactDOM|appendChild|querySelector|innerHTML|dangerouslySetInnerHTML|h\(['"]iframe['"]/);
});

test('only the six agreed same-origin settings endpoints are available', () => {
  assert.deepEqual(jsonConstant('URLS'), {
    read: 'api/juebot/settings',
    identity: 'api/juebot/settings/identity',
    admin: 'api/juebot/settings/admin',
    check: 'api/juebot/settings/path/check',
    confirm: 'api/juebot/settings/path/confirm',
    clear: 'api/juebot/settings/path/clear',
  });
  assert.equal((source.match(/\bfetch\(/g) ?? []).length, 1);
  assert.doesNotMatch(source, /api\/juebot\/status|https?:\/\/|WebSocket|EventSource|XMLHttpRequest|directoryPicker/);
  assert.match(requestSource, /hasOwnProperty\.call\(URLS, operation\)/);
  assert.match(requestSource, /method: operation === 'read' \? 'GET' : 'POST'/);
  assert.match(requestSource, /credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error'/);
  assert.match(requestSource, /Accept: 'application\/json'/);
  assert.match(requestSource, /'Content-Type': 'application\/json'/);
  assert.match(requestSource, /body: JSON\.stringify\(body\)/);
  assert.doesNotMatch(source, /Authorization\s*:|Cookie\s*:|Origin\s*:|actor\s*:|role\s*:\s*['"]owner/);
});

test('every request is bounded and guarded by cancellation, latest response and unmount', () => {
  assert.match(source, /const REQUEST_TIMEOUT_MS = 8000/);
  assert.match(requestSource, /if \(!mounted\.current \|\| current\.current\.busy\) return/);
  assert.match(requestSource, /const serial = \+\+sequence\.current/);
  assert.match(requestSource, /request\.current\.abort\(\)/);
  assert.match(requestSource, /new AbortController\(\)/);
  assert.match(requestSource, /timedOut = true; controller\.abort\(\)/);
  assert.match(requestSource, /signal: controller\.signal/);
  assert.match(requestSource, /!mounted\.current \|\| serial !== sequence\.current \|\| controller\.signal\.aborted/);
  assert.match(requestSource, /clearTimeout\(timeout\)/);
  assert.match(source, /mounted\.current = false;\s*\+\+sequence\.current/);
  assert.match(source, /current\.current = \{ \.\.\.current\.current, busy: null \}/);
  assert.doesNotMatch(source, /setInterval|requestAnimationFrame|\.retry\(/);
});

test('successful HTTP and strictly validated envelopes are both required before success state', () => {
  assert.match(requestSource, /if \(!response\.ok \|\| envelope\?\.ok === false\)/);
  assert.match(requestSource, /response\.headers\.get\('content-type'\)/);
  assert.match(requestSource, /validateCheckEnvelope\(envelope, expectedRevision\)/);
  assert.match(requestSource, /validateStateEnvelope\(envelope, previousSaved\)/);
  assert.match(requestSource, /if \(result === null\) throw new Error\('INVALID_RESPONSE_ENVELOPE'\)/);
  assert.ok(requestSource.indexOf('if (result === null)') < requestSource.indexOf("notice: 'path.checked'"));
  assert.ok(requestSource.indexOf('if (result === null)') < requestSource.indexOf('acceptState(previous, result'));
  assert.match(source, /view\.notice === 'page\.saved' && !busy && view\.fresh \? 'success'/);
});

test('settings schemaVersion 1 is exact without coupling it to a diagnostic package generation', () => {
  assert.match(validateSource, /hasExactKeys\(value, STATE_FIELDS\)/);
  assert.match(validateSource, /value\.schemaVersion !== 1/);
  assert.match(source, /const STATE_FIELDS = \['schemaVersion', 'profileKey', 'revision', 'identity', 'admin', 'dataPath'\]/);
  assert.match(validateSource, /state\.profileKey !== previous\.profileKey \|\| state\.revision < previous\.revision/);
  assert.match(source, /Number\.isSafeInteger\(value\) && value >= 0/);
  assert.doesNotMatch(source, /schemaVersion !== 2|0\.1\.0-dev\.2|validateSnapshot/);
  assert.match(control, /schemaVersion: 1/);
});

test('full owner identity and admin shapes are strict and pending-proof is the only registered state', () => {
  assert.match(validateSource, /hasExactKeys\(identity, \['name', 'mode', 'personaCard'\]\)/);
  assert.match(validateSource, /isText\(identity\.name, 64\)/);
  assert.match(validateSource, /identity\.name\.trim\(\) !== identity\.name/);
  assert.match(validateSource, /isText\(identity\.personaCard, 8000, true\)/);
  assert.match(validateSource, /hasExactKeys\(admin, \['qq', 'bindingEpoch', 'proofState'\]\)/);
  assert.match(validateSource, /admin\.proofState !== \(admin\.qq === null \? 'unconfigured' : 'pending-proof'\)/);
  assert.doesNotMatch(source, /proofState\s*:\s*['"]verified|verified\s*:\s*true|adminVerified\s*:\s*true/);
  assert.match(control, /proofState: 'unconfigured' \| 'pending-proof'/);
});

test('data-path state includes exact confirmation shape and valid ISO/hash relationships', () => {
  assert.match(validateSource, /hasExactKeys\(dataPath, \['candidate', 'confirmedCandidate', 'approvedAt', 'fingerprint'\]\)/);
  assert.match(validateSource, /dataPath\.approvedAt !== null \|\| dataPath\.fingerprint !== null/);
  assert.match(validateSource, /dataPath\.candidate !== dataPath\.confirmedCandidate/);
  assert.match(validateSource, /!isDate\(dataPath\.approvedAt\) \|\| !isHash\(dataPath\.fingerprint\)/);
  assert.match(source, /new Date\(value\)\.toISOString\(\) === value/);
  assert.match(control, /candidate: string \| null; confirmedCandidate: string \| null; approvedAt: string \| null; fingerprint: string \| null/);
});

test('all five operational claims must be exact false before retaining the state', () => {
  assert.match(source, /const OPERATIONAL_FIELDS = \['adminVerified', 'storageBackendEnabled', 'qqConnected', 'modelsConnected', 'codeEnabled'\]/);
  assert.match(validateSource, /hasExactKeys\(value, \['ok', 'state', 'operational'\]\)/);
  assert.match(validateSource, /hasExactKeys\(value\.operational, OPERATIONAL_FIELDS\)/);
  assert.match(validateSource, /OPERATIONAL_FIELDS\.every\(key => value\.operational\[key\] === false\)/);
  assert.match(source, /saved && view\.fresh \? 'page\.inert' : saved \? 'page\.stale' : 'page\.unknown'/);
});

test('refresh preserves dirty fields individually unless discard was explicit', () => {
  assert.match(acceptSource, /const dirty = dirtyFields\(previous\)/);
  assert.match(acceptSource, /if \(!replaceAll\) for \(const key of dirty\)/);
  assert.match(acceptSource, /if \(!committedFields\.includes\(key\)\) draft\[key\] = previous\.draft\[key\]/);
  assert.match(requestSource, /options\.discard === true/);
  assert.match(source, /button\('action\.refresh', \(\) => \{ void send\('read'\); \}/);
  assert.match(source, /button\('action\.discard', \(\) => \{ void send\('read', null, \{ discard: true \}\); \}/);
  assert.match(acceptSource, /dirtyFields\(next\)\.length/);
  assert.match(dictionaries.zh['page.retained'], /草稿/);
});

test('conflict and uncertain write failures preserve drafts instead of claiming non-commit', () => {
  assert.doesNotMatch(requestSource, /response\.status === 409.*failure = 'error\.conflict'/);
  assert.match(source, /status === 409 && !\['CONTROL_REVISION_CONFLICT', 'PATH_CHECK_REQUIRED', 'PATH_CHANGED_RECHECK'\]\.includes\(value\.error\.code\)/);
  const failure = requestSource.slice(requestSource.indexOf('} catch {'));
  assert.doesNotMatch(failure, /draft\s*:|saved\s*:/);
  assert.match(failure, /notice: isWrite && failure !== 'error\.conflict' && failure !== 'error\.recheck' \? 'page\.mutationUnknown'/);
  assert.match(failure, /timedOut \? 'error\.timeout' : failure/);
  assert.match(dictionaries.zh['page.mutationUnknown'], /可能已保存/);
  assert.match(dictionaries.en['page.mutationUnknown'], /may already have committed/);
  assert.match(dictionaries.zh['error.conflict'], /草稿已保留/);
});

test('saving disables all editing and guarded handlers read a synchronous current view', () => {
  assert.match(source, /current\.current = next;\s*setView\(next\)/);
  assert.match(source, /if \(current\.current\.busy \|\| !DRAFT_FIELDS\.includes\(field\)\) return/);
  assert.match(source, /if \(current\.current\.busy\) return/);
  assert.match(source, /function canWrite\(\) \{ return current\.current\.saved && current\.current\.fresh && !current\.current\.busy; \}/);
  assert.match(source, /h\('fieldset', \{ className: 'juebot-fields', disabled: Boolean\(busy\) \|\| !saved \}/);
  assert.ok((source.match(/disabled: Boolean\(busy\) \|\| !saved/g) ?? []).length >= 3);
});

test('identity sends only a nonempty whitelisted patch with the loaded revision', () => {
  const save = section('function saveIdentity()', '\n          function saveAdmin(');
  assert.match(save, /const patch = \{\}/);
  assert.match(save, /for \(const key of \['name', 'mode', 'personaCard'\]\)/);
  assert.match(save, /if \(!Object\.keys\(patch\)\.length\) return/);
  assert.match(save, /send\('identity', \{ expectedRevision: state\.saved\.revision, patch \}\)/);
  assert.doesNotMatch(save, /\.\.\.state\.draft|admin|candidate|verified|actor|authorization/);
});

test('administrator number remains a string and both save and clear require explicit reset acknowledgement', () => {
  const save = section('function saveAdmin(', '\n          function checkPath(');
  assert.match(source, /type: 'text', inputMode: 'numeric', value: draft\.qq, maxLength: 20/);
  assert.match(save, /!current\.current\.ack\.admin/);
  assert.match(save, /const qq = clear \? null : state\.draft\.qq\.trim\(\)/);
  assert.match(save, /expectedRevision: state\.saved\.revision, qq, acknowledgeReset: true/);
  assert.match(source, /checkbox\('admin', 'admin\.ack', unavailable\)/);
  assert.match(source, /field === 'qq' \? \{ ack: \{ \.\.\.previous\.ack, admin: false \}/);
  assert.doesNotMatch(source, /type: 'number'|parseInt\(|parseFloat\(|Number\([^)]*qq/);
});

test('path checks validate revision, expiry, opaque token and opensDatabase false', () => {
  const check = section('function validateCheckEnvelope(', '\n    function errorKey(');
  assert.match(check, /hasExactKeys\(value, \['ok', 'check'\]\)/);
  assert.match(check, /\['revision', 'token', 'expiresAt', 'observation', 'opensDatabase'\]/);
  assert.match(check, /check\.revision !== expectedRevision \|\| check\.opensDatabase !== false/);
  assert.match(check, /check\.token\.length < 16/);
  assert.match(check, /isText\(check\.token, 128\)/);
  assert.match(check, /Date\.parse\(check\.expiresAt\) <= Date\.now\(\)/);
  assert.match(check, /\['canonicalPath', 'fingerprint', 'exists'\]/);
  assert.match(check, /typeof check\.observation\.exists !== 'boolean'/);
});

test('editing a candidate invalidates its check token and both path acknowledgements', () => {
  const edit = section('function edit(', '\n          function acknowledge(');
  assert.match(edit, /field === 'candidate' \? \{ check: null, checkInput: null, ack: \{ \.\.\.previous\.ack, path: false, clearPath: false \}/);
  assert.match(acceptSource, /check: null, checkInput: null, ack: \{ \.\.\.EMPTY_ACK \}/);
  assert.match(source, /return \(\) => clearTimeout\(expires\)/);
  assert.match(source, /previous\.check\?\.token === token/);
});

test('path confirmation rechecks input, revision, acknowledgement and expiry before posting the token', () => {
  const confirm = section('function confirmPath()', '\n          function clearPath()');
  assert.match(confirm, /!state\.ack\.path \|\| !state\.check \|\| state\.checkInput !== state\.draft\.candidate/);
  assert.match(confirm, /state\.check\.revision !== state\.saved\.revision/);
  assert.match(confirm, /Date\.parse\(state\.check\.expiresAt\) <= Date\.now\(\)/);
  assert.match(confirm, /send\('confirm', \{ expectedRevision: state\.saved\.revision, token: state\.check\.token, acknowledge: true \}\)/);
  assert.match(source, /checkbox\('path', 'path\.ack', unavailable\)/);
  const clear = section('function clearPath()', '\n\n          const { saved, draft');
  assert.match(clear, /!current\.current\.ack\.clearPath/);
  assert.match(clear, /send\('clear', \{ expectedRevision: current\.current\.saved\.revision, acknowledge: true \}\)/);
  assert.match(source, /checkbox\('clearPath', 'path\.clearAck', unavailable\)/);
});

test('tokens, fingerprints and profile keys are never rendered or persisted in browser storage', () => {
  const render = source.slice(source.indexOf("return h('section', { className: 'juebot-console'"));
  assert.doesNotMatch(render, /\.token|\.fingerprint|\.profileKey/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|console\.|\.stack\b|\.message\b/);
  assert.doesNotMatch(source, /JSON\.stringify\((?:envelope|result|view|saved|draft)/);
});

test('request errors use localised allowlisted codes and never raw response text', () => {
  const failure = section('function errorKey(', '\n    function draftOf(');
  assert.match(failure, /hasExactKeys\(value\.error, \['code'\]\)/);
  assert.match(failure, /hasOwnProperty\.call\(ERROR_TEXT, value\.error\.code\)/);
  assert.match(source, /t\(view\.error\)/);
  assert.doesNotMatch(source, /response\.text\(|h\([^\n]*value\.error\.code|String\(error\)/);
});

test('the page provides exactly three configuration cards and no business enable controls', () => {
  assert.equal((source.match(/className: 'juebot-section', 'aria-labelledby'/g) ?? []).length, 3);
  for (const key of ['identity.title', 'admin.title', 'path.title']) assert.ok(source.includes(`t('${key}')`));
  assert.match(source, /row\('path\.canonical', check\.observation\.canonicalPath\)/);
  assert.match(source, /check\.observation\.exists \? 'path\.exists' : 'path\.missing'/);
  assert.doesNotMatch(source, /role: 'tab'|role: 'tablist'|openStorage|DatabaseSync|PRAGMA|initializeStorage|startSession|createAgent|setPlugin|installBundle/);
  assert.match(dictionaries.zh['admin.description'], /个人 QQ.*不支持官方机器人 OpenID/);
  assert.match(dictionaries.en['admin.description'], /personal QQ.*OpenID is not supported/);
  assert.match(dictionaries.zh['admin.pending'], /待 QQ 私聊验证/);
  assert.match(dictionaries.zh['path.description'], /不创建、迁移或打开数据库/);
  assert.match(dictionaries.zh['path.clearAck'], /不删除任何文件/);
});

test('UI accurately discloses owner/API, user-only authority and path sandbox limitations', () => {
  assert.match(dictionaries.zh['boundary.owner'], /不等于每次真人点击证明/);
  assert.match(dictionaries.en['boundary.owner'], /not proof of a human click/);
  assert.match(dictionaries.zh['boundary.userOnly'], /不提供 Agent 工具/);
  assert.match(dictionaries.zh['boundary.path'], /不是 OS 沙箱/);
  assert.match(dictionaries.en['boundary.path'], /not an OS sandbox/);
});

test('zh/en dictionaries have matching keys and all visible text keys are discoverable', () => {
  assert.deepEqual(Object.keys(dictionaries).sort(), ['en', 'zh']);
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort());
  for (const [locale, dictionary] of Object.entries(dictionaries)) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, 'string', `${locale}.${key}`);
      assert.ok(value.trim(), `${locale}.${key}`);
    }
  }
  const after = source.slice(source.indexOf('// END_DICTIONARIES'));
  const keys = new Set([...after.matchAll(/['"]((?:page|action|identity|admin|path|boundary|error)\.[A-Za-z]+)['"]/g)].map(match => match[1]));
  keys.add('nav');
  for (const key of keys) assert.ok(Object.hasOwn(dictionaries.zh, key), `missing key ${key}`);
  assert.match(source, /ctx\.effect\(\(\) => ctx\.locale\.register\(NAMESPACE, DICTIONARIES\)/);
  assert.match(source, /const label = ctx\.locale\.bind\(NAMESPACE\)/);
  assert.match(source, /function JuebotPage\(\{ t \}\)/);
});

test('component-local styles only use existing theme tokens and responsive layout', () => {
  assert.ok(styles);
  const allowed = new Set([
    '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
    '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
    '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-brand-primary',
    '--dsw-alias-state-warn-primary', '--dsw-alias-state-error-primary', '--dsw-alias-state-success-primary',
  ]);
  for (const [, token] of styles.matchAll(/var\((--[a-z0-9-]+)/g)) assert.ok(allowed.has(token), token);
  assert.doesNotMatch(styles, /#[a-f\d]{3,8}\b|rgba?\(|hsla?\(|(?:^|[},])\s*(?:body|html|:root)\b|position\s*:\s*fixed/i);
  for (const [, selector] of styles.matchAll(/([^{}]+)\{/g)) {
    assert.ok(selector.trim().startsWith('.juebot-console') || selector.trim().startsWith('@media'), selector);
  }
  assert.match(source, /h\('style', null, STYLES\)/);
  assert.match(source, /'aria-live': 'polite'/);
  assert.match(source, /role: 'alert'/);
});
