# SQL Sentinel — Trust, but verify, for AI-written SQL.

Verified text-to-SQL with a validation loop, running **100% in the browser**.
Ask in English → an LLM writes the SQL → the validator proves it safe against
your schema (up to 3 fix rounds) → you get the SQL, a validation report, a
plain-English explanation, and a guardrail verdict. No backend, no database
connection, no uploads — your schema never leaves your machine.

> Résumé line: built the code reviewer for AI-written SQL — verified
> text-to-SQL with a validation loop (schema checks, destructive-op guardrails,
> plain-English explanations).

## The two tabs

- **Generate** (needs a free Gemini API key, paste-once → localStorage): English
  question + your DDL + dialect → SQL, then the **verification loop**: validate →
  feed errors + schema excerpt back to the model for a fix (max 3 rounds) →
  final SQL + report + explanation + verdict. You watch the loop happen, e.g.
  _Round 1 failed: unknown column `refund_amt`, did you mean `refund_amount`? →
  Round 2 fixed._
- **Verify** (no key needed — the keyless star): paste any SQL + schema → instant
  validation report + explanation + verdict. Zero network calls.

## Checks

| Check | Severity |
|---|---|
| Unknown table / column (+ did-you-mean) | error |
| `DELETE`/`UPDATE` without `WHERE`; `DROP`/`TRUNCATE` | error (blocked) |
| `DELETE`/`UPDATE` with `WHERE` | warning |
| `JOIN` without `ON` / comma cross join | warning |
| Type mismatch in comparisons / joins | warning |
| Ambiguous column, PII access, missing `LIMIT` | warning |
| `SELECT *` | info |

Verdicts: **✓ SAFE** · **⚠ NEEDS REVIEW** · **✕ BLOCKED**.

## Run it

No build step. Serve over HTTP (or just open `index.html` — everything is
inline/vendored, no `fetch()` needed):

```bash
cd ~/workspace/sql-sentinel
python3 -m http.server 8080
# open http://localhost:8080
```

Tests (plain node, no npm):

```bash
node tests/run.js   # 26 passed, 0 failed
```

## Project layout

```
index.html                     Generate + Verify tabs
about.html                     how-it-works, checks, honest limits
assets/
  style.css                    dark theme (#0b0e17 / #38e1c6)
  app.js                       UI: tabs, demo data, Gemini BYOK, verification loop
  validator.js                 the engine — UMD, dependency-free (parser injected),
                               works in node and browser; reusable for the Phase-2
                               GitHub Action PR reviewer
  vendor/node-sql-parser.umd.js  vendored SQL parser — no CDN
  demo/schema.sql              demo e-commerce schema
tests/
  run.js                       test runner
  test_validator.js            26 tests: schema parsing, did-you-mean, destructive
                               ops, joins, types, PII, explanation
```

## Roadmap

**Phase 2: SQL Sentinel as a GitHub Action** — the code reviewer for AI-written
SQL. It will validate SQL in pull requests (dbt models, migrations), explain
the diff in plain English, and flag dangerous changes before they merge.
`assets/validator.js` is already structured as the reusable core for it.

## License

MIT — see LICENSE.
