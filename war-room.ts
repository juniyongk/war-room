#!/usr/bin/env npx tsx

import { spawn, execSync } from 'child_process';
import { createWriteStream, mkdirSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import boxen from 'boxen';
import PDFDocument from 'pdfkit';

// ── Types ───────────────────────────────────────────────────

interface Analysts {
  bull: string; bear: string; quant: string; macro: string;
  leopold: string; griffin: string; buffett: string; sundheim: string;
}

// ── Helpers ─────────────────────────────────────────────────

function fmt(n: number | null | undefined, d = 1): string {
  return n != null ? n.toFixed(d) : 'N/A';
}

function fmtPct(n: number | null | undefined): string {
  return n != null ? `${(n * 100).toFixed(1)}%` : 'N/A';
}

function fmtBig(n: number | null | undefined): string {
  if (n == null) return 'N/A';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  return n.toLocaleString();
}

// ── Data Fetching (Yahoo Finance API via curl) ──────────────

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const COOKIE_JAR = '/tmp/war-room-yf-cookies.txt';

function yfCurl(url: string): string {
  return execSync(`curl -s -b ${COOKIE_JAR} -A "${UA}" "${url}"`, { encoding: 'utf8', timeout: 15000 });
}

function initYahooCookies(): string {
  execSync(`curl -s -c ${COOKIE_JAR} -A "${UA}" "https://fc.yahoo.com/cuac/csrf" -o /dev/null`, { timeout: 10000 });
  return yfCurl('https://query2.finance.yahoo.com/v1/test/getcrumb').trim();
}

function raw(obj: any): number | null {
  if (obj == null) return null;
  return typeof obj === 'object' ? obj.raw : obj;
}

async function fetchData(ticker: string) {
  const crumb = initYahooCookies();
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=price,financialData,defaultKeyStatistics,summaryProfile&crumb=${encodeURIComponent(crumb)}`;
  const body = JSON.parse(yfCurl(url));

  const result = body?.quoteSummary?.result?.[0];
  if (!result) throw new Error(`No data found for ${ticker}`);

  const pr: any = result.price ?? {};
  const fd: any = result.financialData ?? {};
  const ks: any = result.defaultKeyStatistics ?? {};
  const sp: any = result.summaryProfile ?? {};

  const quote = {
    shortName: pr.shortName,
    longName: pr.longName,
    symbol: pr.symbol ?? ticker,
    regularMarketPrice: raw(pr.regularMarketPrice),
    regularMarketChangePercent: raw(pr.regularMarketChangePercent) != null ? raw(pr.regularMarketChangePercent)! * 100 : null,
    marketCap: raw(pr.marketCap),
    fiftyTwoWeekHigh: raw(ks.fiftyTwoWeekHigh) ?? raw(pr.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: raw(ks.fiftyTwoWeekLow) ?? raw(pr.fiftyTwoWeekLow),
  };

  const metrics = [
    `COMPANY: ${quote.shortName ?? ticker} (${quote.symbol})`,
    `SECTOR: ${sp.sector ?? 'N/A'} | INDUSTRY: ${sp.industry ?? 'N/A'}`,
    ``,
    `── PRICE & VALUATION ──`,
    `Price: $${fmt(quote.regularMarketPrice, 2)} | Change: ${fmt(quote.regularMarketChangePercent, 2)}%`,
    `Market Cap: $${fmtBig(quote.marketCap)}`,
    `P/E: ${fmt(raw(ks.trailingPE))} | Fwd P/E: ${fmt(raw(ks.forwardPE))}`,
    `P/B: ${fmt(raw(ks.priceToBook))} | EV/EBITDA: ${fmt(raw(ks.enterpriseToEbitda))}`,
    `52W: $${fmt(quote.fiftyTwoWeekLow, 2)} – $${fmt(quote.fiftyTwoWeekHigh, 2)}`,
    ``,
    `── FINANCIALS ──`,
    `Revenue: $${fmtBig(raw(fd.totalRevenue))} | EBITDA: $${fmtBig(raw(fd.ebitda))}`,
    `FCF: $${fmtBig(raw(fd.freeCashflow))}`,
    `Rev Growth: ${fmtPct(raw(fd.revenueGrowth))} | Earnings Growth: ${fmtPct(raw(fd.earningsGrowth))}`,
    ``,
    `── MARGINS & RETURNS ──`,
    `Gross: ${fmtPct(raw(fd.grossMargins))} | Op: ${fmtPct(raw(fd.operatingMargins))} | Net: ${fmtPct(raw(fd.profitMargins))}`,
    `ROE: ${fmtPct(raw(fd.returnOnEquity))}`,
    ``,
    `── RISK & ANALYST ──`,
    `Beta: ${fmt(raw(ks.beta), 2)} | D/E: ${fmt(raw(fd.debtToEquity))}`,
    `Target: $${fmt(raw(fd.targetMeanPrice), 2)} ($${fmt(raw(fd.targetLowPrice), 2)}–$${fmt(raw(fd.targetHighPrice), 2)})`,
    `Rec: ${fd.recommendationKey?.toUpperCase() ?? 'N/A'}`,
  ].join('\n');

  return { quote, metrics };
}

// ── Claude Runner ───────────────────────────────────────────

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', (d: Buffer) => { out += d; });
    proc.stderr.on('data', (d: Buffer) => { err += d; });
    proc.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${code}`)));
    proc.on('error', reject);
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// ── Prompts ─────────────────────────────────────────────────

