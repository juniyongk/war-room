#!/usr/bin/env npx tsx

import { spawn } from 'child_process';
import { createWriteStream, mkdirSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import boxen from 'boxen';
import PDFDocument from 'pdfkit';
import yahooFinance from 'yahoo-finance2';

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

// ── Data Fetching ───────────────────────────────────────────

async function fetchData(ticker: string) {
  const [quote, summary] = await Promise.all([
    yahooFinance.quote(ticker),
    yahooFinance.quoteSummary(ticker, {
      modules: ['financialData', 'defaultKeyStatistics', 'summaryProfile'] as any,
    }),
  ]);

  const fd: any = summary.financialData ?? {};
  const ks: any = summary.defaultKeyStatistics ?? {};
  const sp: any = summary.summaryProfile ?? {};

  const metrics = [
    `COMPANY: ${(quote as any).shortName ?? ticker} (${(quote as any).symbol})`,
    `SECTOR: ${sp.sector ?? 'N/A'} | INDUSTRY: ${sp.industry ?? 'N/A'}`,
    ``,
    `── PRICE & VALUATION ──`,
    `Price: $${fmt((quote as any).regularMarketPrice, 2)} | Change: ${fmt((quote as any).regularMarketChangePercent, 2)}%`,
    `Market Cap: $${fmtBig((quote as any).marketCap)}`,
    `P/E: ${fmt(ks.trailingPE)} | Fwd P/E: ${fmt(ks.forwardPE)}`,
    `P/B: ${fmt(ks.priceToBook)} | EV/EBITDA: ${fmt(ks.enterpriseToEbitda)}`,
    `52W: $${fmt((quote as any).fiftyTwoWeekLow, 2)} – $${fmt((quote as any).fiftyTwoWeekHigh, 2)}`,
    ``,
    `── FINANCIALS ──`,
    `Revenue: $${fmtBig(fd.totalRevenue)} | EBITDA: $${fmtBig(fd.ebitda)}`,
    `FCF: $${fmtBig(fd.freeCashflow)}`,
    `Rev Growth: ${fmtPct(fd.revenueGrowth)} | Earnings Growth: ${fmtPct(fd.earningsGrowth)}`,
    ``,
    `── MARGINS & RETURNS ──`,
    `Gross: ${fmtPct(fd.grossMargins)} | Op: ${fmtPct(fd.operatingMargins)} | Net: ${fmtPct(fd.profitMargins)}`,
    `ROE: ${fmtPct(fd.returnOnEquity)}`,
    ``,
    `── RISK & ANALYST ──`,
    `Beta: ${fmt(ks.beta, 2)} | D/E: ${fmt(fd.debtToEquity)}`,
    `Target: $${fmt(fd.targetMeanPrice, 2)} ($${fmt(fd.targetLowPrice, 2)}–$${fmt(fd.targetHighPrice, 2)})`,
    `Rec: ${fd.recommendationKey?.toUpperCase() ?? 'N/A'}`,
  ].join('\n');

  return { quote: quote as any, metrics };
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
  cio: (ticker: string, bull: string, bear: string, quant: string, macro: string) =>
    [
      `You are the CHIEF INVESTMENT OFFICER at a major hedge fund.`,
      `Four analysts have submitted their views on ${ticker}.\n`,
      `THE BULL:\n${bull}\n`,
      `THE BEAR:\n${bear}\n`,
      `THE QUANT:\n${quant}\n`,
      `THE MACRO STRATEGIST:\n${macro}\n`,
      `Synthesize these views. Acknowledge the strongest arguments from each side. Make a DECISIVE call.\n`,
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
  contrarian: (ticker: string, cio: string, bull: string, bear: string, quant: string, macro: string) =>
    [
      `You are THE CONTRARIAN — your job is to challenge consensus and find what everyone is missing.`,
      `The CIO has made this call on ${ticker}:\n${cio}\n`,
      `Original analyst views:`,
      `BULL: ${bull}`,
      `BEAR: ${bear}`,
      `QUANT: ${quant}`,
      `MACRO: ${macro}\n`,
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
  a: { bull: string; bear: string; quant: string; macro: string },
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

    // ── Page 1: Header ──────────────────────────────────
    doc.rect(0, 0, 612, 80).fill('#111827');
    doc.fillColor('#f9fafb').fontSize(22).font('Helvetica-Bold')
      .text('AI WAR ROOM', LX, 15, { width: FW });
    doc.fillColor('#9ca3af').fontSize(11).font('Helvetica')
      .text(
        `${name} (${ticker})  •  $${price} (${change}%)  •  ${new Date().toLocaleDateString()}`,
        LX, 48, { width: FW }
      );

    // ── Page 1: Row 1 — Bull + Bear ─────────────────────
    let y = 100;
    const bullH = drawBlock(doc, LX, y, CW, 'THE BULL', a.bull, '#16a34a');
    const bearH = drawBlock(doc, RX, y, CW, 'THE BEAR', a.bear, '#dc2626');
    y += Math.max(bullH, bearH) + 15;

    // Page break check for Row 2
    const qCalc = calcBlockH(doc, CW, a.quant);
    const mCalc = calcBlockH(doc, CW, a.macro);
    if (y + Math.max(qCalc, mCalc) > 752) { doc.addPage(); y = 40; }

    // ── Page 1: Row 2 — Quant + Macro ───────────────────
    const quantH = drawBlock(doc, LX, y, CW, 'THE QUANT', a.quant, '#2563eb');
    const macroH = drawBlock(doc, RX, y, CW, 'THE MACRO', a.macro, '#9333ea');
    y += Math.max(quantH, macroH);

    // ── Page 2: CIO + Contrarian ────────────────────────
    doc.addPage();
    y = 40;

    // Sub-header
    doc.rect(0, 0, 612, 50).fill('#111827');
    doc.fillColor('#f9fafb').fontSize(16).font('Helvetica-Bold')
      .text('INVESTMENT DECISION', LX, 16, { width: FW, align: 'center' });

    y = 70;
    y += drawBlock(doc, LX, y, FW, 'CIO CONSENSUS CALL', cio, '#d97706') + 12;

    // VS divider
    doc.fillColor('#9ca3af').fontSize(14).font('Helvetica-Bold')
      .text('— VS —', LX, y, { width: FW, align: 'center' });
    y += 24;

    y += drawBlock(doc, LX, y, FW, 'CONTRARIAN CALL', contrarian, '#ea580c') + 30;

    // Footer
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
  console.log(chalk.gray('\n  ⏳ Analysts deliberating (4 in parallel)...\n'));

  const [bull, bear, quant, macro] = await Promise.all([
    runClaude(prompts.bull(ticker, metrics)),
    runClaude(prompts.bear(ticker, metrics)),
    runClaude(prompts.quant(ticker, metrics)),
    runClaude(prompts.macro(ticker, metrics)),
  ]);

  showBox('🟢 THE BULL', bull, 'green');
  showBox('🔴 THE BEAR', bear, 'red');
  showBox('🔵 THE QUANT', quant, 'blue');
  showBox('🟣 THE MACRO', macro, 'magenta');

  console.log(chalk.gray('\n  ⏳ CIO synthesizing...\n'));
  const cio = await runClaude(prompts.cio(ticker, bull, bear, quant, macro));
  showBox('👔 CIO CONSENSUS CALL', cio, 'yellow', 'double');

  console.log(chalk.gray('\n  ⏳ Contrarian loading counter-thesis...\n'));
  const contrarian = await runClaude(prompts.contrarian(ticker, cio, bull, bear, quant, macro));
  showBox('🔥 CONTRARIAN CALL', contrarian, 'red', 'double');

  const pdfPath = await generatePDF(ticker, name, price, change, { bull, bear, quant, macro }, cio, contrarian);
  console.log(chalk.green(`\n  ✅ PDF saved: ${pdfPath}\n`));
}

main().catch((e: Error) => {
  console.error(chalk.red(`\n  Error: ${e.message}\n`));
  process.exit(1);
});
