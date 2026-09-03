"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity, BarChart3, BrainCircuit, Building2, ChevronDown,
  CircleDollarSign, Landmark, LineChart, Radio, ShieldAlert,
  Sparkles, TrendingDown, Users,
} from "lucide-react";

type Risk = "正常" | "偏热" | "警戒" | "高风险";
type Dimension = {
  id: string; name: string; en: string; weight: number; score: number;
  icon: typeof LineChart; insight: string;
};

type LiveItem = { value: number; date: string; display: string; status: Risk };
type FredPayload = { source: string; asOf: string; count: number; values: Record<string, LiveItem>; error?: string };

const dimensions: Dimension[] = [
  { id: "valuation", name: "估值", en: "VALUATION", weight: 12, score: 72, icon: CircleDollarSign, insight: "定价偏贵，但高估值不能单独触发离场。" },
  { id: "breadth", name: "市场广度", en: "BREADTH", weight: 14, score: 68, icon: BarChart3, insight: "指数强于多数个股，集中度需要重点观察。" },
  { id: "technical", name: "技术过热", en: "TECHNICAL", weight: 8, score: 60, icon: LineChart, insight: "趋势仍在，但价格偏离中长期均线。" },
  { id: "sentiment", name: "市场情绪", en: "SENTIMENT", weight: 8, score: 58, icon: Users, insight: "乐观情绪升温，尚未达到全面狂热。" },
  { id: "speculation", name: "投机行为", en: "SPECULATION", weight: 8, score: 65, icon: Sparkles, insight: "看涨期权与高 Beta 交易活跃。" },
  { id: "liquidity", name: "流动性 / 美联储", en: "LIQUIDITY", weight: 14, score: 55, icon: Landmark, insight: "金融条件不再继续宽松，进入观察区。" },
  { id: "credit", name: "信用与债券", en: "CREDIT", weight: 14, score: 48, icon: Building2, insight: "信用市场尚未发出明确破坏性信号。" },
  { id: "earnings", name: "盈利与经济", en: "EARNINGS", weight: 12, score: 52, icon: Activity, insight: "盈利仍支撑价格，但上修动能减弱。" },
  { id: "leaders", name: "领导者健康度", en: "LEADERS", weight: 10, score: 62, icon: BrainCircuit, insight: "大型科技仍领涨，内部表现开始分化。" },
];

const metrics = [
  ["valuation", "S&P 500 Forward P/E", "未来12个月市盈率", "23.1×", "> 24×", "警戒"],
  ["valuation", "Shiller CAPE", "周期调整市盈率", "36.8", "> 38", "偏热"],
  ["valuation", "Equity Risk Premium", "股权风险溢价", "2.7%", "< 2.5%", "偏热"],
  ["breadth", "% Above 200DMA", "200日均线上股票比例", "58%", "< 45%", "偏热"],
  ["breadth", "S&P 500 A/D Line", "腾落线背离", "轻微背离", "持续背离", "警戒"],
  ["breadth", "Equal / Cap Weight", "等权指数相对强弱", "走弱", "跌破年线", "警戒"],
  ["technical", "S&P 500 RSI (14D)", "相对强弱指标", "67", "> 75", "偏热"],
  ["technical", "Distance from 200DMA", "距200日均线偏离", "+11.4%", "> 15%", "偏热"],
  ["technical", "Weekly MACD", "周线趋势动能", "正值收窄", "死叉", "偏热"],
  ["sentiment", "AAII Bull–Bear", "散户多空差", "+24", "> +35", "偏热"],
  ["sentiment", "CBOE Put / Call", "看跌看涨比", "0.71", "< 0.60", "偏热"],
  ["sentiment", "VIX Term Structure", "波动率期限结构", "正价差", "倒挂", "正常"],
  ["speculation", "Call Option Share", "看涨期权成交占比", "偏高", "极端分位", "警戒"],
  ["speculation", "Unprofitable Tech", "亏损科技股相对表现", "+6.2%", "> +15%", "偏热"],
  ["speculation", "IPO / Meme Activity", "新股与热门股活跃度", "升温", "全面狂热", "偏热"],
  ["liquidity", "Real 10Y Yield", "10年期实际利率", "1.9%", "> 2.3%", "偏热"],
  ["liquidity", "Financial Conditions", "金融条件变化", "小幅收紧", "快速收紧", "偏热"],
  ["liquidity", "USD Broad Index", "美元广义指数20日变化", "待接入", "> +5%", "正常"],
  ["credit", "US HY OAS", "高收益债信用利差", "3.2%", "> 4.5%", "正常"],
  ["credit", "IG Credit Spread", "投资级信用利差", "0.91%", "> 1.3%", "正常"],
  ["credit", "10Y–2Y Yield Curve", "10年–2年收益率曲线", "待接入", "三个月快速走陡", "偏热"],
  ["earnings", "Forward EPS Revisions", "盈利预测上调/下调比", "1.04", "< 0.80", "正常"],
  ["earnings", "Net Margin Outlook", "利润率预期", "高位持平", "连续下修", "偏热"],
  ["earnings", "Initial Jobless Claims", "首次申领失业救济人数", "待接入", "> 350K", "正常"],
  ["leaders", "Mega-cap Relative Strength", "大型权重股相对强弱", "分化", "多数破位", "警戒"],
  ["leaders", "Mag 7 EPS Growth", "七大科技盈利增速", "放缓", "转负", "偏热"],
  ["leaders", "Leadership Participation", "领涨股参与度", "5 / 7", "≤ 3 / 7", "偏热"],
] as const;

