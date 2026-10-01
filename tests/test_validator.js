/* Tests for assets/validator.js — plain node, no npm. */
'use strict';
const assert = require('assert');
const { Parser } = require('../assets/vendor/node-sql-parser.umd.js');
const SqlSentinel = require('../assets/validator.js');

const v = SqlSentinel.createValidator(Parser);

const DEMO_DDL = `
CREATE TABLE customers (id INT PRIMARY KEY, name VARCHAR(100), email VARCHAR(255), phone VARCHAR(20), country VARCHAR(50), created_at TIMESTAMP);
CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT, total DECIMAL(10,2), status VARCHAR(20), ordered_at TIMESTAMP);
CREATE TABLE products (id INT PRIMARY KEY, name VARCHAR(100), price DECIMAL(10,2), category VARCHAR(50));
CREATE TABLE refunds (id INT PRIMARY KEY, order_id INT, refund_amount DECIMAL(10,2), reason TEXT, created_at TIMESTAMP);
`;
const schema = v.parseSchema(DEMO_DDL, 'postgresql');

function codes(report) { return report.issues.map((i) => i.code); }
function hasCode(report, code) { return codes(report).includes(code); }
function errorsOf(report) { return report.issues.filter((i) => i.severity === 'error'); }

const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

/* ---------- parseSchema ---------- */
t('schema parses 4 tables', () => {
  assert.deepStrictEqual(Object.keys(schema.tables).sort(), ['customers', 'orders', 'products', 'refunds']);
});
t('schema column types captured', () => {
  assert.strictEqual(schema.tables.customers.columns.email.type, 'VARCHAR');
  assert.strictEqual(schema.tables.orders.columns.total.category, 'number');
  assert.strictEqual(schema.tables.customers.columns.created_at.category, 'datetime');
});
t('schema flags PII columns', () => {
  const pii = schema.tables.customers.pii;
  assert(pii.includes('email'), 'email should be PII, got ' + pii);
  assert(pii.includes('phone'), 'phone should be PII, got ' + pii);
  assert(!pii.includes('id'), 'id should not be PII');
  assert(!schema.tables.orders.pii.includes('total'), 'total should not be PII');
});
t('schema falls back across dialects (bigquery types)', () => {
  const s = v.parseSchema('CREATE TABLE t (id INT64, name STRING, ts TIMESTAMP);', 'bigquery');
  assert(s.tables.t, 'expected table t, errors: ' + s.errors.join('|'));
  assert.strictEqual(s.tables.t.columns.id.category, 'number');
  assert.strictEqual(s.tables.t.columns.name.category, 'string');
});
t('schema records unparsable chunks honestly', () => {
  const s = v.parseSchema('CREATE TABLE ok (id INT); THIS IS NOT SQL;', 'postgresql');
  assert(s.tables.ok, 'ok table should parse');
  assert(s.errors.length >= 1, 'expected at least one schema error, got none');
});

/* ---------- unknown column + did-you-mean ---------- */
t('unknown column errors with did-you-mean', () => {
  const r = v.validate('SELECT refund_amt FROM refunds;', schema, 'postgresql');
  assert(!r.ok, 'expected ok:false');
  assert(hasCode(r, 'UNKNOWN_COLUMN'), 'expected UNKNOWN_COLUMN, got ' + codes(r));
  const iss = r.issues.find((i) => i.code === 'UNKNOWN_COLUMN');
  assert(/refund_amount/.test(iss.message), 'expected suggestion of refund_amount, got: ' + iss.message);
});
t('unknown table errors with did-you-mean', () => {
  const r = v.validate('SELECT * FROM customer LIMIT 1;', schema, 'postgresql');
  assert(hasCode(r, 'UNKNOWN_TABLE'), 'expected UNKNOWN_TABLE, got ' + codes(r));
  assert(/customers/.test(r.issues.find((i) => i.code === 'UNKNOWN_TABLE').message));
});
t('valid query passes clean', () => {
  const r = v.validate(
    "SELECT c.name, SUM(o.total) AS revenue FROM customers c JOIN orders o ON c.id = o.customer_id " +
    "WHERE c.country = 'US' GROUP BY c.name ORDER BY revenue DESC LIMIT 10;",
    schema, 'postgresql');
  assert.strictEqual(errorsOf(r).length, 0, 'expected no errors, got: ' + JSON.stringify(r.issues, null, 1));
  assert(r.ok, 'expected ok:true');
  assert.strictEqual(v.verdict(r), 'safe');
});

/* ---------- destructive ops ---------- */
t('DELETE without WHERE is an error', () => {
  const r = v.validate('DELETE FROM orders;', schema, 'postgresql');
  assert(!r.ok);
  assert(hasCode(r, 'DESTRUCTIVE_NO_WHERE'));
  assert.strictEqual(v.verdict(r), 'blocked');
});
t('DELETE with WHERE warns but passes', () => {
  const r = v.validate('DELETE FROM orders WHERE id = 1;', schema, 'postgresql');
  assert(r.ok, 'expected ok:true, got ' + JSON.stringify(r.issues));
  assert(hasCode(r, 'DESTRUCTIVE_WHERE'));
  assert.strictEqual(v.verdict(r), 'review');
});
t('UPDATE without WHERE is an error', () => {
  const r = v.validate("UPDATE customers SET country = 'US';", schema, 'postgresql');
  assert(!r.ok);
  assert(hasCode(r, 'DESTRUCTIVE_NO_WHERE'));
});
t('DROP TABLE is an error', () => {
  const r = v.validate('DROP TABLE customers;', schema, 'postgresql');
  assert(!r.ok);
  assert(hasCode(r, 'DESTRUCTIVE_UNBOUNDED'));
});
t('TRUNCATE is an error', () => {
  const r = v.validate('TRUNCATE TABLE orders;', schema, 'postgresql');
  assert(!r.ok);
  assert(hasCode(r, 'DESTRUCTIVE_UNBOUNDED'));
});

