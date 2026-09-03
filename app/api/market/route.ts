type Risk = "正常" | "偏热" | "警戒" | "高风险";

type Bar = { date: string; close: number };
type LiveValue = { value: number; date: string; display: string; status: Risk; source: string };

const MASSIVE_API_BASE = "https://api.massive.com/v2/aggs/ticker";
const CBOE_STATS_URL = "https://www.cboe.com/data/mktstat.aspx";
const TICKERS = ["SPY", "RSP", "ARKK", "IPO", "MAGS"] as const;

function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

async function getBars(ticker: string, apiKey: string): Promise<Bar[]> {
  const end = new Date();
  const start = new Date(end.getTime() - 430 * 86_400_000);
  const url = new URL(`${MASSIVE_API_BASE}/${ticker}/range/1/day/${isoDate(start)}/${isoDate(end)}`);
  url.searchParams.set("adjusted", "true");
  url.searchParams.set("sort", "asc");
  url.searchParams.set("limit", "5000");

  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Massive ${ticker} returned ${response.status}`);

  const payload = await response.json() as { results?: Array<{ t: number; c: number }> };
  return (payload.results ?? []).flatMap(({ t, c }) =>
    Number.isFinite(t) && Number.isFinite(c) ? [{ date: isoDate(new Date(t)), close: c }] : [],
  );
}

function latest(bars: Bar[]) {
  const bar = bars.at(-1);
  if (!bar) throw new Error("Market series is empty");
  return bar;
}

function rsi(closes: number[], period = 14) {
  if (closes.length <= period) throw new Error("Insufficient RSI history");
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = closes[i] - closes[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let averageGain = gain / period;
  let averageLoss = loss / period;
  for (let i = period + 1; i < closes.length; i += 1) {
    const change = closes[i] - closes[i - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (averageLoss === 0) return 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

function ema(values: number[], period: number) {
  const multiplier = 2 / (period + 1);
  const result: number[] = [];
  for (const value of values) {
    result.push(result.length ? value * multiplier + result.at(-1)! * (1 - multiplier) : value);
  }
  return result;
}

function weeklyCloses(bars: Bar[]) {
  const weeks = new Map<string, number>();
  for (const bar of bars) {
    const date = new Date(`${bar.date}T12:00:00Z`);
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
    weeks.set(`${date.getUTCFullYear()}-${week}`, bar.close);
  }
  return [...weeks.values()];
}

function relativeReturn(asset: Bar[], benchmark: Bar[], lookback = 20) {
  const benchmarkByDate = new Map(benchmark.map((bar) => [bar.date, bar.close]));
  const aligned = asset.flatMap((bar) => {
    const base = benchmarkByDate.get(bar.date);
    return base ? [{ asset: bar.close, benchmark: base }] : [];
  });
  const current = aligned.at(-1);
  const previous = aligned.at(-(lookback + 1));
  if (!current || !previous) throw new Error("Insufficient relative-strength history");
  return ((current.asset / previous.asset) / (current.benchmark / previous.benchmark) - 1) * 100;
}

function ratioDistanceFromSma(asset: Bar[], benchmark: Bar[], period = 200) {
  const benchmarkByDate = new Map(benchmark.map((bar) => [bar.date, bar.close]));
  const ratios = asset.flatMap((bar) => {
    const base = benchmarkByDate.get(bar.date);
    return base ? [bar.close / base] : [];
  });
  const window = ratios.slice(-period);
  if (window.length < period) throw new Error("Insufficient ratio history");
  const average = window.reduce((sum, value) => sum + value, 0) / window.length;
  return (ratios.at(-1)! / average - 1) * 100;
}

function highRisk(value: number, levels: [number, number, number]): Risk {
  if (value >= levels[2]) return "高风险";
  if (value >= levels[1]) return "警戒";
  if (value >= levels[0]) return "偏热";
  return "正常";
}

function lowRisk(value: number, levels: [number, number, number]): Risk {
  if (value <= levels[2]) return "高风险";
  if (value <= levels[1]) return "警戒";
  if (value <= levels[0]) return "偏热";
  return "正常";
}

function signed(value: number, digits = 1) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

async function getCboeValues(): Promise<Record<string, LiveValue>> {
  const response = await fetch(CBOE_STATS_URL, {
    cache: "no-store",
    headers: { Accept: "text/html", "User-Agent": "US-Exit-Risk-Dashboard/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Cboe returned ${response.status}`);
  const html = (await response.text()).replaceAll('\\"', '"');
  const ratio = Number(html.match(/"name":"EQUITY PUT\/CALL RATIO","value":"([0-9.]+)"/)?.[1]);
  const volume = html.match(/"EQUITY OPTIONS":\[\{"name":"VOLUME","call":(\d+),"put":(\d+),"total":(\d+)/);
  const date = html.match(/"selectedDate":"(\d{4}-\d{2}-\d{2})"/)?.[1] ?? isoDate(new Date());
  if (!Number.isFinite(ratio) || !volume) throw new Error("Unable to parse Cboe statistics");

  const callShare = Number(volume[1]) / Number(volume[3]) * 100;
  return {
    "CBOE Put / Call": { value: ratio, date, display: ratio.toFixed(2), status: lowRisk(ratio, [0.75, 0.60, 0.45]), source: "CBOE" },
    "Call Option Share": { value: callShare, date, display: `${callShare.toFixed(1)}%`, status: highRisk(callShare, [55, 60, 65]), source: "CBOE" },
  };
}

export async function GET() {
  try {
    const apiKey = process.env.MASSIVE_API_KEY;
    if (!apiKey || !/^[A-Za-z0-9_-]{20,80}$/.test(apiKey)) {
      return Response.json({ error: "Massive API key is not configured" }, { status: 503 });
    }

    const results = await Promise.allSettled([
      ...TICKERS.map(async (ticker) => [ticker, await getBars(ticker, apiKey)] as const),
      getCboeValues(),
    ]);
    const series: Partial<Record<(typeof TICKERS)[number], Bar[]>> = {};
    for (let i = 0; i < TICKERS.length; i += 1) {
      const result = results[i];
      if (result.status === "fulfilled" && Array.isArray(result.value)) {
        const [ticker, bars] = result.value;
        series[ticker] = bars;
      }
    }

    const values: Record<string, LiveValue> = {};
    const spy = series.SPY;
    if (spy?.length) {
      const current = latest(spy);
      const closes = spy.map((bar) => bar.close);
      const currentRsi = rsi(closes);
      const sma200 = closes.slice(-200).reduce((sum, value) => sum + value, 0) / Math.min(200, closes.length);
      const distance = (current.close / sma200 - 1) * 100;
      const weekly = weeklyCloses(spy);
      const macdLine = ema(weekly, 12).map((value, index) => value - ema(weekly, 26)[index]);
      const signalLine = ema(macdLine, 9);
      const macd = macdLine.at(-1)!;
      const signal = signalLine.at(-1)!;
      const histogram = macd - signal;
      const macdStatus: Risk = macd < signal && macd < 0 ? "高风险" : macd < signal ? "警戒" : histogram < (macdLine.at(-2)! - signalLine.at(-2)!) ? "偏热" : "正常";

      values["S&P 500 RSI (14D)"] = { value: currentRsi, date: current.date, display: currentRsi.toFixed(1), status: highRisk(currentRsi, [65, 75, 85]), source: "MASSIVE" };
      values["Distance from 200DMA"] = { value: distance, date: current.date, display: signed(distance), status: highRisk(distance, [10, 15, 20]), source: "MASSIVE" };
      values["Weekly MACD"] = { value: histogram, date: current.date, display: macd < signal ? "周线死叉" : histogram < (macdLine.at(-2)! - signalLine.at(-2)!) ? "正值收窄" : "多头扩张", status: macdStatus, source: "MASSIVE" };

      const relativeInputs: Array<[key: string, bars: Bar[] | undefined, lookback: number, inverse: boolean]> = [
        ["Unprofitable Tech", series.ARKK, 20, false],
        ["IPO / Meme Activity", series.IPO, 20, false],
        ["Mega-cap Relative Strength", series.MAGS, 20, true],
      ];
      for (const [key, bars, lookback, inverse] of relativeInputs) {
        if (!bars?.length) continue;
        const value = relativeReturn(bars, spy, lookback);
        values[key] = {
          value,
          date: latest(bars).date,
          display: `${signed(value)} / ${lookback}D`,
          status: inverse ? lowRisk(value, [-1, -3, -5]) : highRisk(value, [5, 10, 15]),
          source: "MASSIVE",
        };
      }
      if (series.RSP?.length) {
        const breadth = ratioDistanceFromSma(series.RSP, spy);
        values["Equal / Cap Weight"] = { value: breadth, date: latest(series.RSP).date, display: `${signed(breadth)} vs 200DMA`, status: lowRisk(breadth, [0, -2, -5]), source: "MASSIVE" };
      }
    }

    const cboeResult = results.at(-1);
    if (cboeResult?.status === "fulfilled" && !Array.isArray(cboeResult.value)) Object.assign(values, cboeResult.value);
    if (!Object.keys(values).length) throw new Error("All market series are unavailable");

    const asOf = Object.values(values).map((item) => item.date).sort().at(-1);
    return Response.json(
      { source: "MASSIVE + CBOE", asOf, count: Object.keys(values).length, values },
      { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to load market data" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
