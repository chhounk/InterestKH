import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { load } from 'cheerio';
import robotsParser from 'robots-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, '..', 'data', 'institutions.json');
const USER_AGENT = 'InterestKHBot/1.0 (+contact: youremail@example.com)'; // TODO: replace with your contact email
const TERMS_USD = [3, 6, 9, 12, 24, 36, 48, 60];
const TERMS_KHR = [3, 6, 9, 12, 24, 36];
const TERMS_ALL = [3, 6, 9, 12, 24, 36, 48, 60];
const INTEREST_CAMBODIA_BASE = 'https://interestcambodia.com/wp-content/themes/bricks-child/js/';
const ABA_SAVINGS_FALLBACK = {
  usd: [
    { balance: '≤ 10,000', rate: 0.0 },
    { balance: '≤ 25,000', rate: 0.1 },
    { balance: '≤ 50,000', rate: 0.15 },
    { balance: '≤ 100,000', rate: 0.25 },
    { balance: '≤ 500,000', rate: 0.4 },
    { balance: '≤ 1,000,000', rate: 0.5 },
    { balance: '> 1,000,000', rate: 0.6 }
  ],
  khr: [
    { balance: '≤ 20,000,000', rate: 0.0 },
    { balance: '≤ 100,000,000', rate: 1.0 },
    { balance: '> 100,000,000', rate: 1.25 }
  ]
};
const INTEREST_CAMBODIA_BANK_MAP = {
  amk: 'amk',
  amret: 'amret',
  canadia: 'canadia',
  lolc: 'lolc',
  mohanokor: 'mohanokor',
  'ppc bank': 'ppc',
  prasac: 'kb-prasac',
  wing: 'wing',
  woori: 'woori'
};
const INTEREST_CAMBODIA_TERM_MAP = {
  '3mth': 3,
  '6mth': 6,
  '9mth': 9,
  '1yr': 12,
  '2yr': 24,
  '3yr': 36,
  '4yr': 48,
  '5yr': 60
};

function toFloat(val) {
  if (!val) return null;
  const num = parseFloat(String(val).replace('%', '').trim());
  return Number.isFinite(num) ? num : null;
}

function formatNumber(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return String(val);
  return num.toLocaleString('en-US');
}

function normalizeComparator(op) {
  if (!op) return '';
  if (op === '<' || op === '<=') return '≤';
  if (op === '>' || op === '>=') return op === '>=' ? '≥' : '>';
  if (op === '≤' || op === '≥') return op;
  return op;
}

function parseUnitValue(raw, unit) {
  const base = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  if (!unit) return base;
  const u = unit.toLowerCase();
  if (u.startsWith('million')) return base * 1_000_000;
  if (u.startsWith('billion') || u === 'bn') return base * 1_000_000_000;
  return base;
}

function htmlToText(html) {
  if (!html) return '';
  const $ = load(String(html));
  return $.text().trim();
}

function makeEmptyRates() {
  const blank = (terms) => terms.reduce((acc, term) => {
    acc[String(term)] = null;
    return acc;
  }, {});
  return {
    usd: { monthly: blank(TERMS_ALL), maturity: blank(TERMS_ALL) },
    khr: { monthly: blank(TERMS_ALL), maturity: blank(TERMS_ALL) }
  };
}

async function canFetch(url) {
  try {
    const origin = new URL(url).origin;
    const robotsUrl = origin + '/robots.txt';
    const res = await fetch(robotsUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (res.status === 404) return true;
    if (!res.ok) return false;
    const robotsTxt = await res.text();
    const parser = robotsParser(robotsUrl, robotsTxt);
    return parser.isAllowed(url, USER_AGENT);
  } catch (err) {
    return false;
  }
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Fetch failed: ${url} (${res.status})`);
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Fetch failed: ${url} (${res.status})`);
  return res.json();
}