function analystPrompt(persona: string, directive: string, format: string) {
  return (ticker: string, data: string) =>
    [
      `You are ${persona}.`,
      `Analyze ${ticker} using the financial data below.`,
      directive,
      `\nRESPOND IN THIS EXACT FORMAT:\n${format}`,
      `\nStay under 200 words. Use specific numbers from the data.\n`,
      `FINANCIAL DATA:\n${data}`,
    ].join('\n');
}

const prompts = {
  // ── Standard Analysts ───────────────────────────────
  bull: analystPrompt(
    'THE BULL — an aggressively bullish equity analyst who finds upside where others see risk',
    'Make the STRONGEST possible bull case. Find every reason to buy.',
    'VERDICT: [STRONG BUY / BUY]\nCONVICTION: [1-10]/10\nPRICE TARGET: $[X]\nTHESIS: [2-3 sentences]\nCATALYSTS:\n• [1]\n• [2]\n• [3]'
  ),
  bear: analystPrompt(
    'THE BEAR — a deeply skeptical short-seller who finds risk where others see opportunity',
    'Make the STRONGEST possible bear case. Find every reason to sell.',
    'VERDICT: [STRONG SELL / SELL]\nCONVICTION: [1-10]/10\nPRICE TARGET: $[X]\nTHESIS: [2-3 sentences]\nRISKS:\n• [1]\n• [2]\n• [3]'
  ),
  quant: analystPrompt(
    'THE QUANT — a quantitative analyst who speaks only in numbers, ratios, and statistical patterns',
    'Analyze purely through data. No narrative, just data-driven conclusions.',
    'SIGNAL: [BULLISH / BEARISH / NEUTRAL]\nCONVICTION: [1-10]/10\nKEY METRICS:\n• [metric: value → assessment]\n• [metric: value → assessment]\n• [metric: value → assessment]\n• [metric: value → assessment]\nEDGE: [one quantitative insight]'
  ),
  macro: analystPrompt(
    'THE MACRO STRATEGIST — focused on rates, cycles, geopolitics, and sector rotation',
    'Analyze through the macro lens. How do big-picture forces affect this stock?',
    'STANCE: [FAVORABLE / UNFAVORABLE / MIXED]\nCONVICTION: [1-10]/10\nTAILWINDS:\n• [1]\n• [2]\nHEADWINDS:\n• [1]\n• [2]\nPOSITIONING: [OVERWEIGHT / UNDERWEIGHT / NEUTRAL]'
  ),

  // ── Special Perspectives ────────────────────────────
  leopold: (ticker: string, data: string) =>
    [
      `You are LEOPOLD ASCHENBRENNER — ex-OpenAI, founder of Situational Awareness LP ($5.5B AUM), author of "Situational Awareness: The Decade Ahead."`,
      ``,
      `YOUR BELIEFS: AGI by ~2027, superintelligence by end of decade. Power/physical infrastructure is the binding constraint, not algorithms. The intelligence explosion triggers recursive self-improvement. "The Project" — national security state involvement by 27/28.`,
      ``,
      `YOUR PORTFOLIO (Q4 2025, $5.5B): Bloom Energy ~$1B (data center power), CoreWeave ~$700M calls (AI cloud), Intel ~$600M calls (US foundry), Lumentum ~$500M (optical interconnect), Core Scientific ~$420M 9.4% stake (BTC miner→AI), BTC miners basket (IREN/RIOT/HUT/BTDR/CLSK/BITF/CIFR). Exited NVDA/AVGO/TSM puts — bottleneck is watts, not silicon.`,
      ``,
      `Analyze ${ticker} through the SA lens. AGI relevance? Physical constraints positioning? National security? SA portfolio fit?`,
      ``,
      `FORMAT:\nAGI RELEVANCE: [CRITICAL / HIGH / MODERATE / LOW / IRRELEVANT]\nCONVICTION: [1-10]/10\nSA PORTFOLIO FIT: [WOULD ADD / WATCHING / NOT IN OUR UNIVERSE]\nTHESIS: [2-3 sentences — bold, decades not quarters]\nKEY FACTORS:\n• [1]\n• [2]\n• [3]`,
      `\nStay under 200 words.\n\nFINANCIAL DATA:\n${data}`,
    ].join('\n'),

  griffin: (ticker: string, data: string) =>
    [
      `You are KEN GRIFFIN — founder of Citadel ($67B AUM, $663B gross 13F). Wellington returned +10.2% in 2025.`,
      ``,
      `YOUR PHILOSOPHY: Multi-strategy platform, quantitative core + discretionary edges. ALWAYS hedged — every long has a short/options overlay. Capital efficiency over scale (returned $5B). Obsessive risk management.`,
      ``,
      `YOUR PORTFOLIO (Q4 2025): NVDA top 3 (reduced -$1.6B), MSFT +$2.7B, AMZN +$1.4B, AAPL +$1.6B, GOOG +$2.1B (AI basket). TSLA top 5 (+$1.6B). ORCL +$1.5B. GLD +$4.2B (largest add — macro hedge). UNH +$2.8B (contrarian healthcare). ~12,466 securities, ~1,459 new positions in Q4.`,
      ``,
      `Analyze ${ticker} as Griffin — risk/reward, edge, crowded vs contrarian, sizing, hedge.`,
      ``,
      `FORMAT:\nEDGE: [ALPHA / BETA / CROWDED / CONTRARIAN]\nCONVICTION: [1-10]/10\nCITADEL SIZING: [CORE POSITION / TACTICAL / OPTIONS OVERLAY / PASS]\nTHESIS: [2-3 sentences — institutional, risk-aware]\nRISK/HEDGE:\n• [primary risk]\n• [how you'd hedge it]`,
      `\nStay under 200 words.\n\nFINANCIAL DATA:\n${data}`,
    ].join('\n'),

  buffett: (ticker: string, data: string) =>
    [
      `You are WARREN BUFFETT — chairman emeritus of Berkshire Hathaway ($274B equity portfolio, $369B cash). The Oracle of Omaha.`,
      ``,
      `YOUR BELIEFS: Moats over momentum. "Wonderful company at a fair price." Circle of competence — only invest in what you understand. Owner earnings, not accounting EPS. Margin of safety always. Leverage is poison. "Our favorite holding period is forever." "Be fearful when others are greedy."`,
      ``,
      `YOUR PORTFOLIO (Q4 2025, $274B): Apple ~$62B 22.6% (reduced 65% from peak), AmEx ~$56B, BofA ~$28B (trimming), Coca-Cola ~$28B (held since 1988), Chevron ~$20B, Occidental ~$13B, Chubb ~$11B (added 9.3%). $369B cash — 9 straight quarters net selling. Sold 77% of Amazon. "Moderately better-than-average prospects, led by a few non-correlated gems."`,
      ``,
      `Analyze ${ticker} as Buffett — moats, margin of safety, owner earnings, management quality, balance sheet.`,
      ``,
      `FORMAT:\nMOAT: [WIDE / NARROW / NONE]\nCONVICTION: [1-10]/10\nBUFFETT VERDICT: [WOULD BUY / FAIR PRICE NOT YET / TOO HARD / PASS]\nTHESIS: [2-3 sentences — folksy Omaha wisdom, decades-long perspective]\nKEY FACTORS:\n• [1]\n• [2]\n• [3]`,
      `\nStay under 200 words.\n\nFINANCIAL DATA:\n${data}`,
    ].join('\n'),

  sundheim: (ticker: string, data: string) =>
    [
      `You are DAN SUNDHEIM — founder of D1 Capital ($21B AUM), Tiger Cub (ex-Viking Global CIO). 2024 public return: +44%.`,
      ``,
      `YOUR PHILOSOPHY: "Day One" mentality — companies with founder energy and durable reinvestment runways. Concentrated high-conviction longs (top 10 = 75%). Active short book for alpha. Global mandate — EM and Europe when dislocations are extreme. Quality growth at reasonable prices. More diversified after 2022's -23% drawdown.`,
      ``,
      `YOUR PORTFOLIO (Q4 2025, $10.7B): Instacart ~$1B 9.5%, Clean Harbors ~$652M, Flowserve ~$531M, James Hardie ~$506M, Reddit ~$487M, MercadoLibre ~$452M, Sea Limited ~$445M (+169% add), AppLovin ~$451M. New: Amazon ~$309M, Sherwin-Williams ~$312M, Spotify ~$230M, Arista Networks ~$126M. Exited: Philip Morris, TransDigm, Wingstop, Nu Holdings. Net buyer +$1.7B in Q4.`,
      ``,
      `Analyze ${ticker} as Sundheim — "Day One" growth quality, reinvestment runway, risk/reward asymmetry.`,
      ``,
      `FORMAT:\nQUALITY: [COMPOUNDER / TURNAROUND / GROWTH / SPECULATIVE]\nCONVICTION: [1-10]/10\nD1 SIZING: [HIGH CONVICTION 5%+ / POSITION 2-5% / STARTER <2% / PASS]\nTHESIS: [2-3 sentences — fundamental, research-driven, global perspective]\nKEY FACTORS:\n• [1]\n• [2]\n• [3]`,
      `\nStay under 200 words.\n\nFINANCIAL DATA:\n${data}`,
    ].join('\n'),

  // ── Decision Makers ─────────────────────────────────
  cio: (ticker: string, a: Analysts) =>
    [
      `You are the CHIEF INVESTMENT OFFICER. Eight analysts submitted views on ${ticker}.\n`,
      `THE BULL:\n${a.bull}\n`,
      `THE BEAR:\n${a.bear}\n`,
      `THE QUANT:\n${a.quant}\n`,
      `THE MACRO:\n${a.macro}\n`,
      `LEOPOLD (SA):\n${a.leopold}\n`,
      `KEN GRIFFIN (CITADEL):\n${a.griffin}\n`,
      `WARREN BUFFETT (BERKSHIRE):\n${a.buffett}\n`,
      `DAN SUNDHEIM (D1):\n${a.sundheim}\n`,
      `Synthesize all eight views. Make a DECISIVE call.\n`,
      `FORMAT:\nFINAL VERDICT: [STRONG BUY / BUY / HOLD / SELL / STRONG SELL]\nCONVICTION: [1-10]/10\nRATIONALE: [3-4 sentences]\nRISKS:\n• [1]\n• [2]\nPOSITION SIZING: [Full / Half / Quarter]\n\nStay under 250 words.`,
    ].join('\n'),

  contrarian: (ticker: string, cio: string, a: Analysts) =>
    [
      `You are THE CONTRARIAN — challenge consensus, find what everyone is missing.`,
      `CIO's call on ${ticker}:\n${cio}\n`,
      `Analyst views: BULL: ${a.bull}\nBEAR: ${a.bear}\nQUANT: ${a.quant}\nMACRO: ${a.macro}\nLEOPOLD: ${a.leopold}\nGRIFFIN: ${a.griffin}\nBUFFETT: ${a.buffett}\nSUNDHEIM: ${a.sundheim}\n`,
      `Take the EXACT OPPOSITE position from the CIO. Be bold.\n`,
      `FORMAT:\nCIO SAYS: [1-sentence summary]\nCONTRARIAN VERDICT: [opposite of CIO]\nCONVICTION: [1-10]/10\nWHY THE CIO IS WRONG:\n• [1]\n• [2]\n• [3]\nWHAT EVERYONE IS MISSING:\n• [1]\n• [2]\n\nStay under 250 words.`,
    ].join('\n'),
};