/* ---------- joins ---------- */
t('implicit comma cross join warns', () => {
  const r = v.validate('SELECT * FROM customers, orders LIMIT 5;', schema, 'postgresql');
  assert(hasCode(r, 'IMPLICIT_CROSS_JOIN'), 'got ' + codes(r));
});
t('JOIN without ON warns', () => {
  const r = v.validate('SELECT * FROM customers CROSS JOIN orders LIMIT 5;', schema, 'postgresql');
  assert(hasCode(r, 'CROSS_JOIN') || hasCode(r, 'IMPLICIT_CROSS_JOIN'), 'got ' + codes(r));
});

/* ---------- types ---------- */
t('number vs string comparison warns', () => {
  const r = v.validate("SELECT id FROM customers WHERE id = 'abc' LIMIT 5;", schema, 'postgresql');
  assert(hasCode(r, 'TYPE_MISMATCH'), 'got ' + codes(r));
});
t('date literal vs datetime column does not warn', () => {
  const r = v.validate("SELECT id FROM customers WHERE created_at > '2024-01-01' LIMIT 5;", schema, 'postgresql');
  assert(!hasCode(r, 'TYPE_MISMATCH'), 'unexpected TYPE_MISMATCH in ' + codes(r));
});

/* ---------- misc checks ---------- */
t('SELECT * is info, not error', () => {
  const r = v.validate('SELECT * FROM customers LIMIT 5;', schema, 'postgresql');
  assert(r.ok);
  assert(hasCode(r, 'SELECT_STAR'));
  const iss = r.issues.find((i) => i.code === 'SELECT_STAR');
  assert.strictEqual(iss.severity, 'info');
});
t('missing LIMIT warns', () => {
  const r = v.validate('SELECT name FROM customers;', schema, 'postgresql');
  assert(hasCode(r, 'MISSING_LIMIT'), 'got ' + codes(r));
});
t('PII access warns', () => {
  const r = v.validate('SELECT email FROM customers LIMIT 5;', schema, 'postgresql');
  assert(hasCode(r, 'PII_ACCESS'), 'got ' + codes(r));
  assert(/email/.test(r.issues.find((i) => i.code === 'PII_ACCESS').message));
});
t('ambiguous column warns', () => {
  const r = v.validate('SELECT id FROM customers c JOIN orders o ON c.id = o.customer_id LIMIT 5;', schema, 'postgresql');
  assert(hasCode(r, 'AMBIGUOUS_COLUMN'), 'got ' + codes(r));
});
t('parse error is honest', () => {
  const r = v.validate('SELECT FROM WHERE;', schema, 'postgresql');
  assert(!r.ok);
  assert(hasCode(r, 'PARSE_ERROR'));
});
t('no schema skips name checks honestly', () => {
  const r = v.validate('SELECT whatever FROM nope LIMIT 1;', { tables: {} }, 'postgresql');
  assert(hasCode(r, 'SCHEMA_MISSING'));
  assert(r.ok, 'should not error without schema, got ' + JSON.stringify(r.issues));
});

/* ---------- explain ---------- */
t('explanation covers clauses', () => {
  const words = v.explain(
    "SELECT c.name, SUM(o.total) AS revenue FROM customers c JOIN orders o ON c.id = o.customer_id " +
    "WHERE c.country = 'US' GROUP BY c.name ORDER BY revenue DESC LIMIT 10;",
    schema, 'postgresql');
  for (const needle of ['customers', 'orders', "'US'", '10', 'Groups rows by']) {
    assert(words.includes(needle), 'explanation missing "' + needle + '": ' + words);
  }
});
t('explanation of DELETE without WHERE is blunt', () => {
  const words = v.explain('DELETE FROM orders;', schema, 'postgresql');
  assert(/EVERY row/.test(words), 'got: ' + words);
});
t('explanation never throws on garbage', () => {
  const words = v.explain('SELECT FROM WHERE;', schema, 'postgresql');
  assert(typeof words === 'string' && words.length > 0);
});

/* ---------- CTEs, subqueries, INSERT ---------- */
t('CTE name resolves, no false unknown-table', () => {
  const r = v.validate('WITH x AS (SELECT id FROM customers) SELECT id FROM x LIMIT 5;', schema, 'postgresql');
  assert(!hasCode(r, 'UNKNOWN_TABLE'), 'unexpected UNKNOWN_TABLE in ' + codes(r));
});
t('subquery columns are not falsely flagged', () => {
  const r = v.validate('SELECT id FROM (SELECT id FROM customers) AS sub LIMIT 5;', schema, 'postgresql');
  assert(!hasCode(r, 'UNKNOWN_COLUMN'), 'unexpected UNKNOWN_COLUMN in ' + codes(r));
});
t('INSERT checks column list', () => {
  const r = v.validate("INSERT INTO customers (id, nope) VALUES (1, 'x');", schema, 'postgresql');
  assert(hasCode(r, 'UNKNOWN_COLUMN'), 'expected UNKNOWN_COLUMN, got ' + codes(r));
  assert(!r.ok);
});
t('valid INSERT passes', () => {
  const r = v.validate("INSERT INTO customers (id, name) VALUES (1, 'x');", schema, 'postgresql');
  assert(r.ok, 'expected ok:true, got ' + JSON.stringify(r.issues));
});

module.exports = { tests };