function parseCanadia(html) {
  const $ = load(html);
  const table = $('table').first();
  const rows = [];
  table.find('tr').each((_, tr) => {
    const cells = $(tr).find('th,td').map((_, el) => $(el).text().trim()).get();
    if (cells.length) rows.push(cells);
  });
  const rates = { usd: { monthly: {}, maturity: {} }, khr: { monthly: {}, maturity: {} } };
  const map = {};
  rows.slice(2).forEach(row => { map[row[0]] = row; });

  const termMap = {
    3: '3 Months',
    6: '6 Months',
    9: '9 Months',
    12: '12 Months',
    24: '24 Months',
    36: '36 Months',
    48: '48 Months',
    60: '60 Months'
  };

  TERMS_USD.forEach(term => {
    const row = map[termMap[term]];
    if (!row) return;
    // Row structure: Term, Maturity USD, Maturity KHR, Monthly USD, Monthly KHR, Quarterly USD, Quarterly KHR
    rates.usd.maturity[String(term)] = toFloat(row[1]);
    rates.khr.maturity[String(term)] = toFloat(row[2]);
    rates.usd.monthly[String(term)] = toFloat(row[3]);
    rates.khr.monthly[String(term)] = toFloat(row[4]);
  });

  return rates;
}

function parseAmret(html) {
  const $ = load(html);
  const table = $('table').first();
  const rows = [];
  table.find('tr').each((_, tr) => {
    const cells = $(tr).find('th,td').map((_, el) => $(el).text().trim()).get();
    if (cells.length) rows.push(cells);
  });

  const rates = { usd: { monthly: {}, maturity: {} }, khr: { monthly: {}, maturity: {} } };
  rows.forEach(row => {
    if (row.length !== 5) return;
    const term = parseInt(row[0].replace('Months', '').replace('Month', '').trim(), 10);
    if (!Number.isFinite(term)) return;
    rates.khr.maturity[String(term)] = toFloat(row[1]);
    rates.usd.maturity[String(term)] = toFloat(row[2]);
    rates.khr.monthly[String(term)] = toFloat(row[3]);
    rates.usd.monthly[String(term)] = toFloat(row[4]);
  });

  return rates;
}

function parseAcleda(html) {
  const $ = load(html);
  const tables = [];
  $('table').each((_, table) => {
    const firstTh = $(table).find('th').first().text().trim();
    if (firstTh === 'Term') tables.push(table);
  });
  const growth = tables[0];
  const income = tables[1];
  if (!growth || !income) return null;

  const parseTable = (table) => {
    const rows = [];
    $(table).find('tr').each((_, tr) => {
      const cells = $(tr).find('th,td').map((_, el) => $(el).text().trim()).get();
      if (cells.length) rows.push(cells);
    });
    const out = {};
    rows.slice(2).forEach(row => {
      const term = parseInt(row[0].replace('months', '').replace('month', '').trim(), 10);
      if (!Number.isFinite(term)) return;
      out[term] = { khr: toFloat(row[1]), usd: toFloat(row[3]) };
    });
    return out;
  };

  const growthRates = parseTable(growth);
  const incomeRates = parseTable(income);

  const rates = { usd: { monthly: {}, maturity: {} }, khr: { monthly: {}, maturity: {} } };
  TERMS_USD.forEach(term => {
    const g = growthRates[term];
    const i = incomeRates[term];
    if (g) {
      rates.usd.maturity[String(term)] = g.usd;
      rates.khr.maturity[String(term)] = g.khr;
    }
    if (i) {
      rates.usd.monthly[String(term)] = i.usd;
      rates.khr.monthly[String(term)] = i.khr;
    }
  });

  return rates;
}

function parseFtb(html) {
  const $ = load(html);
  let target = null;
  $('table').each((_, table) => {
    const headers = $(table).find('th').map((_, el) => $(el).text().trim()).get().join(' ');
    if (headers.includes('Type of Deposit') && headers.includes('US$') && headers.includes('KHR')) {
      target = table;
    }
  });
  if (!target) return null;

  const rates = { usd: { monthly: {}, maturity: {} }, khr: { monthly: {}, maturity: {} } };
  $(target).find('tr').each((_, tr) => {
    const cells = $(tr).find('th,td').map((_, el) => $(el).text().trim()).get();
    if (cells.length < 3) return;
    if (cells[0].toLowerCase().includes('type of deposit')) return;
    const term = parseInt(cells[0].replace('Months', '').replace('Month', '').trim(), 10);
    if (!Number.isFinite(term)) return;
    if (!TERMS_ALL.includes(term)) return;
    const usd = toFloat(cells[1]);
    const khr = toFloat(cells[2]);
    if (usd !== null) {
      rates.usd.monthly[String(term)] = usd;
      rates.usd.maturity[String(term)] = usd;
    }
    if (khr !== null) {
      rates.khr.monthly[String(term)] = khr;
      rates.khr.maturity[String(term)] = khr;
    }
  });

  return rates;
}