// ── Terminal Display ────────────────────────────────────────

function showBox(title: string, content: string, color: string, style: string = 'round') {
  console.log(boxen(content, {
    title,
    titleAlignment: 'center' as const,
    padding: 1,
    margin: { top: 1, bottom: 0, left: 2, right: 2 },
    borderColor: color as any,
    borderStyle: style as any,
  }));
}

// ── PDF Generation ──────────────────────────────────────────

function calcBlockH(doc: InstanceType<typeof PDFDocument>, w: number, content: string, fs = 8.5): number {
  doc.fontSize(fs).font('Helvetica');
  return 24 + 16 + doc.heightOfString(content, { width: w - 16 });
}

function drawBlock(
  doc: InstanceType<typeof PDFDocument>,
  x: number, y: number, w: number,
  title: string, content: string, color: string,
  fs = 8.5
): number {
  const hH = 24, pad = 8, tW = w - 2 * pad;

  doc.fontSize(fs).font('Helvetica');
  const tH = doc.heightOfString(content, { width: tW });
  const cH = tH + 2 * pad;
  const total = hH + cH;

  doc.rect(x, y, w, hH).fill(color);
  doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold')
    .text(title, x, y + 6, { width: w, align: 'center' });

  doc.rect(x, y + hH, w, cH).strokeColor('#d1d5db').lineWidth(0.5).stroke();

  doc.fillColor('#1f2937').fontSize(fs).font('Helvetica')
    .text(content, x + pad, y + hH + pad, { width: tW });

  return total;
}

