/**
 * FlowSpend — statement import parsers for MCB PDF/XLSX exports.
 * Runs fully in the browser and returns reviewable outgoing transactions.
 */
(function (g) {
  const FS = (g.FS = g.FS || {});

  const CATEGORY_RULES = [
    { category: 'Bank Fees', re: /charge|fee|tax|amount due|service fee|account transfer charges/i },
    { category: 'Transport', re: /petrol|fuel|gas/i },
    { category: 'Food & Health', re: /food|foods|chicken|indian|minos|restaurant|cafe/i },
    { category: 'Shopping', re: /merchant|payment|shop|market|store/i },
  ];

  function cleanText(s) {
    return String(s || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseAmount(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const n = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
  }

  function excelDateToYmd(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return toYmd(value);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const ms = Math.round((value - 25569) * 86400 * 1000);
      return toYmd(new Date(ms));
    }
    const s = String(value || '').trim();
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return '';
  }

  function toYmd(d) {
    const x = new Date(d);
    return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
  }

  function mcbCategory(details) {
    const text = String(details || '');
    for (const rule of CATEGORY_RULES) {
      if (rule.re.test(text)) return rule.category;
    }
    return 'Other';
  }

  function truncateName(s) {
    const text = cleanText(s);
    return text.length > 72 ? text.slice(0, 69).trimEnd() + '...' : text;
  }

  function stripBankIds(s) {
    return cleanText(s)
      .replace(/\bFT\d+[A-Z0-9]*(?:\\BNK)?\b/gi, '')
      .replace(/\\BNK\b/gi, '')
      .replace(/\bCMCL\d+\b/gi, '')
      .replace(/\bAC-MUR\d+\b/gi, '')
      .replace(/\b\d{12}\.AC\d+\.\d{8}\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function juiceName(details) {
    let text = stripBankIds(details)
      .replace(/^(?:JUICE\s+)?(?:Account\s+)?Transfer\s+/i, '')
      .replace(/^Instant Payment\s+/i, '')
      .replace(/^Merchant Instant Payment\s+/i, '')
      .trim();
    const beforeTitle = text.split(/\b(?:MR|MRS|MISS|MS)\b/i)[0].trim();
    if (beforeTitle) text = beforeTitle;
    text = text.replace(/\b(?:MR|MRS|MISS|MS)\b\.?\s*/gi, '').trim();
    return truncateName('Juice - ' + (text || 'Payment'));
  }

  function mcbName(details) {
    const text = stripBankIds(details);
    if (/^(JUICE|Instant Payment|Merchant Instant Payment)\b/i.test(text)) {
      return juiceName(text);
    }
    return truncateName(text || 'Imported transaction');
  }

  function shouldIgnoreTransaction(details) {
    const text = cleanText(details);
    if (/\b(?:cash withdrawal|atm withdrawal|atm cash|cash advance)\b/i.test(text)) return true;
    if (
      /^(?:JUICE\s+(?:Own\s+)?Account Transfer|Instant Payment)\b/i.test(text) &&
      /\bTEJHUNN\s+(?:KUMAR\s+)?RAMCHURN\b/i.test(text)
    )
      return true;
    if (/^JUICE\s+Own Account Transfer\b/i.test(text)) return true;
    return false;
  }

  function statementTransactionId(tx) {
    return [
      'mcb',
      tx.date || '',
      String(Math.round((Number(tx.amount) || 0) * 100)),
      cleanText(tx.description).toLowerCase(),
    ].join('|');
  }

  function rowValue(row, idx) {
    return row && row[idx] != null ? row[idx] : '';
  }

  async function parseXlsx(file) {
    if (!g.XLSX) {
      throw new Error('XLSX parser is not loaded. Check your internet connection and reload FlowSpend.');
    }

    const workbook = g.XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const out = [];

    workbook.SheetNames.forEach((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const rows = g.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, blankrows: false });
      rows.forEach((row) => {
        const date = excelDateToYmd(rowValue(row, 0));
        const details = cleanText(rowValue(row, 2));
        const debit = parseAmount(rowValue(row, 4));
        if (!date || !details || debit <= 0) return;
        if (shouldIgnoreTransaction(details)) return;
        out.push(toTransaction({ date, amount: debit, description: details, sourceFormat: 'xlsx' }));
      });
    });

    return latestSixMonths(out);
  }

  function isPdfNoise(line) {
    return (
      !line ||
      /^current account statement/i.test(line) ||
      /^for any change/i.test(line) ||
      /^from \d{2}\/\d{2}\/\d{4}/i.test(line) ||
      /^iban:?$/i.test(line) ||
      /^account number/i.test(line) ||
      /^currency$/i.test(line) ||
      /^statement date$/i.test(line) ||
      /^despatch code$/i.test(line) ||
      /^od limit$/i.test(line) ||
      /^the mauritius commercial bank/i.test(line) ||
      /^swift code/i.test(line) ||
      /^website/i.test(line) ||
      /^trans$/i.test(line) ||
      /^date$/i.test(line) ||
      /^value$/i.test(line) ||
      /^date transaction details debit credit/i.test(line) ||
      /^balance$/i.test(line) ||
      /^-- \d+ of \d+ --$/.test(line) ||
      /^page\s*:/i.test(line)
    );
  }

  async function parsePdf(file) {
    const pdfjs = g.pdfjsLib;
    if (!pdfjs) {
      throw new Error('PDF parser is not loaded. Check your internet connection and reload FlowSpend.');
    }
    if (pdfjs.GlobalWorkerOptions) {
      pdfjs.GlobalWorkerOptions.workerSrc =
        pdfjs.GlobalWorkerOptions.workerSrc ||
        'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
    }

    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const lines = [];
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
      const page = await doc.getPage(pageNo);
      const text = await page.getTextContent();
      const buckets = [];
      text.items.forEach((item) => {
        const str = cleanText(item.str);
        if (!str) return;
        const x = item.transform[4];
        const y = item.transform[5];
        let bucket = buckets.find((b) => Math.abs(b.y - y) < 3);
        if (!bucket) {
          bucket = { y, parts: [] };
          buckets.push(bucket);
        }
        bucket.parts.push({ x, str });
      });
      buckets
        .sort((a, b) => b.y - a.y)
        .forEach((bucket) => {
          const line = bucket.parts
            .sort((a, b) => a.x - b.x)
            .map((p) => p.str)
            .join(' ');
          lines.push(cleanText(line));
        });
    }
    return parseMcbPdfLines(lines);
  }

  function parseMcbPdfLines(lines) {
    const out = [];
    let prevBalance = null;
    let pending = null;

    function commitPending() {
      if (!pending) return;
      if (pending.kind === 'debit') {
        if (shouldIgnoreTransaction(pending.description)) {
          pending = null;
          return;
        }
        out.push(
          toTransaction({
            date: pending.date,
            amount: pending.amount,
            description: pending.description,
            sourceFormat: 'pdf',
          }),
        );
      }
      pending = null;
    }

    lines.forEach((rawLine) => {
      const line = cleanText(rawLine);
      if (!line || isPdfNoise(line)) return;

      const opening = line.match(/^Opening Balance\s+([\d,]+\.\d{2})$/i);
      if (opening) {
        commitPending();
        prevBalance = parseAmount(opening[1]);
        return;
      }

      const tx = parseMcbPdfTransactionLine(line);
      if (tx) {
        commitPending();
        const amount = tx.amount;
        const balance = tx.balance;
        let kind = 'unknown';
        if (prevBalance != null) {
          if (Math.abs(prevBalance - amount - balance) < 0.05) kind = 'debit';
          else if (Math.abs(prevBalance + amount - balance) < 0.05) kind = 'credit';
        }
        if (kind === 'unknown') kind = inferTransactionKindFromDescription(tx.description);
        pending = {
          date: tx.date,
          amount,
          balance,
          description: tx.description,
          kind,
        };
        prevBalance = balance;
        return;
      }

      if (pending && !/^\d{6,}$/.test(line)) {
        pending.description = cleanText(pending.description + ' ' + line);
      }
    });

    commitPending();
    return latestSixMonths(out);
  }

  function inferTransactionKindFromDescription(description) {
    const text = cleanText(description);
    if (/\b(?:Debit Card Purchase|Charge|Instant Payment|ATM Cash Withdrawal|Cash Withdrawal)\b/i.test(text)) {
      return 'debit';
    }
    return 'unknown';
  }

  function parseMcbPdfTransactionLine(line) {
    const amountBeforeDescription = line.match(
      /^(\d{2}\/\d{2}\/\d{4})\s+\d{2}\/\d{2}\/\d{4}\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+(.+)$/,
    );
    if (amountBeforeDescription) {
      return {
        date: excelDateToYmd(amountBeforeDescription[1]),
        amount: parseAmount(amountBeforeDescription[2]),
        balance: parseAmount(amountBeforeDescription[3]),
        description: cleanText(amountBeforeDescription[4]),
      };
    }

    const descriptionBeforeAmount = line.match(
      /^(\d{2}\/\d{2}\/\d{4})\s+\d{2}\/\d{2}\/\d{4}\s+(.+?)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})$/,
    );
    if (descriptionBeforeAmount) {
      return {
        date: excelDateToYmd(descriptionBeforeAmount[1]),
        amount: parseAmount(descriptionBeforeAmount[3]),
        balance: parseAmount(descriptionBeforeAmount[4]),
        description: cleanText(descriptionBeforeAmount[2]),
      };
    }

    return null;
  }

  function latestSixMonths(rows) {
    const dated = rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date)).sort((a, b) => a.date.localeCompare(b.date));
    if (!dated.length) return rows;
    const latest = dated[dated.length - 1].date;
    const cutoff = new Date(latest + 'T00:00:00Z');
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
    const cutoffYmd = toYmd(cutoff);
    return rows.filter((r) => !r.date || r.date >= cutoffYmd);
  }

  function toTransaction(tx) {
    const description = mcbName(tx.description);
    const item = {
      date: tx.date,
      amount: Math.round((Number(tx.amount) || 0) * 100) / 100,
      description,
      suggestedCategory: mcbCategory(description),
      selected: true,
      source: 'MCB statement',
      sourceFormat: tx.sourceFormat,
    };
    item.transactionId = statementTransactionId(item);
    return item;
  }

  async function parseStatementFile(file) {
    const name = String(file?.name || '').toLowerCase();
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) return parseXlsx(file);
    if (name.endsWith('.pdf')) return parsePdf(file);
    throw new Error('Unsupported statement file. Use an MCB PDF or XLSX statement.');
  }

  Object.assign(FS, {
    parseStatementFile,
    parseMcbPdfLines,
    statementTransactionId,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
