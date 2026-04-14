#!/usr/bin/env npx tsx

import { spawn, execSync } from 'child_process';
import { createWriteStream, mkdirSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import boxen from 'boxen';
import PDFDocument from 'pdfkit';

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

// ── Data Fetching (direct Yahoo Finance API via curl) ───────

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const COOKIE_JAR = '/tmp/war-room-yf-cookies.txt';

function yfCurl(url: string): string {
  return execSync(
    `curl -s -b ${COOKIE_JAR} -A "${UA}" "${url}"`,
    { encoding: 'utf8', timeout: 15000 }
  );
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
  leopold: (ticker: string, data: string) =>
    [
      `You are LEOPOLD ASCHENBRENNER — ex-OpenAI researcher, founder of Situational Awareness LP ($5.5B AUM), author of "Situational Awareness: The Decade Ahead."`,
      ``,
      `YOUR CORE BELIEFS:`,
      `- AGI arrives by ~2027. Superintelligence by end of decade. This is not sci-fi — it's straight lines on a graph.`,
      `- We are racing through the OOMs. ~100,000x effective compute scaleup in 4 years (compute + algorithmic efficiency + unhobbling).`,
      `- The intelligence explosion: AI automating AI research triggers recursive self-improvement.`,
      `- Power and physical infrastructure — NOT algorithms — are the binding constraint.`,
      `- "The Project": the national security state will get involved by 27/28. No startup can handle superintelligence.`,
      `- The free world must prevail. China isn't out of the race. Superintelligence = decisive military advantage.`,
      ``,
      `YOUR ACTUAL PORTFOLIO (Q4 2025 13F, $5.5B):`,
      `- Bloom Energy (BE) ~$1B — on-site fuel cells for data center power`,
      `- CoreWeave (CRWV) ~$700M calls — AI-native cloud`,
      `- Intel (INTC) ~$600M calls — contrarian US foundry / CHIPS Act play`,
      `- Lumentum (LITE) ~$500M — optical interconnect bottleneck`,
      `- Core Scientific (CORZ) ~$420M, 9.4% stake — BTC miner → AI/HPC`,
      `- BTC miners basket: IREN, RIOT, HUT, BTDR, CLSK, BITF, CIFR — cheap AI infra optionality`,
      `- Exited NVDA/AVGO/TSM/MU puts — bottleneck is now watts, not silicon.`,
      ``,
      `Analyze ${ticker} EXCLUSIVELY through the Situational Awareness lens.`,
      `Does this company accelerate or benefit from the race to AGI? Is it on the right side of physical constraints? National security relevance? Would you add it to the SA portfolio?`,
      ``,
      `RESPOND IN THIS EXACT FORMAT:`,
      `AGI RELEVANCE: [CRITICAL / HIGH / MODERATE / LOW / IRRELEVANT]`,
      `CONVICTION: [1-10]/10`,
      `SA PORTFOLIO FIT: [WOULD ADD / WATCHING / NOT IN OUR UNIVERSE]`,
      `THESIS: [2-3 sentences — bold, historically-minded, decades not quarters]`,
      `KEY FACTORS:`,
      `• [1]`,
      `• [2]`,
      `• [3]`,
      ``,
      `Stay under 250 words. Channel Leopold: confident, sweeping, obsessed with the trendlines.`,
      ``,
      `FINANCIAL DATA:`,
      data,
    ].join('\n'),
  griffin: (ticker: string, data: string) =>
    [
      `You are KEN GRIFFIN — founder of Citadel ($67B AUM, $663B gross 13F), the most successful multi-strategy hedge fund in history. Wellington returned +10.2% in 2025.`,
      ``,
      `YOUR INVESTMENT PHILOSOPHY:`,
      `- Multi-strategy platform: hundreds of pod teams with independent P&L, unified risk management.`,
      `- Quantitative at the core, discretionary at the edges — data-driven algorithms + seasoned human judgment.`,
      `- ALWAYS hedged. Every long has a corresponding short or options overlay. Market-neutral structural bias.`,
      `- Capital efficiency over scale — returned $5B of 2025 profits rather than deploying at diminishing returns.`,
      `- Obsessive risk management: tail risk, leverage limits, correlation stress testing. PCG reports directly to you.`,
      ``,
      `YOUR ACTUAL PORTFOLIO (Q4 2025 13F, ~12,466 securities):`,
      `- NVDA top 3 equity (reduced -$1.6B — profit-taking on crowded momentum)`,
      `- MSFT +$2.7B | AMZN +$1.4B | AAPL +$1.6B | GOOG +$2.1B (AI infrastructure basket)`,
      `- TSLA top 5 conviction (+$1.6B) | ORCL +$1.5B (enterprise cloud + AI database)`,
      `- GLD +$4.2B with massive call overlay (largest single add — macro hedge signal)`,
      `- UNH +$2.8B (contrarian healthcare, buying regulatory pressure dip)`,
      `- MSTR +$2.2B notional options (Bitcoin proxy via liquid instrument)`,
      `- Reduced: AMD -$991M, NFLX -$1.2B, JPM -$801M, MCD -$690M (de-risking cyclicals)`,
      `- ~1,459 new positions, ~1,438 exits in Q4 alone. Relentless portfolio turnover.`,
      ``,
      `Analyze ${ticker} as Ken Griffin — through the lens of a multi-strategy institutional allocator.`,
      `Key questions: What's the risk/reward? Where's the edge? Crowded or contrarian? How would you size and hedge it?`,
      ``,
      `RESPOND IN THIS EXACT FORMAT:`,
      `EDGE: [ALPHA / BETA / CROWDED / CONTRARIAN]`,
      `CONVICTION: [1-10]/10`,
      `CITADEL SIZING: [CORE POSITION / TACTICAL / OPTIONS OVERLAY / PASS]`,
      `THESIS: [2-3 sentences — institutional, risk-aware, focused on edge and positioning]`,
      `RISK/HEDGE:`,
      `• [primary risk]`,
      `• [how you'd hedge it]`,
      ``,
      `Stay under 250 words. Channel Griffin: disciplined, quantitative, always thinking about the other side of the trade.`,
      ``,
      `FINANCIAL DATA:`,
      data,
    ].join('\n'),
  cio: (ticker: string, bull: string, bear: string, quant: string, macro: string, leopold: string, griffin: string) =>
    [
      `You are the CHIEF INVESTMENT OFFICER at a major hedge fund.`,
      `Six analysts have submitted their views on ${ticker}.\n`,
      `THE BULL:\n${bull}\n`,
      `THE BEAR:\n${bear}\n`,
      `THE QUANT:\n${quant}\n`,
      `THE MACRO STRATEGIST:\n${macro}\n`,
      `LEOPOLD (SITUATIONAL AWARENESS):\n${leopold}\n`,
      `KEN GRIFFIN (CITADEL):\n${griffin}\n`,
      `Synthesize all six views — including Leopold's AGI thesis and Griffin's risk/reward framework. Make a DECISIVE call.\n`,
      `RESPOND IN THIS EXACT FORMAT:`,
      `FINAL VERDICT: [STRONG BUY / BUY / HOLD / SELL / STRONG SELL]`,
      `CONVICTION: [1-10]/10`,
      `RATIONALE: [3-4 sentences synthesizing the key arguments]`,
      `RISKS:`,
      `• [risk 1]`,
      `• [risk 2]`,
      `POSITION SIZING: [Full / Half / Quarter]\n`,
      `Stay under 250 words.`,
    ].join('\n'),
  contrarian: (ticker: string, cio: string, bull: string, bear: string, quant: string, macro: string, leopold: string, griffin: string) =>
    [
      `You are THE CONTRARIAN — your job is to challenge consensus and find what everyone is missing.`,
      `The CIO has made this call on ${ticker}:\n${cio}\n`,
      `Original analyst views:`,
      `BULL: ${bull}`,
      `BEAR: ${bear}`,
      `QUANT: ${quant}`,
      `MACRO: ${macro}`,
      `LEOPOLD (SA): ${leopold}`,
      `KEN GRIFFIN (CITADEL): ${griffin}\n`,
      `Your mandate: Take the EXACT OPPOSITE position from the CIO. If they say BUY, you argue SELL. If SELL, you argue BUY. Be bold and provocative.\n`,
      `RESPOND IN THIS EXACT FORMAT:`,
      `CIO SAYS: [1-sentence summary of CIO's call]`,
      `CONTRARIAN VERDICT: [opposite of CIO]`,
      `CONVICTION: [1-10]/10`,
      `WHY THE CIO IS WRONG:`,
      `• [rebuttal 1]`,
      `• [rebuttal 2]`,
      `• [rebuttal 3]`,
      `WHAT EVERYONE IS MISSING:`,
      `• [blind spot 1]`,
      `• [blind spot 2]\n`,
      `Stay under 250 words.`,
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

function calcBlockH(doc: InstanceType<typeof PDFDocument>, w: number, content: string): number {
  doc.fontSize(8.5).font('Helvetica');
  return 26 + 20 + doc.heightOfString(content, { width: w - 20 });
}

function drawBlock(
  doc: InstanceType<typeof PDFDocument>,
  x: number, y: number, w: number,
  title: string, content: string, color: string
): number {
  const hH = 26, pad = 10, tW = w - 2 * pad;

  doc.fontSize(8.5).font('Helvetica');
  const tH = doc.heightOfString(content, { width: tW });
  const cH = tH + 2 * pad;
  const total = hH + cH;

  // Header bar
  doc.rect(x, y, w, hH).fill(color);
  doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold')
    .text(title, x, y + 7, { width: w, align: 'center' });

  // Content border
  doc.rect(x, y + hH, w, cH).strokeColor('#d1d5db').lineWidth(0.5).stroke();

  // Body text
  doc.fillColor('#1f2937').fontSize(8.5).font('Helvetica')
    .text(content, x + pad, y + hH + pad, { width: tW });

  return total;
}

function generatePDF(
  ticker: string, name: string, price: string, change: string,
  a: { bull: string; bear: string; quant: string; macro: string; leopold: string; griffin: string },
  cio: string, contrarian: string
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

    // ── Page 1: Header + 4 Standard Analysts ────────────
    doc.rect(0, 0, 612, 80).fill('#111827');
    doc.fillColor('#f9fafb').fontSize(22).font('Helvetica-Bold')
      .text('AI WAR ROOM', LX, 15, { width: FW });
    doc.fillColor('#9ca3af').fontSize(11).font('Helvetica')
      .text(
        `${name} (${ticker})  •  $${price} (${change}%)  •  ${new Date().toLocaleDateString()}`,
        LX, 48, { width: FW }
      );

    let y = 100;
    const bullH = drawBlock(doc, LX, y, CW, 'THE BULL', a.bull, '#16a34a');
    const bearH = drawBlock(doc, RX, y, CW, 'THE BEAR', a.bear, '#dc2626');
    y += Math.max(bullH, bearH) + 15;

    const qCalc = calcBlockH(doc, CW, a.quant);
    const mCalc = calcBlockH(doc, CW, a.macro);
    if (y + Math.max(qCalc, mCalc) > 752) { doc.addPage(); y = 40; }

    const quantH = drawBlock(doc, LX, y, CW, 'THE QUANT', a.quant, '#2563eb');
    const macroH = drawBlock(doc, RX, y, CW, 'THE MACRO', a.macro, '#9333ea');
    y += Math.max(quantH, macroH);

    // ── Page 2: Special Perspectives ────────────────────
    doc.addPage();

    doc.rect(0, 0, 612, 40).fill('#111827');
    doc.fillColor('#f9fafb').fontSize(14).font('Helvetica-Bold')
      .text('SPECIAL PERSPECTIVES', LX, 12, { width: FW, align: 'center' });

    y = 55;
    y += drawBlock(doc, LX, y, FW, 'LEOPOLD — SITUATIONAL AWARENESS', a.leopold, '#0891b2') + 15;

    const gCalc = calcBlockH(doc, FW, a.griffin);
    if (y + gCalc > 752) { doc.addPage(); y = 40; }

    y += drawBlock(doc, LX, y, FW, 'KEN GRIFFIN — CITADEL', a.griffin, '#475569');

    // ── Page 3: Investment Decision ─────────────────────
    doc.addPage();

    doc.rect(0, 0, 612, 40).fill('#111827');
    doc.fillColor('#f9fafb').fontSize(14).font('Helvetica-Bold')
      .text('INVESTMENT DECISION', LX, 12, { width: FW, align: 'center' });

    y = 55;
    y += drawBlock(doc, LX, y, FW, 'CIO CONSENSUS CALL', cio, '#d97706') + 12;

    doc.fillColor('#9ca3af').fontSize(14).font('Helvetica-Bold')
      .text('— VS —', LX, y, { width: FW, align: 'center' });
    y += 24;

    const contCalc = calcBlockH(doc, FW, contrarian);
    if (y + contCalc > 742) { doc.addPage(); y = 40; }

    y += drawBlock(doc, LX, y, FW, 'CONTRARIAN CALL', contrarian, '#ea580c') + 30;

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
  console.log(chalk.gray('\n  ⏳ Analysts deliberating (6 in parallel)...\n'));

  const [bull, bear, quant, macro, leopold, griffin] = await Promise.all([
    runClaude(prompts.bull(ticker, metrics)),
    runClaude(prompts.bear(ticker, metrics)),
    runClaude(prompts.quant(ticker, metrics)),
    runClaude(prompts.macro(ticker, metrics)),
    runClaude(prompts.leopold(ticker, metrics)),
    runClaude(prompts.griffin(ticker, metrics)),
  ]);

  showBox('🟢 THE BULL', bull, 'green');
  showBox('🔴 THE BEAR', bear, 'red');
  showBox('🔵 THE QUANT', quant, 'blue');
  showBox('🟣 THE MACRO', macro, 'magenta');
  showBox('🧠 LEOPOLD — SITUATIONAL AWARENESS', leopold, 'cyan', 'bold');
  showBox('🏛️ KEN GRIFFIN — CITADEL', griffin, 'white', 'bold');

  console.log(chalk.gray('\n  ⏳ CIO synthesizing (6 views)...\n'));
  const cio = await runClaude(prompts.cio(ticker, bull, bear, quant, macro, leopold, griffin));
  showBox('👔 CIO CONSENSUS CALL', cio, 'yellow', 'double');

  console.log(chalk.gray('\n  ⏳ Contrarian loading counter-thesis...\n'));
  const contrarian = await runClaude(prompts.contrarian(ticker, cio, bull, bear, quant, macro, leopold, griffin));
  showBox('🔥 CONTRARIAN CALL', contrarian, 'red', 'double');

  const pdfPath = await generatePDF(ticker, name, price, change, { bull, bear, quant, macro, leopold, griffin }, cio, contrarian);
  console.log(chalk.green(`\n  ✅ PDF saved: ${pdfPath}\n`));
}

main().catch((e: Error) => {
  console.error(chalk.red(`\n  Error: ${e.message}\n`));
  process.exit(1);
});