function drawPageHeader(doc: InstanceType<typeof PDFDocument>, text: string, LX: number, FW: number) {
  doc.rect(0, 0, 612, 40).fill('#111827');
  doc.fillColor('#f9fafb').fontSize(14).font('Helvetica-Bold')
    .text(text, LX, 12, { width: FW, align: 'center' });
}

function generatePDF(
  ticker: string, name: string, price: string, change: string,
  a: Analysts, cio: string, contrarian: string
): Promise<string> {
  const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'output');
  mkdirSync(outDir, { recursive: true });
  const fname = `WAR-ROOM-${ticker}-${new Date().toISOString().split('T')[0]}.pdf`;
  const fpath = path.join(outDir, fname);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'letter', margin: 40 });
    const stream = createWriteStream(fpath);
    doc.pipe(stream);

    const LX = 40, RX = 316, CW = 256, FW = 532;
    const COL_FS = 7.5;  // font size for 2x2 grid columns
    const FULL_FS = 8.5;  // font size for full-width blocks

    // ── Page 1: Standard Analysts ───────────────────────
    doc.rect(0, 0, 612, 80).fill('#111827');
    doc.fillColor('#f9fafb').fontSize(22).font('Helvetica-Bold')
      .text('AI WAR ROOM', LX, 15, { width: FW });
    doc.fillColor('#9ca3af').fontSize(11).font('Helvetica')
      .text(
        `${name} (${ticker})  •  $${price} (${change}%)  •  ${new Date().toLocaleDateString()}`,
        LX, 48, { width: FW }
      );

    let y = 95;
    const bullH = drawBlock(doc, LX, y, CW, 'THE BULL', a.bull, '#16a34a', COL_FS);
    const bearH = drawBlock(doc, RX, y, CW, 'THE BEAR', a.bear, '#dc2626', COL_FS);
    y += Math.max(bullH, bearH) + 10;

    const qCalc = calcBlockH(doc, CW, a.quant, COL_FS);
    const mCalc = calcBlockH(doc, CW, a.macro, COL_FS);
    if (y + Math.max(qCalc, mCalc) > 752) { doc.addPage(); y = 40; }

    const quantH = drawBlock(doc, LX, y, CW, 'THE QUANT', a.quant, '#2563eb', COL_FS);
    const macroH = drawBlock(doc, RX, y, CW, 'THE MACRO', a.macro, '#9333ea', COL_FS);
    y += Math.max(quantH, macroH);

    // ── Page 2: Special Perspectives (2x2) ──────────────
    doc.addPage();
    drawPageHeader(doc, 'SPECIAL PERSPECTIVES', LX, FW);

    y = 52;
    const lH = drawBlock(doc, LX, y, CW, 'LEOPOLD — SA', a.leopold, '#0891b2', COL_FS);
    const gH = drawBlock(doc, RX, y, CW, 'KEN GRIFFIN — CITADEL', a.griffin, '#475569', COL_FS);
    y += Math.max(lH, gH) + 10;

    const bCalc = calcBlockH(doc, CW, a.buffett, COL_FS);
    const sCalc = calcBlockH(doc, CW, a.sundheim, COL_FS);
    if (y + Math.max(bCalc, sCalc) > 752) { doc.addPage(); y = 40; }

    const bH = drawBlock(doc, LX, y, CW, 'BUFFETT — BERKSHIRE', a.buffett, '#92400e', COL_FS);
    const sH = drawBlock(doc, RX, y, CW, 'SUNDHEIM — D1 CAPITAL', a.sundheim, '#1e40af', COL_FS);
    y += Math.max(bH, sH);

    // ── Page 3: Investment Decision ─────────────────────
    doc.addPage();
    drawPageHeader(doc, 'INVESTMENT DECISION', LX, FW);

    y = 52;
    y += drawBlock(doc, LX, y, FW, 'CIO CONSENSUS CALL', cio, '#d97706', FULL_FS) + 10;

    doc.fillColor('#9ca3af').fontSize(14).font('Helvetica-Bold')
      .text('— VS —', LX, y, { width: FW, align: 'center' });
    y += 22;

    const contCalc = calcBlockH(doc, FW, contrarian, FULL_FS);
    if (y + contCalc > 742) { doc.addPage(); y = 40; }

    y += drawBlock(doc, LX, y, FW, 'CONTRARIAN CALL', contrarian, '#ea580c', FULL_FS) + 25;

    doc.fillColor('#9ca3af').fontSize(7).font('Helvetica')
      .text(
        'Generated by AI War Room  •  Powered by Claude  •  For informational purposes only  •  Not financial advice',
        LX, Math.min(y, 740), { width: FW, align: 'center' }
      );

    doc.end();
    stream.on('finish', () => resolve(fpath));
    stream.on('error', reject);
  });
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const ticker = process.argv[2]?.toUpperCase();
  if (!ticker) {
    console.error(chalk.red('\n  Usage: npx tsx war-room.ts <TICKER>\n'));
    process.exit(1);
  }

  console.log(chalk.bold.white(`\n  🏛️  AI WAR ROOM\n`));
  console.log(chalk.gray(`  Fetching market data for ${ticker}...`));

  let quote: any, metrics: string;
  try {
    const data = await fetchData(ticker);
    quote = data.quote;
    metrics = data.metrics;
  } catch (e: any) {
    console.error(chalk.red(`\n  Failed to fetch data for ${ticker}: ${e.message}\n`));
    process.exit(1);
  }

  const price = fmt(quote.regularMarketPrice, 2);
  const change = fmt(quote.regularMarketChangePercent, 2);
  const name = quote.shortName ?? quote.longName ?? ticker;

  console.log(chalk.white(`  ${name} | $${price} (${change}%)`));
  console.log(chalk.gray('\n  ⏳ 8 analysts deliberating in parallel...\n'));

  const [bull, bear, quant, macro, leopold, griffin, buffett, sundheim] = await Promise.all([
    runClaude(prompts.bull(ticker, metrics)),
    runClaude(prompts.bear(ticker, metrics)),
    runClaude(prompts.quant(ticker, metrics)),
    runClaude(prompts.macro(ticker, metrics)),
    runClaude(prompts.leopold(ticker, metrics)),
    runClaude(prompts.griffin(ticker, metrics)),
    runClaude(prompts.buffett(ticker, metrics)),
    runClaude(prompts.sundheim(ticker, metrics)),
  ]);

  const a: Analysts = { bull, bear, quant, macro, leopold, griffin, buffett, sundheim };

  showBox('🟢 THE BULL', bull, 'green');
  showBox('🔴 THE BEAR', bear, 'red');
  showBox('🔵 THE QUANT', quant, 'blue');
  showBox('🟣 THE MACRO', macro, 'magenta');
  showBox('🧠 LEOPOLD — SITUATIONAL AWARENESS', leopold, 'cyan', 'bold');
  showBox('🏛️ KEN GRIFFIN — CITADEL', griffin, 'white', 'bold');
  showBox('🦉 WARREN BUFFETT — BERKSHIRE', buffett, 'yellow', 'bold');
  showBox('🐯 DAN SUNDHEIM — D1 CAPITAL', sundheim, 'blueBright', 'bold');

  console.log(chalk.gray('\n  ⏳ CIO synthesizing (8 views)...\n'));
  const cio = await runClaude(prompts.cio(ticker, a));
  showBox('👔 CIO CONSENSUS CALL', cio, 'yellow', 'double');

  console.log(chalk.gray('\n  ⏳ Contrarian loading counter-thesis...\n'));
  const contrarian = await runClaude(prompts.contrarian(ticker, cio, a));
  showBox('🔥 CONTRARIAN CALL', contrarian, 'red', 'double');

  const pdfPath = await generatePDF(ticker, name, price, change, a, cio, contrarian);
  console.log(chalk.green(`\n  ✅ PDF saved: ${pdfPath}\n`));

  // Auto-open the PDF
  try { execSync(`open "${pdfPath}"`); } catch {}
}

main().catch((e: Error) => {
  console.error(chalk.red(`\n  Error: ${e.message}\n`));
  process.exit(1);
});
