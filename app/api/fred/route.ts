type Risk = "正常" | "偏热" | "警戒" | "高风险";

type Point = { date: string; value: number };

const FRED_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv";
const SUPPORTED_IDS = ["DFII10", "NFCI", "DTWEXBGS", "BAMLH0A0HYM2", "BAMLC0A0CM", "T10Y2Y", "ICSA"] as const;

function cleanCell(value: string) {
  return value.trim().replace(/^"|"$/g, "");
}

function parseSeriesCsv(csv: string, ids: readonly string[]): Record<string, Point[]> {
  const rows = csv.trim().split(/\r?\n/);
  const headers = (rows.shift() ?? "").split(",").map(cleanCell);
  const columnById = new Map(ids.map((id, index) => [id, headers.indexOf(id) >= 0 ? headers.indexOf(id) : ids.length === 1 ? index + 1 : -1]));
  const series = Object.fromEntries(ids.map((id) => [id, [] as Point[]])) as Record<string, Point[]>;

  for (const row of rows) {
    const cells = row.split(",").map(cleanCell);
    const date = cells[0];
    if (!date) continue;
    for (const id of ids) {
      const column = columnById.get(id) ?? -1;
      const raw = column >= 0 ? cells[column] : "";
      const value = raw && raw !== "." ? Number(raw) : Number.NaN;
      if (Number.isFinite(value)) series[id].push({ date, value });
    }
  }

  return series;
}

async function readCsvPayload(payload: ArrayBuffer): Promise<string[]> {
  const bytes = new Uint8Array(payload);
  const view = new DataView(payload);
  const decoder = new TextDecoder();

  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return [decoder.decode(bytes)];
  }

  const csvFiles: string[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if ((flags & 0x08) !== 0) throw new Error("Unsupported FRED ZIP data descriptor");

    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw new Error("Invalid FRED ZIP payload");

    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    if (name.toLowerCase().endsWith(".csv")) {
      const compressed = bytes.slice(dataStart, dataEnd);
      if (method === 0) {
        csvFiles.push(decoder.decode(compressed));
      } else if (method === 8) {
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        csvFiles.push(await new Response(stream).text());
      } else {
        throw new Error(`Unsupported FRED ZIP compression (${method})`);
      }
    }

    offset = dataEnd;
  }

  if (!csvFiles.length) throw new Error("FRED ZIP contains no CSV files");
  return csvFiles;
}

async function getSeries(ids: readonly string[]): Promise<Record<string, Point[]>> {
  let lastStatus = 0;
  let lastError = "FRED request failed";
  const idParam = ids.map(encodeURIComponent).join(",");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${FRED_BASE}?id=${idParam}&cosd=2025-01-01`, {
        cache: "no-store",
        headers: {
          Accept: "text/csv",
          "User-Agent": "US-Exit-Risk-Dashboard/1.0",
        },
        signal: AbortSignal.timeout(12_000),
      });
      lastStatus = response.status;
      if (response.ok) {
        const result = Object.fromEntries(ids.map((id) => [id, [] as Point[]])) as Record<string, Point[]>;
        for (const csv of await readCsvPayload(await response.arrayBuffer())) {
          const parsed = parseSeriesCsv(csv, ids);
          for (const id of ids) result[id].push(...parsed[id]);
        }
        return result;
      }
      lastError = `FRED returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "FRED request failed";
    }

    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
  }

  throw new Error(lastStatus ? `FRED request failed (${lastStatus})` : lastError);
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
    const requestedId = new URL(request.url).searchParams.get("series");
    if (requestedId && !SUPPORTED_IDS.includes(requestedId as (typeof SUPPORTED_IDS)[number])) {
      return Response.json({ error: "Unsupported FRED series" }, { status: 400 });
    }
    const ids = requestedId ? [requestedId] : [...SUPPORTED_IDS];
    const series = await getSeries(ids);
    const unavailable = ids.filter((id) => !series[id]?.length);

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