const riskStyle: Record<Risk, string> = {
  正常: "risk-green", 偏热: "risk-lime", 警戒: "risk-amber", 高风险: "risk-red",
};

function scoreMeta(score: number) {
  if (score <= 25) return { label: "健康牛市", color: "#32d583", action: "正常持有" };
  if (score <= 40) return { label: "牛市偏热", color: "#a6d65c", action: "避免盲目加杠杆" };
  if (score <= 55) return { label: "明显过热", color: "#f5c451", action: "减少追高" };
  if (score <= 70) return { label: "高风险", color: "#ff8a3d", action: "分批降低高 Beta" };
  if (score <= 85) return { label: "牛市末期警报", color: "#f04438", action: "明显降低风险敞口" };
  return { label: "极端风险", color: "#d92d20", action: "防守优先" };
}

export default function Home() {
  const [selected, setSelected] = useState("all");
  const [expanded, setExpanded] = useState(true);
  const [fred, setFred] = useState<FredPayload | null>(null);
  const [dataState, setDataState] = useState<"loading" | "live" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    const ids = ["DFII10", "NFCI", "DTWEXBGS", "BAMLH0A0HYM2", "BAMLC0A0CM", "T10Y2Y", "ICSA"];
    const load = async () => {
      const combined: FredPayload = { source: "FRED", asOf: "", count: 0, values: {} };
      for (const id of ids) {
        try {
          const response = await fetch(`/api/fred?series=${id}`);
          const payload = await response.json() as FredPayload;
          if (!response.ok) continue;
          Object.assign(combined.values, payload.values);
          combined.count = Object.keys(combined.values).length;
          combined.asOf = [combined.asOf, payload.asOf].filter(Boolean).sort().at(-1) ?? "";
          if (!cancelled) {
            setFred({ ...combined, values: { ...combined.values } });
            setDataState("live");
          }
        } catch {
          // Keep already loaded series visible and continue with the next one.
        }
      }
      if (!cancelled && combined.count === 0) setDataState("error");
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const liveRiskPoints: Record<Risk, number> = { 正常: 20, 偏热: 45, 警戒: 68, 高风险: 88 };
  const displayDimensions = useMemo(() => dimensions.map((dimension) => {
    if (!fred || !["liquidity", "credit"].includes(dimension.id)) return dimension;
    const liveRows = metrics.filter((m) => m[0] === dimension.id).map((m) => fred.values[m[1]]).filter(Boolean);
    if (!liveRows.length) return dimension;
    return { ...dimension, score: Math.round(liveRows.reduce((sum, item) => sum + liveRiskPoints[item.status], 0) / liveRows.length) };
  }), [fred]);
  const score = Math.round(displayDimensions.reduce((sum, d) => sum + d.score * d.weight, 0) / 100);
  const meta = scoreMeta(score);
  const visibleMetrics = useMemo(
    () => metrics.filter((m) => selected === "all" || m[0] === selected),
    [selected],
  );
  const creditLiquidityTriggered = displayDimensions.filter((d) => ["liquidity", "credit"].includes(d.id)).some((d) => d.score >= 70);
  const confirmations = 1 + (creditLiquidityTriggered ? 1 : 0);
  const shouldExit = confirmations >= 2;
  const displayDate = fred?.asOf ? fred.asOf.replaceAll("-", ".") : "等待数据";

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><TrendingDown size={20} /></span>
          <div><strong>US EXIT RISK</strong><span>美股牛市逃顶仪表盘</span></div>
        </div>
        <div className={`live ${dataState}`}><Radio size={14} /><span>{dataState === "live" ? `${fred?.count}项真实数据 · FRED` : dataState === "loading" ? "正在连接FRED" : "FRED暂时不可用"}</span><time>{displayDate}</time></div>
      </header>

      <div className="shell">
        <section className="overview">
          <div className="gauge-card">
            <div className="eyebrow">综合风险指数</div>
            <div className="gauge-wrap" style={{ "--score": `${score * 3.6}deg`, "--risk": meta.color } as React.CSSProperties}>
              <div className="gauge-inner"><strong>{score}</strong><span>/ 100</span></div>
            </div>
            <div className="risk-label" style={{ color: meta.color }}>{meta.label}</div>
            <div className="action-chip">当前策略：{meta.action}</div>
          </div>

          <div className="signal-panel">
            <div className="panel-head">
              <div><span className="eyebrow">顶部确认机制</span><h1>现在是否需要“逃顶”？</h1></div>
              <span className={`decision ${shouldExit ? "yes" : "no"}`}>{shouldExit ? "是" : "否"}</span>
            </div>
            <p className="panel-copy">估值和情绪过热只负责预警。进入红色区，必须由三类破坏性信号中的至少两类共同确认。</p>
            <div className="confirm-grid">
              <div className="confirm active"><span>01</span><div><strong>市场内部结构</strong><small>广度与等权指数走弱</small></div><b>已触发</b></div>
              <div className={`confirm ${creditLiquidityTriggered ? "active" : ""}`}><span>02</span><div><strong>信用 / 流动性</strong><small>{creditLiquidityTriggered ? "真实数据已进入高风险区" : "FRED数据尚未形成联合警报"}</small></div><b>{creditLiquidityTriggered ? "已触发" : "未触发"}</b></div>
              <div className="confirm"><span>03</span><div><strong>盈利趋势</strong><small>预测尚未全面下修</small></div><b>未触发</b></div>
            </div>
            <div className="confirm-summary">
              <ShieldAlert size={18} /><span>确认条件命中 <strong>{confirmations} / 3</strong></span>
              <em>需 ≥ 2 才启动系统性减仓</em>
            </div>
          </div>
        </section>

        <section className="section-block">
          <div className="section-title">
            <div><span className="eyebrow">NINE DIMENSIONS</span><h2>九大风险维度</h2></div>
            <p>点击维度，筛选下方指标</p>
          </div>
          <div className="dimension-grid">
            {displayDimensions.map((d) => {
              const Icon = d.icon;
              const dMeta = scoreMeta(d.score);
              return (
                <button key={d.id} className={`dimension-card ${selected === d.id ? "selected" : ""}`} onClick={() => setSelected(selected === d.id ? "all" : d.id)}>
                  <div className="dimension-top"><span className="dim-icon"><Icon size={19} /></span><small>权重 {d.weight}%</small></div>
                  <div className="dim-name"><strong>{d.name}</strong><span>{d.en}</span></div>
                  <div className="score-row"><b>{d.score}</b><span style={{ color: dMeta.color }}>{dMeta.label}</span></div>
                  <div className="progress"><i style={{ width: `${d.score}%`, background: dMeta.color }} /></div>
                  <p>{d.insight}</p>
                </button>
              );
            })}
          </div>
        </section>

        <section className="section-block metrics-block">
          <button className="section-title metrics-toggle" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            <div><span className="eyebrow">CORE INDICATORS</span><h2>核心指标明细 <em>{visibleMetrics.length}</em></h2></div>
            <div className="filter-status">{selected === "all" ? "全部维度" : displayDimensions.find(d => d.id === selected)?.name}<ChevronDown className={expanded ? "rotated" : ""} /></div>
          </button>
          {expanded && (
            <div className="table-wrap"><table>
              <thead><tr><th>#</th><th>所属维度</th><th>指标</th><th>当前数值</th><th>高风险参考</th><th>状态</th></tr></thead>
              <tbody>{visibleMetrics.map((m, i) => {
                const dim = displayDimensions.find(d => d.id === m[0])!;
                const liveItem = fred?.values[m[1]];
                const currentValue = liveItem?.display ?? m[3];
                const currentRisk = liveItem?.status ?? m[5];
                return (
                  <tr key={`${m[0]}-${m[1]}`}>
                    <td>{String(i + 1).padStart(2, "0")}</td>
                    <td><span className="dim-pill">{dim.name}</span></td>
                    <td><strong>{m[1]}</strong><small>{m[2]}</small></td>
                    <td className="current">{currentValue}{liveItem && <small className="source-badge">FRED · {liveItem.date}</small>}</td><td>{m[4]}</td>
                    <td><span className={`risk-pill ${riskStyle[currentRisk as Risk]}`}><i />{currentRisk}</span></td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
        </section>

        <footer>
          <p>模型用途：识别牛市末期风险区间，不预测单日最高点。</p>
          <p>带有“FRED”标识的项目为自动更新真实数据；其余仍为模型示范值，不构成投资建议。</p>
        </footer>
      </div>
    </main>
  );
}