function parseAcledaSavings(html) {
  const $ = load(html);
  let target = null;
  $('table').each((_, table) => {
    const text = $(table).text();
    if (text.includes('Annual Interest Rate') && text.includes('KHR') && text.includes('USD')) {
      target = table;
    }
  });
  if (!target) return null;

  const khr = [];
  const usd = [];
  let seenCustomer = false;

  $(target).find('tr').each((_, tr) => {
    const cells = $(tr).find('th,td').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();
    if (!cells.length) return;
    const first = (cells[0] || '').toLowerCase();
    if (first.includes('acleda mobile partner')) return;
    if (first.includes('customer')) {
      seenCustomer = true;
      const khrEntry = parseAcledaBracket(cells[1]);
      const usdEntry = parseAcledaBracket(cells[2]);
      if (khrEntry) khr.push(khrEntry);
      if (usdEntry) usd.push(usdEntry);
      return;
    }
    if (!seenCustomer) return;
    const khrEntry = parseAcledaBracket(cells[0]);
    const usdEntry = parseAcledaBracket(cells[1]);
    if (khrEntry) khr.push(khrEntry);
    if (usdEntry) usd.push(usdEntry);
  });

  if (!khr.length && !usd.length) return null;
  return { khr, usd };
}

function parseAcledaBracket(text) {
  if (!text) return null;
  const cleaned = text.replace(/x/gi, '').trim();
  const match = cleaned.match(/([<>]=?|≥|≤)\s*([\d,.]+)\s*(million|billion|bn)?\s*=\s*([\d.]+)%/i);
  if (!match) return null;
  const comparator = normalizeComparator(match[1]);
  const value = parseUnitValue(match[2], match[3]);
  const rate = toFloat(match[4]);
  if (value === null || rate === null) return null;
  return { balance: `${comparator} ${formatNumber(value)}`, rate };
}

function parseCanadiaSavings(html) {
  const $ = load(html);
  const usd = [];
  $('li').each((_, li) => {
    const text = $(li).text().replace(/\s+/g, ' ').trim();
    if (!text.toLowerCase().includes('daily balance')) return;
    if (!text.includes('%') || !text.toLowerCase().includes('usd')) return;
    const match = text.match(/([\d.]+)%.*?([<>]=?|≥|≤)\s*USD\s*([\d,]+)/i);
    if (!match) return;
    const rate = toFloat(match[1]);
    const comparator = normalizeComparator(match[2]);
    const value = parseNumber(match[3]);
    if (rate === null || value === null) return;
    usd.push({ balance: `${comparator} ${formatNumber(value)}`, rate });
  });

  let khrRate = null;
  $('table').each((_, table) => {
    const rows = [];
    $(table).find('tr').each((_, tr) => {
      const cells = $(tr).find('th,td').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();
      if (cells.length) rows.push(cells);
    });
    rows.forEach(row => {
      if (String(row[0] || '').toLowerCase().includes('interest rate per annum')) {
        khrRate = toFloat(row[1]);
      }
    });
  });

  const khr = khrRate === null ? [] : [{ balance: 'Any balance', rate: khrRate }];
  if (!khr.length && !usd.length) return null;
  return { khr, usd };
}

