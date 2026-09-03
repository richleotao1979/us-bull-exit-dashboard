type Risk = "正常" | "偏热" | "警戒" | "高风险";

type Point = { date: string; value: number };

const FRED_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=";

async function getSeries(id: string): Promise<Point[]> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${FRED_BASE}${encodeURIComponent(id)}&cosd=2025-01-01`, {
      headers: { "User-Agent": "US-Exit-Risk-Dashboard/1.0" },
    });
    lastStatus = response.status;
    if (response.ok) {
      const rows = (await response.text()).trim().split(/\r?\n/).slice(1);
      return rows.flatMap((row) => {
        const [date, raw] = row.split(",");
        const value = Number(raw);
        return date && Number.isFinite(value) ? [{ date, value }] : [];
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`FRED ${id}: ${lastStatus}`);
}

function classify(value: number, levels: [number, number, number]): Risk {
  if (value >= levels[2]) return "高风险";
  if (value >= levels[1]) return "警戒";
  if (value >= levels[0]) return "偏热";
  return "正常";
}

function latest(points: Point[]) {
  const point = points.at(-1);
  if (!point) throw new Error("FRED series is empty");
  return point;
}

export async function GET(request: Request) {
  try {
    const supportedIds = ["DFII10", "NFCI", "DTWEXBGS", "BAMLH0A0HYM2", "BAMLC0A0CM", "T10Y2Y", "ICSA"];
    const requestedId = new URL(request.url).searchParams.get("series");
    if (requestedId && !supportedIds.includes(requestedId)) {
      return Response.json({ error: "Unsupported FRED series" }, { status: 400 });
    }
    const ids = requestedId ? [requestedId] : supportedIds;
    const series: Record<string, Point[]> = {};
    const unavailable: string[] = [];

    // FRED's graph endpoint can reject bursts from a shared cloud address.
    // Pace requests and retry once; a final single-series failure still does
    // not blank the rest of the dashboard.
    for (const id of ids) {
      try {
        series[id] = await getSeries(id);
      } catch {
        unavailable.push(id);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const values: Record<string, { value: number; date: string; display: string; status: Risk }> = {};
    if (series.DFII10?.length) {
      const r = latest(series.DFII10);
      values["Real 10Y Yield"] = { value: r.value, date: r.date, display: `${r.value.toFixed(2)}%`, status: classify(r.value, [1.5, 2.0, 2.3]) };
    }
    if (series.NFCI?.length) {
      const n = latest(series.NFCI);
      values["Financial Conditions"] = { value: n.value, date: n.date, display: n.value.toFixed(2), status: classify(n.value, [-0.5, 0, 0.5]) };
    }
    if (series.DTWEXBGS?.length) {
      const d = latest(series.DTWEXBGS);
      const dollarBase = series.DTWEXBGS.at(-21)?.value ?? d.value;
      const dollarChange = ((d.value / dollarBase) - 1) * 100;
      values["USD Broad Index"] = { value: dollarChange, date: d.date, display: `${dollarChange >= 0 ? "+" : ""}${dollarChange.toFixed(1)}% / 20D`, status: classify(dollarChange, [1, 3, 5]) };
    }
    if (series.BAMLH0A0HYM2?.length) {
      const h = latest(series.BAMLH0A0HYM2);
      values["US HY OAS"] = { value: h.value, date: h.date, display: `${h.value.toFixed(2)}%`, status: classify(h.value, [3.5, 4.5, 5]) };
    }
    if (series.BAMLC0A0CM?.length) {
      const i = latest(series.BAMLC0A0CM);
      values["IG Credit Spread"] = { value: i.value, date: i.date, display: `${i.value.toFixed(2)}%`, status: classify(i.value, [1, 1.3, 1.5]) };
    }
    if (series.T10Y2Y?.length) {
      const c = latest(series.T10Y2Y);
      const curveBase = series.T10Y2Y.at(-61)?.value ?? c.value;
      const curveChange = c.value - curveBase;
      const curveRisk: Risk =
        c.value > 0 && curveChange >= 1 ? "高风险" :
        c.value > 0 && curveChange >= .6 ? "警戒" :
        c.value > 0 && curveChange >= .3 ? "偏热" : "正常";
      values["10Y–2Y Yield Curve"] = { value: curveChange, date: c.date, display: `${c.value.toFixed(2)}% · ${curveChange >= 0 ? "+" : ""}${curveChange.toFixed(2)} / 3M`, status: curveRisk };
    }
    if (series.ICSA?.length) {
      const j = latest(series.ICSA);
      values["Initial Jobless Claims"] = { value: j.value, date: j.date, display: `${Math.round(j.value / 1000)}K`, status: classify(j.value, [250000, 300000, 350000]) };
    }

    if (!Object.keys(values).length) throw new Error("All FRED series are unavailable");

    const asOf = Object.values(values).map((item) => item.date).sort().at(-1);
    return Response.json(
      { source: "FRED", asOf, count: Object.keys(values).length, values, unavailable },
      { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" } },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unable to load FRED data" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
