#!/usr/bin/env node
/**
 * Offline capability probe for JUEBOT-Q011. Only Node built-ins and synthetic data.
 * Run from juebot: node scripts/probe-sqlite.mjs
 * Writes only ../evidence/2026-10-28-sqlite-probe.json relative to this script.
 * Every database is :memory:, with temp_store=MEMORY and allowExtension=false.
 * Failures/unavailable capabilities are recorded and produce a nonzero exit code.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const evidencePath = fileURLToPath(
  new URL('../evidence/2026-10-28-sqlite-probe.json', import.meta.url),
);

// Preserve values that ordinary JSON would silently lose (NaN, binary, bigint).
function jsonValue(value) {
  if (typeof value === 'bigint') return { type: 'bigint', value: String(value) };
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { type: 'non-finite-number', value: String(value) };
  }
  if (value instanceof Uint8Array) {
    return { type: 'bytes', hex: Buffer.from(value).toString('hex') };
  }
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  }
  return value === undefined ? null : value;
}

function errorInfo(error) {
  return {
    name: error?.name ?? 'UnknownError',
    message: String(error?.message ?? error),
    code: error?.code ?? null,
    errcode: error?.errcode ?? null,
    errstr: error?.errstr ?? null,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Binding a MATCH argument protects SQL, not the embedded FTS5 query language.
// Double each double-quote, then quote the entire input as one FTS5 phrase.
function matchLiteral(text) {
  assert.equal(typeof text, 'string');
  return `"${text.replaceAll('"', '""')}"`;
}

function compensatedSum(values) {
  let sum = 0;
  let correction = 0;
  for (const value of values) {
    const next = sum + value;
    correction += Math.abs(sum) >= Math.abs(value)
      ? (sum - next) + value
      : (value - next) + sum;
    sum = next;
  }
  return sum + correction;
}

// Independent max-abs scaling avoids overflowing/underflowing the squared norm.
// Compensated sums reduce rounding loss; this remains finite-precision arithmetic.
function stableCosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    throw new RangeError('Vectors must have the same nonzero dimension.');
  }
  let scaleA = 0;
  let scaleB = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (!Number.isFinite(a[index]) || !Number.isFinite(b[index])) {
      throw new TypeError('Every component must be a finite number.');
    }
    scaleA = Math.max(scaleA, Math.abs(a[index]));
    scaleB = Math.max(scaleB, Math.abs(b[index]));
  }
  if (scaleA === 0 || scaleB === 0) throw new RangeError('Cosine is undefined for zero vectors.');
  const x = a.map((value) => value / scaleA);
  const y = b.map((value) => value / scaleB);
  const dot = compensatedSum(x.map((value, index) => value * y[index]));
  const normX = Math.sqrt(compensatedSum(x.map((value) => value * value)));
  const normY = Math.sqrt(compensatedSum(y.map((value) => value * value)));
  return Math.max(-1, Math.min(1, dot / (normX * normY)));
}

const evidence = {
  schemaVersion: 1,
  question: 'JUEBOT-Q011: standalone local Node SQLite capability probe, not production acceptance',
  collectedAt: new Date().toISOString(),
  runtime: {
    executable: process.execPath,
    node: process.version,
    execArguments: [...process.execArgv],
    platform: process.platform,
    architecture: process.arch,
    versions: { ...process.versions },
    workingDirectory: process.cwd(),
    script: scriptPath,
    scriptSha256: sha256(readFileSync(scriptPath)),
  },
  method: {
    driver: 'node:sqlite / DatabaseSync',
    database: ':memory:',
    extensionLoading: 'Explicit allowExtension=false; no enableLoadExtension/loadExtension calls.',
    temporaryStorage: 'PRAGMA temp_store=MEMORY for every independent database.',
    data: 'Inline synthetic fixtures only; no existing chat, credential, business or model data.',
    repetitions: 2,
    comparison: 'SHA-256 of complete feature assertions, SQL text, bindings, results and expected errors.',
    subprocesses: 0,
    networkCalls: 0,
    packageInstallations: 0,
    output: evidencePath,
    expectedFailurePolicy: 'Expected negative cases pass only if the asserted error is observed.',
    unavailablePolicy: 'Missing driver/features are recorded as unavailable/failed, never silently skipped.',
  },
  limitations: [
    'Only this standalone Node executable/version/platform is tested. DSH Host integration, bundling, ASAR/native ABI, other Node versions and the declared minimum Node version are not tested.',
    'No disk database is opened. File persistence, reopen/crash recovery, WAL, multi-process locking, concurrent writers, backups, migrations on real data and physical deletion are not tested.',
    'unicode61 does not perform Chinese word segmentation: a contiguous Chinese sequence can be one token. The fixtures do not establish general Chinese retrieval quality.',
    'FTS5 trigram MATCH needs at least three Unicode code points; two-code-point inputs return no MATCH rows in the tested fixtures. JavaScript string.length counts UTF-16 code units, so use Array.from(text).length for this boundary.',
    'instr(body, ?) provides literal case-sensitive substring fallback, including two-code-point inputs and punctuation. It is a scan fallback, not proof of an indexed or fast search path; no performance/scale benchmark is performed.',
    'SQL binding and FTS5 phrase escaping are separate protections. Phrase escaping disables MATCH operators but does not make every tokenizer perform exact substring matching; quotes and punctuation behavior here are specifically tested with trigram.',
    'No Unicode normalization, Chinese segmentation, simplified/traditional conversion, fuzzy recall or relevance-quality evaluation is implemented. Empty search inputs need a product policy and are not given a match-all fallback here.',
    'JSON support is established by executed JSON functions, not by requiring an ENABLE_JSON1 compile option. Only the listed JSON operations and failure cases are tested.',
    'application_id/user_version rollback and commit are observed on an in-memory connection, not durable database-header writes or a production migration protocol.',
    'Synthetic vectors test a scaled, compensated JavaScript cosine formula and an exhaustive small-array ranking after JSON storage. This is not an ANN/vector index, SQL vector extension, embedding/model call, semantic-quality test or production vector-storage decision.',
    'Cosine is finite-precision arithmetic: scaling reduces norm overflow/underflow but does not promise exact arbitrary-dynamic-range arithmetic. Zero/non-finite/dimension-invalid vectors are explicitly rejected.',
    'No npm dependency, external extension, QQ connection, model, plugin lifecycle, service restart or legacy maibot modification is involved. This evidence alone does not resolve all of Q011.',
  ],
  warnings: [],
  driver: null,
  runs: [],
  reproducibility: null,
  summary: null,
};

process.on('warning', (warning) => evidence.warnings.push(errorInfo(warning)));

function runDatabaseFeature(DatabaseSync, id, label, body) {
  const feature = { id, label, status: 'running', assertions: [], queries: [], observations: {} };
  let database;
  function check(name, actual, expected) {
    const entry = { name, actual: jsonValue(actual), expected: jsonValue(expected), status: 'running' };
    feature.assertions.push(entry);
    try {
      assert.deepEqual(entry.actual, entry.expected, name);
      entry.status = 'passed';
    } catch (error) {
      entry.status = 'failed';
      throw error;
    }
  }
  function expectError(name, action, predicate) {
    let caught;
    try {
      action();
    } catch (error) {
      caught = error;
    }
    feature.observations[name] = caught ? errorInfo(caught) : null;
    check(name, Boolean(caught && predicate(caught)), true);
  }
  function sql(operation, text, parameters = []) {
    const query = { operation, sql: text, parameters: jsonValue(parameters) };
    feature.queries.push(query);
    try {
      const result = operation === 'exec'
        ? database.exec(text)
        : database.prepare(text)[operation](...parameters);
      query.result = jsonValue(result);
      return query.result;
    } catch (error) {
      query.error = errorInfo(error);
      throw error;
    }
  }
  try {
    database = new DatabaseSync(':memory:', { allowExtension: false });
    sql('exec', 'PRAGMA temp_store = MEMORY');
    check('temporary storage stays in memory', sql('get', 'PRAGMA temp_store'), { temp_store: 2 });
    body({ sql, check, expectError, observations: feature.observations });
    const databases = sql('all', 'PRAGMA database_list');
    check('main database has no filesystem path', databases.some((item) => item.name === 'main' && item.file === ''), true);
    check('no attached database has a filesystem path', databases.every((item) => item.file === ''), true);
    feature.status = 'passed';
  } catch (error) {
    feature.status = 'failed';
    feature.error = errorInfo(error);
  } finally {
    if (database) {
      try {
        database.close();
        feature.databaseClosed = true;
      } catch (error) {
        feature.status = 'failed';
        feature.closeError = errorInfo(error);
      }
    }
  }
  return feature;
}

const sqliteError = (pattern) => (error) => error.code === 'ERR_SQLITE_ERROR' && pattern.test(error.message);

const features = [
  ['engine', 'SQLite version, compile options and memory journal', ({ sql, check, observations }) => {
    const version = sql('get', 'SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId');
    const options = sql('all', 'PRAGMA compile_options').map((row) => row.compile_options).sort();
    observations.sqlite = version;
    observations.compileOptions = options;
    check('SQLite version is available', /^3\.\d+\.\d+$/.test(version.version), true);
    check('SQLite source id is available', version.sourceId.length > 0, true);
    if (process.versions.sqlite) check('runtime sqlite version agrees with SQL', version.version, process.versions.sqlite);
    check('compile options are present', options.length > 0, true);
    check('FTS5 is compiled in', sql('get', "SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled"), { enabled: 1 });
    check('memory journal selected', sql('get', 'PRAGMA journal_mode'), { journal_mode: 'memory' });
  }],
  ['json', 'JSON functions, Unicode payloads and malformed JSON', ({ sql, check, expectError }) => {
    const payload = JSON.stringify({ name: '南京市', count: 2, enabled: true, tags: ['中文', "O'Reilly"] });
    check('JSON extraction preserves types and Unicode', sql('get',
      "SELECT json_valid(?) AS valid, json_extract(?, '$.name') AS name, json_extract(?, '$.count') AS count, json_extract(?, '$.enabled') AS enabled, json_array_length(?, '$.tags') AS tags",
      [payload, payload, payload, payload, payload]),
    { valid: 1, name: '南京市', count: 2, enabled: 1, tags: 2 });
    check('json_each enumerates the array', sql('all',
      "SELECT key, value, type FROM json_each(?, '$.tags') ORDER BY CAST(key AS INTEGER)", [payload]),
    [{ key: 0, value: '中文', type: 'text' }, { key: 1, value: "O'Reilly", type: 'text' }]);
    check('json_set updates a bound scalar', sql('get',
      "SELECT json_extract(json_set(?, '$.count', ?), '$.count') AS updated", [payload, 3]), { updated: 3 });
    check('malformed JSON is invalid', sql('get', 'SELECT json_valid(?) AS valid', ['{"broken":']), { valid: 0 });
    expectError('malformed JSON extraction is rejected',
      () => sql('get', "SELECT json_extract(?, '$.broken')", ['{"broken":']), sqliteError(/malformed JSON/i));
  }],
  ['binding_transactions', 'SQL binding, rollback, transactional DDL and constraint failure', ({ sql, check, expectError }) => {
    sql('exec', 'CREATE TABLE records (id INTEGER PRIMARY KEY, body TEXT NOT NULL UNIQUE, optional TEXT, raw BLOB, amount REAL)');
    const body = '合成 O\'Reilly "双引号" 😀；\'); DROP TABLE records; --';
    const bound = { ':body': body, ':optional': null, ':raw': new Uint8Array([0, 39, 34, 255]), ':amount': 1.25 };
    check('named binding inserts exactly one row', sql('run',
      'INSERT INTO records(body, optional, raw, amount) VALUES (:body, :optional, :raw, :amount)', [bound]),
    { lastInsertRowid: 1, changes: 1 });
    const before = [{ id: 1, body, optional: null, raw: { type: 'bytes', hex: '002722ff' }, amount: 1.25 }];
    check('text/blob/null/real roundtrip unchanged', sql('all', 'SELECT * FROM records ORDER BY id'), before);
    check('positional binding finds exact malicious-looking text', sql('all', 'SELECT id FROM records WHERE body = ?', [body]), [{ id: 1 }]);
    check('SQL injection text cannot broaden predicate', sql('all', 'SELECT id FROM records WHERE body = ?', ["' OR 1=1 --"]), []);
    sql('exec', 'BEGIN IMMEDIATE');
    sql('run', 'UPDATE records SET body = ? WHERE id = ?', ['transient update', 1]);
    sql('run', 'INSERT INTO records(body) VALUES (?)', ['transient insert']);
    sql('exec', 'CREATE TABLE rollback_only (id INTEGER PRIMARY KEY)');
    check('writes are visible inside transaction', sql('all', 'SELECT body FROM records ORDER BY id'),
      [{ body: 'transient update' }, { body: 'transient insert' }]);
    sql('exec', 'ROLLBACK');
    check('rollback restores original row and removes inserted row', sql('all', 'SELECT * FROM records ORDER BY id'), before);
    check('transactional DDL is also rolled back', sql('all', 'SELECT name FROM sqlite_schema WHERE name = ?', ['rollback_only']), []);
    sql('exec', 'BEGIN');
    sql('run', 'INSERT INTO records(body) VALUES (?)', ['before constraint failure']);
    expectError('duplicate UNIQUE value is rejected',
      () => sql('run', 'INSERT INTO records(body) VALUES (?)', [body]), sqliteError(/UNIQUE constraint failed/i));
    check('statement error alone did not roll back earlier writes', sql('get', 'SELECT count(*) AS count FROM records'), { count: 2 });
    sql('exec', 'ROLLBACK');
    check('explicit rollback after error restores baseline', sql('all', 'SELECT * FROM records ORDER BY id'), before);
  }],
  ['fts5_unicode61', 'unicode61 Chinese tokenization limitations', ({ sql, check, observations }) => {
    sql('exec', "CREATE VIRTUAL TABLE words USING fts5(body, tokenize='unicode61')");
    const fixtures = [[1, '南京市长江大桥'], [2, '南京市 长江 大桥'], [3, 'Alpha beta']];
    for (const row of fixtures) sql('run', 'INSERT INTO words(rowid, body) VALUES (?, ?)', row);
    sql('exec', "CREATE VIRTUAL TABLE unicode_terms USING fts5vocab(words, 'row')");
    const terms = sql('all', 'SELECT term, doc, cnt FROM unicode_terms ORDER BY term');
    check('contiguous Chinese text forms one token', terms, [
      { term: 'alpha', doc: 1, cnt: 1 }, { term: 'beta', doc: 1, cnt: 1 },
      { term: '南京市', doc: 1, cnt: 1 }, { term: '南京市长江大桥', doc: 1, cnt: 1 },
      { term: '大桥', doc: 1, cnt: 1 }, { term: '长江', doc: 1, cnt: 1 },
    ]);
    const cases = [['南京市长江大桥', [1]], ['南京市', [2]], ['长江', [2]], ['南京', []], ['ALPHA', [3]]];
    observations.literalMatchCases = [];
    for (const [text, expected] of cases) {
      const phrase = matchLiteral(text);
      const ids = sql('all', 'SELECT rowid FROM words WHERE words MATCH ? ORDER BY rowid', [phrase]).map((row) => row.rowid);
      observations.literalMatchCases.push({ text, phrase, ids });
      check(`unicode61 literal ${JSON.stringify(text)}`, ids, expected);
    }
    check('explicit prefix matching is not word segmentation',
      sql('all', 'SELECT rowid FROM words WHERE words MATCH ? ORDER BY rowid', ['"南京"*']), [{ rowid: 1 }, { rowid: 2 }]);
  }],
  ['fts5_trigram', 'trigram Chinese code-point threshold and instr fallback', ({ sql, check, observations }) => {
    sql('exec', "CREATE VIRTUAL TABLE trigrams USING fts5(body, tokenize='trigram')");
    const fixtures = [[1, '南京市长江大桥'], [2, '南京市博物院'], [3, '合成研究员𠮷野家记录']];
    for (const row of fixtures) sql('run', 'INSERT INTO trigrams(rowid, body) VALUES (?, ?)', row);
    const cases = [
      ['南京市', [1, 2], [1, 2]], ['长江大桥', [1], [1]], ['南京', [], [1, 2]],
      ['𠮷野家', [3], [3]], ['𠮷野', [], [3]], ['不存在', [], []],
    ];
    observations.searchCases = [];
    for (const [text, expectedMatch, expectedFallback] of cases) {
      const phrase = matchLiteral(text);
      const matchIds = sql('all', 'SELECT rowid FROM trigrams WHERE trigrams MATCH ? ORDER BY rowid', [phrase]).map((row) => row.rowid);
      const fallbackIds = sql('all', 'SELECT rowid FROM trigrams WHERE instr(body, ?) > 0 ORDER BY rowid', [text]).map((row) => row.rowid);
      observations.searchCases.push({ text, codePoints: Array.from(text).length, utf16CodeUnits: text.length, phrase, matchIds, fallbackIds });
      check(`trigram MATCH ${JSON.stringify(text)}`, matchIds, expectedMatch);
      check(`instr fallback ${JSON.stringify(text)}`, fallbackIds, expectedFallback);
    }
    check('supplementary Chinese character counts as one code point', Array.from('𠮷野').length, 2);
    check('UTF-16 length would wrongly pass the three-character threshold', '𠮷野'.length, 3);
  }],
  ['match_literals', 'MATCH phrase escaping, quotes, punctuation and operator injection', ({ sql, check, expectError, observations }) => {
    sql('exec', "CREATE VIRTUAL TABLE quoted_docs USING fts5(body, tokenize='trigram')");
    const fixtures = [
      [1, '他说 "猫猫猫" 与 O\'Reilly，还有 100%_literal。'],
      [2, '他说 猫猫猫 与 OReilly，还有 100XXliteral。'],
      [3, '南京市的一般记录'], [4, '博物院的一般记录'],
      [5, '固定文字 南京市 OR 博物院'], [6, '符号样本 []{}()-:^*'],
    ];
    for (const row of fixtures) sql('run', 'INSERT INTO quoted_docs(rowid, body) VALUES (?, ?)', row);
    const matchSql = 'SELECT rowid FROM quoted_docs WHERE quoted_docs MATCH ? ORDER BY rowid';
    check('binding alone does not neutralize FTS OR operator', sql('all', matchSql, ['南京市 OR 博物院']),
      [{ rowid: 3 }, { rowid: 4 }, { rowid: 5 }]);
    const cases = [['"猫猫猫"', [1]], ["O'Reilly", [1]], ['100%_literal', [1]], ['南京市 OR 博物院', [5]], ['[]{}()-:^*', [6]]];
    observations.escapedCases = [];
    for (const [text, expected] of cases) {
      const phrase = matchLiteral(text);
      const ids = sql('all', matchSql, [phrase]).map((row) => row.rowid);
      observations.escapedCases.push({ text, phrase, ids });
      check(`escaped literal ${JSON.stringify(text)}`, ids, expected);
      check(`instr agrees for literal ${JSON.stringify(text)}`,
        sql('all', 'SELECT rowid FROM quoted_docs WHERE instr(body, ?) > 0 ORDER BY rowid', [text]).map((row) => row.rowid), expected);
    }
    expectError('unescaped single double-quote is an invalid MATCH expression',
      () => sql('all', matchSql, ['"']), sqliteError(/unterminated string|syntax error/i));
    check('escaped one-code-point quote is valid but too short for trigram', sql('all', matchSql, [matchLiteral('"')]), []);
    check('instr can find the single literal double-quote',
      sql('all', 'SELECT rowid FROM quoted_docs WHERE instr(body, ?) > 0 ORDER BY rowid', ['"']), [{ rowid: 1 }]);
  }],
  ['pragma_transactions', 'application_id and user_version transactional rollback', ({ sql, check, observations }) => {
    function readPragmas() {
      return { ...sql('get', 'PRAGMA application_id'), ...sql('get', 'PRAGMA user_version') };
    }
    const initial = { application_id: 0, user_version: 0 };
    const baseline = { application_id: 0x4a554542, user_version: 7 };
    const tentative = { application_id: 0x4a554532, user_version: 8 };
    observations.applicationIdMeaning = '0x4a554542 = ASCII JUEB; 0x4a554532 = ASCII JUE2; both synthetic probe constants, not an adopted production ID.';
    check('fresh in-memory header values start at zero', readPragmas(), initial);
    sql('exec', `PRAGMA application_id = ${baseline.application_id}`);
    sql('exec', `PRAGMA user_version = ${baseline.user_version}`);
    check('baseline pragma values are visible', readPragmas(), baseline);
    sql('exec', 'BEGIN IMMEDIATE');
    sql('exec', `PRAGMA application_id = ${tentative.application_id}`);
    sql('exec', `PRAGMA user_version = ${tentative.user_version}`);
    check('new pragma values are visible inside transaction', readPragmas(), tentative);
    sql('exec', 'ROLLBACK');
    check('rollback restores both pragma values', readPragmas(), baseline);
    sql('exec', 'BEGIN');
    sql('exec', `PRAGMA application_id = ${tentative.application_id}`);
    sql('exec', `PRAGMA user_version = ${tentative.user_version}`);
    sql('exec', 'COMMIT');
    check('commit keeps new values on the same memory connection', readPragmas(), tentative);
  }],
  ['synthetic_cosine', 'Scaled cosine, invalid inputs and exhaustive synthetic ranking', ({ sql, check, expectError, observations }) => {
    observations.algorithm = 'Scale each vector by its own max absolute component; compensated dot/squared sums; dot/(sqrt(sum(x*x))*sqrt(sum(y*y))); clamp rounding to [-1,1].';
    const cases = [
      ['same direction', [1, 2, 3], [1, 2, 3], 1],
      ['orthogonal', [1, 0], [0, 1], 0],
      ['opposite', [1, 2], [-1, -2], -1],
      ['large finite components', [1e308, 1e308], [1e308, 1e308], 1],
      ['tiny finite components', [1e-300, 2e-300], [2e-300, 4e-300], 1],
      ['minimum subnormal', [Number.MIN_VALUE, 0], [1, 0], 1],
      ['maximum finite', [Number.MAX_VALUE, 0], [Number.MAX_VALUE, 0], 1],
    ];
    observations.cases = [];
    for (const [name, a, b, expected] of cases) {
      const actual = stableCosine(a, b);
      observations.cases.push({ name, a, b, actual, expected, absoluteTolerance: 1e-12 });
      check(`cosine ${name}: finite, bounded and within tolerance`,
        Number.isFinite(actual) && actual >= -1 && actual <= 1 && Math.abs(actual - expected) <= 1e-12, true);
    }
    const invalid = [
      ['zero vector', [0, 0], [1, 0], RangeError], ['empty vectors', [], [], RangeError],
      ['dimension mismatch', [1], [1, 2], RangeError], ['NaN component', [NaN, 1], [1, 0], TypeError],
      ['infinite component', [Infinity, 1], [1, 0], TypeError], ['non-numeric component', ['1', 1], [1, 0], TypeError],
    ];
    observations.invalidInputs = [];
    for (const [name, a, b, ErrorType] of invalid) {
      observations.invalidInputs.push({ name, a: jsonValue(a), b: jsonValue(b), expectedError: ErrorType.name });
      expectError(`reject ${name}`, () => stableCosine(a, b), (error) => error instanceof ErrorType);
    }
    sql('exec', 'CREATE TABLE vectors (id TEXT PRIMARY KEY, model_key TEXT NOT NULL, dimensions INTEGER NOT NULL, values_json TEXT NOT NULL CHECK(json_valid(values_json)))');
    const vectors = [['a-same', [2, 0, 0]], ['b-same', [1, 0, 0]], ['c-near', [1, 1, 0]], ['d-orthogonal', [0, 1, 0]], ['e-opposite', [-1, 0, 0]]];
    for (const [id, vector] of vectors) {
      sql('run', 'INSERT INTO vectors(id, model_key, dimensions, values_json) VALUES (?, ?, ?, ?)',
        [id, 'synthetic:no-model', vector.length, JSON.stringify(vector)]);
    }
    const stored = sql('all', 'SELECT id, dimensions, values_json FROM vectors WHERE model_key = ? AND dimensions = ? ORDER BY id', ['synthetic:no-model', 3]);
    check('all synthetic vector JSON rows roundtrip', stored.map((row) => [row.id, JSON.parse(row.values_json)]), vectors);
    const ranking = stored.map((row) => ({ id: row.id, score: stableCosine([1, 0, 0], JSON.parse(row.values_json)) }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    observations.queryVector = [1, 0, 0];
    observations.ranking = ranking;
    observations.rankingMethod = 'Exhaustive JavaScript scan of all five selected rows; score descending then ID ascending, no ANN.';
    check('ranking and equal-score tie break are deterministic', ranking.map((row) => row.id), vectors.map(([id]) => id));
  }],
];

async function main() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
    evidence.driver = { status: 'available' };
  } catch (error) {
    evidence.driver = { status: 'unavailable', error: errorInfo(error) };
  }

  if (DatabaseSync) {
    for (let index = 1; index <= evidence.method.repetitions; index += 1) {
      const run = { run: index, features: [] };
      console.log(`\nSQLite :memory: probe, independent repetition ${index}/${evidence.method.repetitions}`);
      for (const [id, label, body] of features) {
        const feature = runDatabaseFeature(DatabaseSync, id, label, body);
        run.features.push(feature);
        const passed = feature.assertions.filter((item) => item.status === 'passed').length;
        console.log(`  ${feature.status === 'passed' ? 'PASS' : 'FAIL'} ${id}: ${passed}/${feature.assertions.length} assertions`);
        if (feature.error) console.error(`    ${feature.error.message}`);
      }
      run.resultSha256 = sha256(JSON.stringify(run.features));
      evidence.runs.push(run);
    }
    const hashes = evidence.runs.map((run) => run.resultSha256);
    evidence.reproducibility = { status: hashes.every((hash) => hash === hashes[0]) ? 'passed' : 'failed', resultSha256: hashes };
  } else {
    console.error('UNAVAILABLE node:sqlite:', evidence.driver?.error?.message);
  }

  // Give Node's warning event queue a turn before serializing the evidence.
  await new Promise((resolve) => setImmediate(resolve));
  const allFeatures = evidence.runs.flatMap((run) => run.features);
  const allAssertions = allFeatures.flatMap((feature) => feature.assertions);
  const success = evidence.driver.status === 'available'
    && evidence.runs.length === evidence.method.repetitions
    && allFeatures.length === features.length * evidence.method.repetitions
    && allFeatures.every((feature) => feature.status === 'passed')
    && evidence.reproducibility.status === 'passed';
  evidence.summary = {
    status: success ? 'passed' : 'failed',
    featureRuns: allFeatures.length,
    passedFeatureRuns: allFeatures.filter((feature) => feature.status === 'passed').length,
    assertions: allAssertions.length,
    passedAssertions: allAssertions.filter((item) => item.status === 'passed').length,
    failedAssertions: allAssertions.filter((item) => item.status === 'failed').length,
    repeatabilityAssertions: evidence.reproducibility ? 1 : 0,
    repeatabilityPassed: evidence.reproducibility?.status === 'passed',
    expectedExitCode: success ? 0 : 1,
  };
  writeFileSync(evidencePath, `${JSON.stringify(jsonValue(evidence), null, 2)}\n`, 'utf8');
  const sqliteVersion = evidence.runs[0]?.features.find((feature) => feature.id === 'engine')?.observations.sqlite?.version ?? 'unavailable';
  console.log(`\n${success ? 'PASS' : 'FAIL'}: Node ${process.version}; SQLite ${sqliteVersion}; ${evidence.summary.passedFeatureRuns}/${allFeatures.length} feature runs; ${evidence.summary.passedAssertions}/${allAssertions.length} assertions.`);
  console.log(`Repeatability: ${evidence.reproducibility?.status ?? 'unavailable'}; fingerprint: ${evidence.runs[0]?.resultSha256 ?? 'unavailable'}`);
  const chineseVerified = allFeatures.length > 0 && ['fts5_unicode61', 'fts5_trigram', 'match_literals']
    .every((id) => allFeatures.filter((feature) => feature.id === id).length === evidence.method.repetitions
      && allFeatures.filter((feature) => feature.id === id).every((feature) => feature.status === 'passed'));
  console.log(chineseVerified
    ? 'Chinese: unicode61 is not word segmentation; trigram >=3 code points; shorter literals need an instr fallback.'
    : 'Chinese retrieval: not established by this run; inspect failed/unavailable feature evidence.');
  console.log('Scope: memory-only; no durability, DSH packaging, ANN, model semantics or performance claim.');
  console.log(`Evidence: ${evidencePath}`);
  process.exitCode = evidence.summary.expectedExitCode;
}

main().catch((error) => {
  evidence.fatalError = errorInfo(error);
  evidence.summary = { status: 'failed', expectedExitCode: 1 };
  try {
    writeFileSync(evidencePath, `${JSON.stringify(jsonValue(evidence), null, 2)}\n`, 'utf8');
  } catch (writeError) {
    console.error('Could not write evidence:', writeError);
  }
  console.error(error);
  process.exitCode = 1;
});
