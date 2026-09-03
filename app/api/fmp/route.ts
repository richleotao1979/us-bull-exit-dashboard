type Risk = "正常" | "偏热" | "警戒" | "高风险";
type Estimate = {
  symbol: string;
  date: string;
  revenueAvg: number;
  netIncomeAvg: number;
  epsAvg: number;
};

const FMP_API_BASE = "https://financialmodelingprep.com/stable/analyst-estimates";
const MAG_7 = ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA"] as const;

async function getEstimates(symbol: string, apiKey: string) {
  const url = new URL(FMP_API_BASE);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("period", "annual");
  url.searchParams.set("page", "0");
  url.searchParams.set("limit", "8");
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  if (!response.ok || !body.trimStart().startsWith("[")) {
    throw new Error(`FMP ${symbol} returned ${response.status}`);
  }
  const estimates = JSON.parse(body) as Estimate[];
  return estimates.filter((item) =>
    item.date && Number.isFinite(item.epsAvg) && Number.isFinite(item.revenueAvg) && Number.isFinite(item.netIncomeAvg),
  );
}

function growthRisk(value: number): Risk {
  if (value < 0) return "高风险";
  if (value < 5) return "警戒";
  if (value < 10) return "偏热";
  return "正常";
}

function marginRisk(basisPoints: number): Risk {
  if (basisPoints <= -100) return "高风险";
  if (basisPoints <= -50) return "警戒";
  if (basisPoints < 0) return "偏热";
  return "正常";
}

export async function GET() {
  try {
    const apiKey = process.env.FMP_API_KEY;
    if (!apiKey || !/^[A-Za-z0-9_-]{20,80}$/.test(apiKey)) {
      return Response.json({ error: "FMP API key is not configured" }, { status: 503 });
    }

    const today = new Date().toISOString().slice(0, 10);
    const results = await Promise.allSettled(MAG_7.map(async (symbol) => [symbol, await getEstimates(symbol, apiKey)] as const));
    const pairs: Array<{ symbol: string; current: Estimate; next: Estimate }> = [];
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const [symbol, estimates] = result.value;
      const future = estimates.filter((item) => item.date >= today).sort((a, b) => a.date.localeCompare(b.date));
      if (future.length >= 2) pairs.push({ symbol, current: future[0], next: future[1] });
    }
    if (pairs.length < 5) throw new Error("Insufficient Mag 7 analyst estimates");

    const epsGrowth = pairs.reduce((sum, item) => sum + (item.next.epsAvg / item.current.epsAvg - 1) * 100, 0) / pairs.length;
    const currentRevenue = pairs.reduce((sum, item) => sum + item.current.revenueAvg, 0);
    const currentIncome = pairs.reduce((sum, item) => sum + item.current.netIncomeAvg, 0);
    const nextRevenue = pairs.reduce((sum, item) => sum + item.next.revenueAvg, 0);
    const nextIncome = pairs.reduce((sum, item) => sum + item.next.netIncomeAvg, 0);
    const currentMargin = currentIncome / currentRevenue * 100;
    const nextMargin = nextIncome / nextRevenue * 100;
    const marginChange = (nextMargin - currentMargin) * 100;
    const coverage = `${pairs.length}/7`;

    return Response.json(
      {
        source: "FMP · MAG 7",
        asOf: today,
        count: 2,
        values: {
          "Mag 7 EPS Growth": {
            value: epsGrowth,
            date: today,
            display: `${epsGrowth >= 0 ? "+" : ""}${epsGrowth.toFixed(1)}% · ${coverage}`,
            status: growthRisk(epsGrowth),
          },
          "Net Margin Outlook": {
            value: marginChange,
            date: today,
            display: `${marginChange >= 0 ? "+" : ""}${Math.round(marginChange)} bp · ${coverage}`,
            status: marginRisk(marginChange),
          },
        },
      },
      { headers: { "Cache-Control": "public, max-age=21600, stale-while-revalidate=86400" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to load FMP data" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
