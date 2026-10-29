import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import test from 'node:test';

const clientUrl = new URL('../bundle/client.js', import.meta.url);
const source = readFileSync(clientUrl, 'utf8');

// Static-only checks: compile the script, but never execute its factory or emulate React/DOM.
function jsonConstant(name) {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must be declared`);
  const valueStart = start + marker.length;
  const end = source.indexOf(';', valueStart);
  assert.notEqual(end, -1, `${name} must terminate`);
  // DICTIONARIES contain prose semicolons, so use their explicit source boundary.
  const valueEnd = name === 'DICTIONARIES'
    ? source.indexOf('\n    // END_DICTIONARIES', valueStart) : end + 1;
  return JSON.parse(source.slice(valueStart, valueEnd).trim().replace(/;$/, ''));
}

const dictionaries = jsonConstant('DICTIONARIES');
const styles = source.match(/const STYLES = `([\s\S]*?)`;/)?.[1];

function literalCalls(text, name) {
  return [...text.matchAll(new RegExp(`\\b${name}\\(\\s*['"]([^'"]+)['"]`, 'g'))].map(match => match[1]);
}

test('Client artifact is syntactically valid plain JavaScript without evaluating it', () => {
  assert.doesNotThrow(() => new Script(source, { filename: fileURLToPath(clientUrl) }));
  assert.match(source, /^window\.__ModuleLoader__\.load\(\{/);
  assert.match(source, /id: '@local\/dsh-juebot'/);
  assert.match(source, /factory\(require\)/);
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
});

test('React is the sole module request, with no Harness UI or dynamic-runner shortcuts', () => {
  assert.deepEqual(literalCalls(source, 'require'), ['react']);
  assert.doesNotMatch(source, /require\.async|\bimport\s*\(|host\.call|styles\.insert/);
  assert.doesNotMatch(source, /@deepseek-ai\/dsh-client/);
  assert.match(source, /inject: \['slots', 'locale', 'layout'\]/);
});

test('exactly one additional main key and one sidebar icon are registered', () => {
  assert.equal((source.match(/ctx\.slots\.register\(/g) ?? []).length, 2);
  assert.equal((source.match(/ctx\.slots\.inject\(/g) ?? []).length, 2);
  assert.match(source, /const PANEL_ID = 'juebot'/);
  assert.match(source, /ctx\.slots\.inject\('main', \(\) => ctx\.slots\.register\(\{\s*name: 'main', key: PANEL_ID, locale: NAMESPACE\s*\}, JuebotPage\)\)/);
  assert.match(source, /ctx\.slots\.inject\('sidebar\.panellist', \(\) => ctx\.slots\.register\(\{\s*name: 'sidebar\.panellist', id: PANEL_ID, order: 40, label: \(\) => label\('nav'\)\s*\}, PanelIcon\)\)/);
  assert.doesNotMatch(source, /(?:name|key):\s*['"](?:root|conversation|sidebar|shell\.overlay)['"]/);
});

test('sidebar contribution consumes size and active but owns no button or navigation', () => {
  const icon = source.slice(source.indexOf('function PanelIcon('), source.indexOf('\n    return {\n      inject:'));
  assert.match(icon, /function PanelIcon\(\{ size, active \}\)/);
  assert.match(icon, /width: pixels, height: pixels/);
  assert.match(icon, /strokeWidth: active \?/);
  assert.match(icon, /'aria-hidden': true/);
  assert.doesNotMatch(icon, /h\('button'|onClick|selectPanel/);
});

test('locale dictionaries are owned effects and main receives the framework t seat', () => {
  assert.match(source, /const NAMESPACE = 'juebot'/);
  assert.match(source, /ctx\.effect\(\(\) => ctx\.locale\.register\(NAMESPACE, DICTIONARIES\)/);
  assert.match(source, /const label = ctx\.locale\.bind\(NAMESPACE\)/);
  assert.match(source, /function JuebotPage\(\{ t \}\)/);
});

test('navigation is only the explicit return-to-conversation view action', () => {
  assert.equal((source.match(/selectPanel\(/g) ?? []).length, 1);
  assert.match(source, /onClick: \(\) => ctx\.layout\.selectPanel\(null\)/);
  assert.doesNotMatch(source, /\b(?:location|history)\s*\.\s*[a-zA-Z_$]|window\.open|startSession|createSession/);
});

test('only the agreed bounded same-origin GET reads Host status', () => {
  assert.match(source, /const STATUS_URL = 'api\/juebot\/status'/);
  assert.match(source, /const REQUEST_TIMEOUT_MS = 8000/);
  assert.equal((source.match(/\bfetch\(/g) ?? []).length, 1);
  assert.match(source, /fetch\(STATUS_URL, \{\s*method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller\.signal\s*\}\)/);
  assert.doesNotMatch(source, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]|WebSocket|EventSource|XMLHttpRequest/);
  assert.doesNotMatch(source, /https?:\/\//);
});

test('schema version, package generation and inert module claims are checked before display', () => {
  assert.match(source, /hasExactKeys\(value, STATUS_FIELDS\)/);
  assert.match(source, /value\.schemaVersion !== 1/);
  assert.match(source, /value\.packageVersion !== '0\.1\.0-dev\.2'/);
  assert.match(source, /value\.mode !== 'diagnostics-only'/);
  assert.match(source, /value\.backendDefaultDisabled !== true/);
  assert.match(source, /value\.persistentStorage !== 'not-opened-by-console'/);
  for (const field of ['qq', 'models', 'code']) {
    assert.ok(source.includes(`value.${field} !== 'not-connected'`));
  }
  assert.match(source, /const snapshot = validateSnapshot\(await response\.json\(\)\)/);
  assert.match(source, /if \(snapshot === null\) throw new Error\('INVALID_STATUS_SNAPSHOT'\)/);
  assert.match(source, /new Date\(value\.capturedAt\)\.toISOString\(\) !== value\.capturedAt/);
});

test('the finite diagnostic enum contract matches the Host status schema', () => {
  assert.deepEqual(jsonConstant('CHECK_VALUES'), {
    driver: ['ok', 'unavailable', 'error'],
    schema: ['ok', 'error', 'not-run'],
    fts5: ['ok', 'error', 'not-run'],
    shortQuery: ['ok', 'error', 'not-run'],
    privacy: ['ok', 'error', 'not-run'],
    cleanup: ['ok', 'error', 'not-needed'],
  });
  assert.deepEqual(Object.keys(jsonConstant('FAILURE_TEXT')), [
    'SQLITE_MODULE_UNAVAILABLE', 'SQLITE_OPEN_FAILED', 'SCHEMA_PROBE_FAILED',
    'ROUNDTRIP_FAILED', 'CLEANUP_FAILED',
  ]);
  assert.match(source, /hasExactKeys\(value\.checks, Object\.keys\(CHECK_VALUES\)\)/);
  assert.match(source, /values\.includes\(value\.checks\[key\]\)/);
  assert.match(source, /hasOwnProperty\.call\(FAILURE_TEXT, value\.failureCode\)/);
});

test('success color is gated by fresh structurally validated and fully passing diagnostics', () => {
  assert.match(source, /const fresh = phase === 'ready'/);
  assert.match(source, /const mayUseSuccess = fresh && diagnosticsPassed\(snapshot\)/);
  assert.match(source, /snapshot\.failureCode === null && snapshot\.sqliteVersion !== null/);
  assert.match(source, /Object\.keys\(CHECK_VALUES\)\.every\(key => snapshot\.checks\[key\] === 'ok'\)/);
  assert.match(source, /const tone = !fresh \? 'idle'/);
  assert.match(source, /value === 'ok' && mayUseSuccess \? 'success' : 'idle'/);
});

test('request lifetime uses latest-wins, AbortController, timeout and unmount guards', () => {
  assert.match(source, /const revision = \+\+sequence\.current/);
  assert.match(source, /if \(request\.current\) request\.current\.abort\(\)/);
  assert.match(source, /const controller = new AbortController\(\)/);
  assert.match(source, /mounted\.current && revision === sequence\.current && !controller\.signal\.aborted/);
  assert.match(source, /if \(!mounted\.current \|\| revision !== sequence\.current\) return/);
  assert.match(source, /mounted\.current = false;\s*\+\+sequence\.current/);
  assert.match(source, /clearTimeout\(timeout\)/);
  assert.equal((source.match(/clearTimeout\(deadline\.current\)/g) ?? []).length, 2);
  assert.match(source, /timedOut \? 'error\.timeout' : failure/);
  assert.doesNotMatch(source, /setInterval|requestAnimationFrame/);
});

test('retained snapshots lose freshness and explicitly disclose stale reads', () => {
  assert.match(source, /phase: 'error', snapshot: previous\.snapshot/);
  assert.match(source, /const stale = snapshot !== null && !fresh/);
  assert.match(source, /'snapshot\.refreshingOld' : 'snapshot\.stale'/);
  assert.match(dictionaries.zh['snapshot.stale'], /旧快照/);
  assert.match(dictionaries.en['snapshot.stale'], /old/);
});

test('failure presentation is allowlisted, never raw error or response details', () => {
  assert.match(source, /\} catch \{/);
  assert.doesNotMatch(source, /\b(?:error|err|failure)\.(?:message|stack)|JSON\.stringify\(|console\./);
  assert.match(source, /t\(FAILURE_TEXT\[snapshot\.failureCode\]\)/);
  assert.match(source, /state\.error \? h\('div', null, t\(state\.error\)\)/);
});

test('zh/en dictionaries are complete and every static or mapped visible key exists', () => {
  assert.deepEqual(Object.keys(dictionaries).sort(), ['en', 'zh']);
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort());
  for (const [locale, dictionary] of Object.entries(dictionaries)) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, 'string', `${locale}.${key}`);
      assert.ok(value.trim(), `${locale}.${key} is empty`);
    }
  }
  const used = new Set(literalCalls(source, 't'));
  for (const name of ['CHECK_LABELS', 'CHECK_TEXT', 'FAILURE_TEXT']) {
    for (const key of Object.values(jsonConstant(name))) used.add(key);
  }
  for (const row of jsonConstant('MODULE_ROWS')) for (const key of row) used.add(key);
  for (const [, key] of jsonConstant('PENDING_ROWS')) used.add(key);
  const sourceAfterDictionaries = source.slice(source.indexOf('// END_DICTIONARIES'));
  for (const match of sourceAfterDictionaries.matchAll(/['"]((?:action|snapshot|error)\.[a-zA-Z]+)['"]/g)) used.add(match[1]);
  used.add('nav');
  for (const key of used) assert.ok(Object.hasOwn(dictionaries.zh, key), `missing locale key: ${key}`);
});

test('CSS is local to the allocated component and uses only inspected color tokens', () => {
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
});

test('page remains a read-only three-region view without a second app or configuration controls', () => {
  for (const title of ['host.title', 'boundary.title', 'pending.title']) assert.ok(source.includes(`t('${title}')`));
  assert.equal((source.match(/h\('button'/g) ?? []).length, 2);
  assert.doesNotMatch(source, /h\(['"](?:iframe|form|input|textarea|select)['"]|dangerouslySetInnerHTML|createRoot|hydrateRoot|ReactDOM/);
  assert.doesNotMatch(source, /\bdocument\.|appendChild|querySelector|innerHTML|localStorage|sessionStorage/);
  assert.equal((source.match(/\bwindow\./g) ?? []).length, 1);
  assert.match(dictionaries.zh['boundary.description'], /不是整个 Loader/);
  assert.match(dictionaries.zh['host.description'], /Host 激活时/);
  assert.match(dictionaries.zh['pending.recovery'], /不终止已运行任务/);
});