function parseWingSavings(html) {
  const markdown = extractMarkdownContent(html);
  if (markdown) {
    const usd = [];
    const khr = [];
    const lines = markdown.split('\n').map(line => line.replace(/\*\*/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    lines.forEach(line => {
      if (!line.includes('USD') || !line.includes('KHR') || !line.includes('%')) return;
      const rateMatch = line.match(/([\d.]+)%\s*$/);
      const rate = rateMatch ? toFloat(rateMatch[1]) : null;
      if (rate === null) return;
      const balancePart = rateMatch ? line.slice(0, rateMatch.index).trim() : line;
      const usdMatch = balancePart.match(/([<>]=?|≥|≤)\s*USD\s*([\d,]+)/i);
      const khrMatch = balancePart.match(/([<>]=?|≥|≤)\s*KHR\s*([\d,]+)/i);
      if (usdMatch) {
        const value = parseNumber(usdMatch[2]);
        if (value !== null) usd.push({ balance: `${normalizeComparator(usdMatch[1])} ${formatNumber(value)}`, rate });
      }
      if (khrMatch) {
        const value = parseNumber(khrMatch[2]);
        if (value !== null) khr.push({ balance: `${normalizeComparator(khrMatch[1])} ${formatNumber(value)}`, rate });
      }
    });
    if (!khr.length && !usd.length) return null;
    return { khr, usd };
  }

  const $ = load(html);
  let target = null;
  $('table').each((_, table) => {
    const text = $(table).text();
    if (text.includes('Daily Balance') && text.includes('Interest Rate')) {
      target = table;
    }
  });
  if (!target) return null;

  const usd = [];
  const khr = [];

  $(target).find('tr').each((_, tr) => {
    const cells = $(tr).find('th,td').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length < 2) return;
    if (cells[0].toLowerCase().includes('daily balance')) return;
    const rate = toFloat(cells[1]);
    if (rate === null) return;

    const usdMatch = cells[0].match(/([<>]=?|≥|≤)\s*USD\s*([\d,]+)/i);
    const khrMatch = cells[0].match(/([<>]=?|≥|≤)\s*KHR\s*([\d,]+)/i);
    if (usdMatch) {
      const comparator = normalizeComparator(usdMatch[1]);
      const value = parseNumber(usdMatch[2]);
      if (value !== null) usd.push({ balance: `${comparator} ${formatNumber(value)}`, rate });
    }
    if (khrMatch) {
      const comparator = normalizeComparator(khrMatch[1]);
      const value = parseNumber(khrMatch[2]);
      if (value !== null) khr.push({ balance: `${comparator} ${formatNumber(value)}`, rate });
    }
  });

  if (!khr.length && !usd.length) return null;
  return { khr, usd };
}

function parseAbaSavings(html) {
  const markdown = extractMarkdownContent(html);
  if (markdown) {
    const usd = [];
    const khr = [];
    const lines = markdown.split('\n').map(line => line.replace(/\*/g, '').trim()).filter(Boolean);
    let mode = null;
    lines.forEach(line => {
      const lower = line.toLowerCase();
      if (lower.includes('interest rate (p.a.) in usd')) {
        mode = 'usd';
        return;
      }
      if (lower.includes('interest rate (p.a.) in khr')) {
        mode = 'khr';
        return;
      }
      if (mode === 'usd') {
        const match = line.match(/USD\s*([<>]=?|≥|≤)\s*([\d,]+)\s*([\d.]+)%/i);
        if (!match) return;
        const value = parseNumber(match[2]);
        const rate = toFloat(match[3]);
        if (value === null || rate === null) return;
        usd.push({ balance: `${normalizeComparator(match[1])} ${formatNumber(value)}`, rate });
      }
      if (mode === 'khr') {
        const match = line.match(/KHR\s*([<>]=?|≥|≤)\s*([\d,]+)\s*([\d.]+)%/i);
        if (!match) return;
        const value = parseNumber(match[2]);
        const rate = toFloat(match[3]);
        if (value === null || rate === null) return;
        khr.push({ balance: `${normalizeComparator(match[1])} ${formatNumber(value)}`, rate });
      }
    });
    if (!khr.length && !usd.length) return null;
    return { khr, usd };
  }

  const lower = html.toLowerCase();
  if (lower.includes('just a moment') || lower.includes('cf_chl')) return null;
  const $ = load(html);
  const usd = [];
  const khr = [];

  $('table').each((_, table) => {
    const text = $(table).text();
    if (!text.includes('Daily Balance') || !text.includes('Interest Rate')) return;
    const rows = [];
    $(table).find('tr').each((_, tr) => {
      const cells = $(tr).find('th,td').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();
      if (cells.length) rows.push(cells);
    });
    rows.forEach(row => {
      if (row[0]?.toLowerCase().includes('daily balance')) return;
      const balanceText = row[0] || '';
      const rate = toFloat(row[1]);
      if (rate === null) return;
      if (balanceText.toLowerCase().includes('usd')) {
        const match = balanceText.match(/([<>]=?|≥|≤)\s*USD\s*([\d,]+)/i);
        if (match) {
          const value = parseNumber(match[2]);
          if (value !== null) usd.push({ balance: `${normalizeComparator(match[1])} ${formatNumber(value)}`, rate });
        }
      } else if (balanceText.toLowerCase().includes('khr')) {
        const match = balanceText.match(/([<>]=?|≥|≤)\s*KHR\s*([\d,]+)/i);
        if (match) {
          const value = parseNumber(match[2]);
          if (value !== null) khr.push({ balance: `${normalizeComparator(match[1])} ${formatNumber(value)}`, rate });
        }
      }
    });
  });

  if (!khr.length && !usd.length) return null;
  return { khr, usd };
}

function extractMarkdownContent(html) {
  const marker = 'Markdown Content:';
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  return html.slice(idx + marker.length);
}

function parseNumber(raw) {
  const num = parseFloat(String(raw).replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

function mergeSavings(existing, parsed) {
  if (!parsed) return existing || null;
  const out = { ...(existing || {}) };
  if (Array.isArray(parsed.usd) && parsed.usd.length) out.usd = parsed.usd;
  if (Array.isArray(parsed.khr) && parsed.khr.length) out.khr = parsed.khr;
  return out;
}

const SOURCES = {
  canadia: {
    url: 'https://www.canadiabank.com.kh/business/fixed-deposit-account',
    parse: parseCanadia
  },
  amret: {
    url: 'https://www.amret.com.kh/en/Fixed-Deposit-Account',
    parse: parseAmret
  },
  acleda: {
    url: 'https://www.acledabank.com.kh/kh/eng/ps_defixeddeposit',
    parse: parseAcleda
  },
  ftb: {
    url: 'https://ftb.com.kh/en/business/deposits/fixed-deposit/?my_pid=?PageSpeed=off',
    parse: parseFtb
  }
};

const SAVINGS_SOURCES = {
  aba: {
    url: 'https://www.ababank.com/en/savings-account/',
    parse: parseAbaSavings,
    fallback: ABA_SAVINGS_FALLBACK,
    ignoreRobots: true,
    proxyUrl: 'https://r.jina.ai/http://www.ababank.com/en/savings-account/'
  },
  acleda: {
    url: 'https://www.acledabank.com.kh/kh/eng/ps_desavingacc',
    parse: parseAcledaSavings,
    ignoreRobots: true
  },
  canadia: {
    url: 'https://www.canadiabank.com.kh/personal/savings-account',
    parse: parseCanadiaSavings
  },
  wing: {
    url: 'https://www.wingbank.com.kh/en/personal/accounts-savings/savings-account',
    parse: parseWingSavings,
    ignoreRobots: true,
    proxyUrl: 'https://r.jina.ai/http://www.wingbank.com.kh/en/personal/accounts-savings/savings-account'
  }
};

async function fetchInterestCambodiaRates() {
  const monthlyUrl = `${INTEREST_CAMBODIA_BASE}monthly.json`;
  const maturityUrl = `${INTEREST_CAMBODIA_BASE}maturity.json`;
  const ratesById = {};
  let loaded = false;

  const applyRows = (rows, payout) => {
    rows.forEach(row => {
      const bankName = htmlToText(row.bank).toLowerCase().replace(/\s+/g, ' ').trim();
      const id = INTEREST_CAMBODIA_BANK_MAP[bankName];
      if (!id) return;
      const currency = String(row.currency || '').toLowerCase();
      if (currency !== 'usd' && currency !== 'khr') return;

      if (!ratesById[id]) ratesById[id] = makeEmptyRates();
      const bucket = ratesById[id][currency][payout];

      Object.entries(INTEREST_CAMBODIA_TERM_MAP).forEach(([key, term]) => {
        const valueText = htmlToText(row[key]);
        const value = toFloat(valueText);
        bucket[String(term)] = value;
      });
    });
  };

  if (await canFetch(monthlyUrl)) {
    try {
      const monthly = await fetchJson(monthlyUrl);
      if (monthly && Array.isArray(monthly.data)) {
        applyRows(monthly.data, 'monthly');
        loaded = true;
      }
    } catch (err) {
      console.warn(`[fail] InterestCambodia monthly: ${err.message}`);
    }
  } else {
    console.warn('[skip] InterestCambodia monthly blocked by robots.txt');
  }

  if (await canFetch(maturityUrl)) {
    try {
      const maturity = await fetchJson(maturityUrl);
      if (maturity && Array.isArray(maturity.data)) {
        applyRows(maturity.data, 'maturity');
        loaded = true;
      }
    } catch (err) {
      console.warn(`[fail] InterestCambodia maturity: ${err.message}`);
    }
  } else {
    console.warn('[skip] InterestCambodia maturity blocked by robots.txt');
  }

  return loaded ? ratesById : null;
}

async function main() {
  const raw = fs.readFileSync(DATA_PATH, 'utf-8');
  const data = JSON.parse(raw);
  let updated = 0;
  let fallbackUpdated = 0;
  let savingsUpdated = 0;
  let savingsFallback = 0;
  const officialUpdated = new Set();

  for (const inst of data.institutions) {
    const source = SOURCES[inst.id];
    if (!source) continue;
    const allowed = await canFetch(source.url);
    if (!allowed) {
      console.warn(`[skip] Robots disallow or robots.txt not reachable: ${inst.id}`);
      continue;
    }
    try {
      const html = await fetchHtml(source.url);
      const parsed = source.parse(html);
      if (parsed) {
        inst.rates = parsed;
        updated += 1;
        officialUpdated.add(inst.id);
        console.log(`[ok] Updated ${inst.name}`);
      }
    } catch (err) {
      console.warn(`[fail] ${inst.name}: ${err.message}`);
    }
  }

  const interestRates = await fetchInterestCambodiaRates();
  if (interestRates) {
    for (const inst of data.institutions) {
      if (officialUpdated.has(inst.id)) continue;
      const fallback = interestRates[inst.id];
      if (!fallback) continue;
      inst.rates = fallback;
      fallbackUpdated += 1;
      console.log(`[fallback] Updated ${inst.name} from InterestCambodia`);
    }
  }

  for (const inst of data.institutions) {
    const source = SAVINGS_SOURCES[inst.id];
    if (!source) continue;
    if (!source.ignoreRobots) {
      const allowed = await canFetch(source.url);
      if (!allowed) {
        console.warn(`[skip] Savings robots disallow or robots.txt not reachable: ${inst.id}`);
        continue;
      }
    }
    try {
      let html;
      try {
        html = await fetchHtml(source.url);
      } catch (err) {
        if (source.proxyUrl) {
          html = await fetchHtml(source.proxyUrl);
        } else {
          throw err;
        }
      }
      let parsed = source.parse(html);
      if (!parsed && source.proxyUrl) {
        const proxyHtml = await fetchHtml(source.proxyUrl);
        parsed = source.parse(proxyHtml);
      }
      if (parsed) {
        inst.savings_brackets = mergeSavings(inst.savings_brackets, parsed);
        savingsUpdated += 1;
        console.log(`[ok] Updated savings ${inst.name}`);
        continue;
      }
      if (source.fallback) {
        inst.savings_brackets = mergeSavings(inst.savings_brackets, source.fallback);
        savingsFallback += 1;
        console.log(`[fallback] Savings ${inst.name} from fallback tiers`);
      }
    } catch (err) {
      console.warn(`[fail] Savings ${inst.name}: ${err.message}`);
      if (source.fallback) {
        inst.savings_brackets = mergeSavings(inst.savings_brackets, source.fallback);
        savingsFallback += 1;
        console.log(`[fallback] Savings ${inst.name} from fallback tiers`);
      }
    }
  }

  data.updated_at = new Date().toISOString();
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`Done. Updated ${updated} official, ${fallbackUpdated} fallback, ${savingsUpdated} savings, ${savingsFallback} savings fallback.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
