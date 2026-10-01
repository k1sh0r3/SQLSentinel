/* SQL Sentinel UI — tabs, demo data, Gemini generation with verification loop. */
(function () {
  'use strict';

  var V = SqlSentinel.createValidator(Parser);
  var LS_KEY = 'sqlsentinel-gemini-key';
  var LS_MODEL = 'sqlsentinel-gemini-model';

  /* ---------------- demo data ---------------- */
  var DEMO_DDL = [
    'CREATE TABLE customers (',
    '  id INT PRIMARY KEY,',
    '  name VARCHAR(100),',
    '  email VARCHAR(255),',
    '  phone VARCHAR(20),',
    '  country VARCHAR(50),',
    '  created_at TIMESTAMP',
    ');',
    'CREATE TABLE orders (',
    '  id INT PRIMARY KEY,',
    '  customer_id INT,',
    '  total DECIMAL(10,2),',
    '  status VARCHAR(20),',
    '  ordered_at TIMESTAMP',
    ');',
    'CREATE TABLE products (',
    '  id INT PRIMARY KEY,',
    '  name VARCHAR(100),',
    '  price DECIMAL(10,2),',
    '  category VARCHAR(50)',
    ');',
    'CREATE TABLE refunds (',
    '  id INT PRIMARY KEY,',
    '  order_id INT,',
    '  refund_amount DECIMAL(10,2),',
    '  reason TEXT,',
    '  created_at TIMESTAMP',
    ');'
  ].join('\n');

  var DEMO_SQL = [
    'SELECT c.name, SUM(o.total) AS revenue',
    'FROM customers c',
    'JOIN orders o ON c.id = o.customer_id',
    "WHERE c.country = 'US' AND o.total > 100",
    'GROUP BY c.name',
    'HAVING SUM(o.total) > 500',
    'ORDER BY revenue DESC',
    'LIMIT 10;'
  ].join('\n');

  var RISKY_SQL = 'DELETE FROM orders;';

  var EXAMPLE_QUESTIONS = [
    'Top 10 customers by total revenue, excluding refunded orders',
    'Which products have never been ordered?',
    'Total refund amount per month for 2024',
    'Delete all orders from before 2021'
  ];

  /* ---------------- helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getSchema(ddlText, dialect) {
    return V.parseSchema(ddlText, dialect);
  }

  var VERDICT_TEXT = {
    safe: '✓ SAFE — no issues found',
    review: '⚠ NEEDS REVIEW — check the warnings below',
    blocked: '✕ BLOCKED — fix the errors before running this'
  };

  function renderReport(prefix, report, sqlText, schema, dialect) {
    var verdict = V.verdict(report);
    var vEl = $(prefix + 'Verdict');
    vEl.className = 'verdict ' + verdict;
    var nErr = report.issues.filter(function (i) { return i.severity === 'error'; }).length;
    var nWarn = report.issues.filter(function (i) { return i.severity === 'warning'; }).length;
    vEl.textContent = VERDICT_TEXT[verdict] +
      (verdict === 'blocked' ? ' (' + nErr + ' error' + (nErr === 1 ? '' : 's') + ')' :
       verdict === 'review' ? ' (' + nWarn + ' warning' + (nWarn === 1 ? '' : 's') + ')' : '');

    var box = $(prefix + 'Issues');
    if (!report.issues.length) {
      box.innerHTML = '<p class="no-issues">Clean — nothing to flag.</p>';
    } else {
      box.innerHTML = report.issues.map(function (iss) {
        return '<div class="issue ' + iss.severity + '">' +
          '<span class="code">' + esc(iss.severity) + ' · ' + esc(iss.code) + '</span>' +
          esc(iss.message) +
          (iss.suggestion ? '<div class="sugg">' + esc(iss.suggestion) + '</div>' : '') +
          '</div>';
      }).join('');
    }
    $(prefix + 'Explain').textContent = V.explain(sqlText, schema, dialect);
    $(prefix + 'Result').hidden = false;
  }

  /* ---------------- tabs ---------------- */
  var tabBtns = { generate: $('tabBtnGenerate'), verify: $('tabBtnVerify') };
  var tabPanels = { generate: $('tab-generate'), verify: $('tab-verify') };
  function showTab(which) {
    for (const k of Object.keys(tabBtns)) {
      const active = k === which;
      tabBtns[k].classList.toggle('active', active);
      tabBtns[k].setAttribute('aria-selected', active ? 'true' : 'false');
      tabPanels[k].hidden = !active;
    }
  }
  tabBtns.generate.addEventListener('click', function () { showTab('generate'); });
  tabBtns.verify.addEventListener('click', function () { showTab('verify'); });

  /* ---------------- Gemini (BYOK) ---------------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function geminiCall(prompt, key, model, statusCb) {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
      encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);
    var body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
    });
    var waits = [4000, 8000];
    for (var attempt = 0; attempt <= 3; attempt++) {
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body });
      } catch (e) {
        throw new Error('Network error calling the API: ' + e.message);
      }
      if (res.ok) {
        var data = await res.json();
        var text = data && data.candidates && data.candidates[0] &&
          data.candidates[0].content && data.candidates[0].content.parts &&
          data.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('');
        if (!text) throw new Error('The API returned an empty response.');
        return text;
      }
      if ((res.status === 429 || res.status === 503) && attempt < 3) {
        if (statusCb) statusCb('Model is busy, retrying…');
        await sleep(waits[Math.min(attempt, waits.length - 1)]);
        continue;
      }
      var errText = await res.text().catch(function () { return ''; });
      throw new Error('API error ' + res.status + ': ' + errText.slice(0, 200));
    }
    throw new Error('The model is overloaded right now — try again in a minute.');
  }

  function extractSql(text) {
    var m = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
    if (m) return m[1].trim();
    return text.trim().replace(/^```|```$/g, '').trim();
  }

  /* ---------------- Generate tab ---------------- */
  // restore key + model
  try {
    var savedKey = localStorage.getItem(LS_KEY);
    if (savedKey) $('apiKey').value = savedKey;
    var savedModel = localStorage.getItem(LS_MODEL);
    if (savedModel) $('apiModel').value = savedModel;
  } catch (e) { /* storage unavailable — key must be pasted each visit */ }
  $('apiKey').addEventListener('change', function () {
    try { localStorage.setItem(LS_KEY, $('apiKey').value.trim()); } catch (e) {}
  });
  $('apiModel').addEventListener('change', function () {
    try { localStorage.setItem(LS_MODEL, $('apiModel').value.trim()); } catch (e) {}
  });

  $('genDdl').value = DEMO_DDL;

  var chipsBox = $('exampleChips');
  EXAMPLE_QUESTIONS.forEach(function (q) {
    var b = document.createElement('button');
    b.className = 'chip';
    b.textContent = q;
    b.addEventListener('click', function () { $('question').value = q; });
    chipsBox.appendChild(b);
  });

  $('genDemoSchema').addEventListener('click', function () { $('genDdl').value = DEMO_DDL; });
  $('genUploadSchema').addEventListener('click', function () { $('genSchemaFile').click(); });
  $('genSchemaFile').addEventListener('change', function (ev) {
    var f = ev.target.files && ev.target.files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () { $('genDdl').value = String(r.result || ''); };
    r.readAsText(f);
  });

  $('generateBtn').addEventListener('click', async function () {
    var key = $('apiKey').value.trim();
    var model = $('apiModel').value.trim() || 'gemini-3.8-flash';
    var question = $('question').value.trim();
    var dialect = $('genDialect').value;
    var status = $('genStatus');
    if (!question) { status.textContent = 'Type a question first.'; return; }
    if (!key) {
      status.innerHTML = 'Paste your free Gemini API key in the left panel first ' +
        '(<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a>).';
      return;
    }
    var schema = getSchema($('genDdl').value, dialect);
    var ddlForPrompt = $('genDdl').value.trim().slice(0, 6000);

    $('generateBtn').disabled = true;
    $('genResult').hidden = true;
    var log = $('loopLog');
    log.hidden = false;
    log.innerHTML = '';

    function logRound(html, cls) {
      var d = document.createElement('div');
      d.className = 'round' + (cls ? ' ' + cls : '');
      d.innerHTML = html;
      log.appendChild(d);
    }

    try {
      var sql = null, report = null;
      for (var round = 1; round <= 3; round++) {
        status.textContent = 'Round ' + round + ': generating…';
        var prompt;
        if (round === 1) {
          prompt = 'You are a SQL generator. Dialect: ' + dialect + '.\n' +
            (ddlForPrompt ? 'Schema:\n' + ddlForPrompt + '\n' : 'No schema provided.\n') +
            'Question: ' + question + '\n' +
            'Return ONLY the SQL query in a ```sql code block. No explanation, no extra text.';
        } else {
          var errLines = report.issues
            .filter(function (i) { return i.severity === 'error'; })
            .map(function (i) { return '- ' + i.message + (i.suggestion ? ' Suggestion: ' + i.suggestion : ''); });
          prompt = 'The SQL you generated has validation errors. Fix them.\n' +
            'Dialect: ' + dialect + '.\n' +
            (ddlForPrompt ? 'Schema:\n' + ddlForPrompt + '\n' : '') +
            'Errors:\n' + errLines.join('\n') + '\n' +
            'Previous SQL:\n' + sql + '\n' +
            'Return ONLY the corrected SQL in a ```sql code block. No explanation.';
        }
        var raw = await geminiCall(prompt, key, model, function (m) { status.textContent = m; });
        sql = extractSql(raw);
        report = V.validate(sql, schema, dialect);
        var nErr = report.issues.filter(function (i) { return i.severity === 'error'; }).length;
        if (nErr === 0) {
          logRound('Round ' + round + ' — <span class="good">clean, no errors.</span>', 'good');
          break;
        }
        var first = report.issues.filter(function (i) { return i.severity === 'error'; })[0];
        logRound('Round ' + round + ' — <span class="bad">' + nErr + ' error' + (nErr === 1 ? '' : 's') +
          ':</span> ' + esc(first.message), 'bad');
        if (round === 3) {
          logRound('Gave up after 3 rounds — showing the last attempt with its report.', 'bad');
        }
      }
      $('genSql').textContent = sql;
      renderReport('gen', report, sql, schema, dialect);
      status.textContent = '';
    } catch (e) {
      status.textContent = 'Failed: ' + e.message;
      logRound('Error: ' + esc(e.message), 'bad');
    }
    $('generateBtn').disabled = false;
  });

  /* ---------------- Verify tab ---------------- */
  $('verDemoSql').addEventListener('click', function () { $('verSql').value = DEMO_SQL; });
  $('verRiskySql').addEventListener('click', function () { $('verSql').value = RISKY_SQL; });
  $('verDemoSchema').addEventListener('click', function () { $('verDdl').value = DEMO_DDL; });

  $('validateBtn').addEventListener('click', function () {
    var sql = $('verSql').value.trim();
    var dialect = $('verDialect').value;
    if (!sql) return;
    var schema = getSchema($('verDdl').value, dialect);
    var report = V.validate(sql, schema, dialect);
    // surface schema parse problems honestly
    if (schema.errors.length) {
      report.issues.unshift({
        severity: 'warning', code: 'SCHEMA_PARSE',
        message: 'Part of the schema could not be parsed (' + schema.errors.length + ' chunk(s)); name checks may be incomplete.',
        suggestion: 'Check the CREATE TABLE syntax for the selected dialect.'
      });
      report.ok = report.ok && !report.issues.some(function (i) { return i.severity === 'error'; });
    }
    renderReport('ver', report, sql, schema, dialect);
  });
})();
