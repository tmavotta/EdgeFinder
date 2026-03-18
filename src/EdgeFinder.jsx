import { useState, useEffect, useCallback, useRef } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ScatterChart, Scatter, Cell
} from "recharts";

const USE_BACKEND = true;
const BACKEND = "http://localhost:8000";
const API_KEY = import.meta.env.VITE_ODDS_API_KEY;
const REFRESH_INTERVAL = 90000;

const SPORTS_CONFIG = [
  { key: "basketball_nba", label: "NBA" },
  { key: "icehockey_nhl", label: "NHL" },
  { key: "baseball_mlb", label: "MLB" },
  { key: "americanfootball_nfl", label: "NFL" },
  { key: "soccer_epl", label: "EPL" },
  { key: "soccer_uefa_champs_league", label: "UCL" },
  { key: "mma_mixed_martial_arts", label: "MMA" },
  { key: "basketball_ncaab", label: "NCAAB" },
];
const SPORT_LABEL = Object.fromEntries(SPORTS_CONFIG.map(s => [s.key, s.label]));

function dtProb(d) { return 1 / d; }
function toAmerican(d) {
  if (d >= 2) return `+${Math.round((d - 1) * 100)}`;
  return `${Math.round(-100 / (d - 1))}`;
}
function kellyFraction(trueProb, decimalOdds, fraction = 0.25) {
  const b = decimalOdds - 1, p = trueProb, q = 1 - p;
  return Math.max(0, ((b * p - q) / b) * fraction);
}
function fmtPct(n, d = 2) { return `${(n * 100).toFixed(d)}%`; }
function fmtDate(iso) {
  const diff = new Date(iso) - new Date();
  if (diff < 0) return "LIVE";
  if (diff < 3600000) return `${Math.round(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function computeArbs(events) {
  const arbs = [];
  for (const ev of events) {
    if (!ev.bookmakers?.length) continue;
    const best = {};
    for (const bk of ev.bookmakers) {
      const mkt = bk.markets?.find(m => m.key === "h2h");
      if (!mkt) continue;
      for (const out of mkt.outcomes) {
        const p = dtProb(out.price);
        if (!best[out.name] || p < best[out.name].prob)
          best[out.name] = { name: out.name, prob: p, odds: out.price, book: bk.title };
      }
    }
    const outs = Object.values(best);
    if (outs.length < 2) continue;
    const sp = outs.reduce((s, o) => s + o.prob, 0);
    if (sp < 0.999) {
      arbs.push({
        id: ev.id, home: ev.home_team, away: ev.away_team,
        sport: SPORT_LABEL[ev.sport_key] || ev.sport_key, sportKey: ev.sport_key,
        outcomes: outs.map(o => ({ ...o, stake: (100 * o.prob / sp).toFixed(2), payout: (100 / sp).toFixed(2) })),
        sumProbs: sp, profitPct: (1 / sp - 1) * 100, time: ev.commence_time, bookCount: ev.bookmakers.length,
      });
    }
  }
  return arbs.sort((a, b) => b.profitPct - a.profitPct);
}

function computeEV(events, minEV = 0.01) {
  const bets = [];
  for (const ev of events) {
    if (!ev.bookmakers?.length) continue;
    const buckets = {};
    for (const bk of ev.bookmakers) {
      const mkt = bk.markets?.find(m => m.key === "h2h");
      if (!mkt) continue;
      const raw = mkt.outcomes.map(o => dtProb(o.price));
      const tot = raw.reduce((a, b) => a + b, 0);
      mkt.outcomes.forEach((o, i) => { buckets[o.name] = buckets[o.name] || []; buckets[o.name].push(raw[i] / tot); });
    }
    const consensus = Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.reduce((a, b) => a + b) / v.length]));
    for (const bk of ev.bookmakers) {
      const mkt = bk.markets?.find(m => m.key === "h2h");
      if (!mkt) continue;
      for (const out of mkt.outcomes) {
        const ip = dtProb(out.price), tp = consensus[out.name];
        if (!tp) continue;
        const ev_val = tp / ip - 1;
        if (ev_val >= minEV) {
          const kelly = kellyFraction(tp, out.price);
          bets.push({
            id: `${ev.id}-${bk.key}-${out.name}`, home: ev.home_team, away: ev.away_team,
            sport: SPORT_LABEL[ev.sport_key] || ev.sport_key, sportKey: ev.sport_key,
            outcome: out.name, book: bk.title, decimalOdds: out.price, americanOdds: toAmerican(out.price),
            impliedProb: ip, trueProb: tp, edge: tp - ip, ev: ev_val,
            kellyPct: kelly * 100, time: ev.commence_time,
          });
        }
      }
    }
  }
  return bets.sort((a, b) => b.ev - a.ev).slice(0, 80);
}

const C = {
  bg: "#07090c", surface: "#0d1117", elevated: "#161b22", border: "#1c2128", borderHi: "#30363d",
  green: "#3fb950", greenBright: "#56d364", amber: "#d29922", amberBright: "#e3b341",
  red: "#f85149", blue: "#79c0ff", purple: "#d2a8ff", cyan: "#39d0d8",
  text: "#c9d1d9", textDim: "#8b949e", textMuted: "#484f58", white: "#f0f6fc",
};
const MONO = "'JetBrains Mono', monospace";
const DISPLAY = "'Barlow Condensed', sans-serif";

function Pill({ color, children, small }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", background: color + "18", color,
      border: `1px solid ${color}35`, borderRadius: 4, padding: small ? "0 5px" : "2px 7px",
      fontSize: small ? 10 : 11, fontWeight: 700, letterSpacing: "0.06em", fontFamily: MONO, lineHeight: 1.6, whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ flex: 1, background: C.surface, borderRadius: 8, padding: "10px 12px", border: `1px solid ${C.border}` }}>
      <div style={{ fontSize: 9, color: C.textMuted, letterSpacing: "0.14em", marginBottom: 5, fontFamily: MONO }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: color || C.white, fontFamily: MONO, lineHeight: 1 }}>{value}</div>
    </div>
  );
}

function KellyBar({ kellyPct, color }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.textDim, marginBottom: 3, fontFamily: MONO }}>
        <span>Kelly (25% fractional)</span>
        <span style={{ color }}>{kellyPct.toFixed(2)}% of bankroll</span>
      </div>
      <div style={{ height: 4, background: C.elevated, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.min((kellyPct / 15) * 100, 100)}%`, background: color, borderRadius: 3 }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.textMuted, marginTop: 3, fontFamily: MONO }}>
        <span>$100 → <span style={{ color }}>${kellyPct.toFixed(2)}</span></span>
        <span>$1k → <span style={{ color }}>${(kellyPct * 10).toFixed(2)}</span></span>
        <span>$5k → <span style={{ color }}>${(kellyPct * 50).toFixed(2)}</span></span>
      </div>
    </div>
  );
}

function ArbCard({ arb }) {
  const [open, setOpen] = useState(false);
  const col = arb.profitPct >= 3 ? C.greenBright : arb.profitPct >= 1 ? C.green : C.amber;
  return (
    <div onClick={() => setOpen(!open)} style={{ background: C.surface, border: `1px solid ${col}35`, borderRadius: 10, marginBottom: 10, cursor: "pointer", overflow: "hidden" }}>
      <div style={{ padding: "13px 14px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.white, lineHeight: 1.3, marginBottom: 5 }}>
              {arb.home} <span style={{ color: C.textMuted, fontWeight: 400 }}>vs</span> {arb.away}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              <Pill color={C.blue}>{arb.sport}</Pill>
              <Pill color={C.textDim} small>{fmtDate(arb.time)}</Pill>
              <Pill color={C.textMuted} small>{arb.bookCount} books</Pill>
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 24, fontWeight: 700, color: col, fontFamily: MONO, lineHeight: 1 }}>+{arb.profitPct.toFixed(2)}%</div>
            <div style={{ fontSize: 10, color: C.textMuted, marginTop: 3, letterSpacing: "0.1em" }}>PROFIT</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          {arb.outcomes.map(o => (
            <div key={o.name} style={{ background: C.elevated, border: `1px solid ${C.borderHi}`, borderRadius: 7, padding: "7px 11px", flex: 1, minWidth: 100 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.white, marginBottom: 2 }}>{o.name}</div>
              <div style={{ fontSize: 11, color: C.textDim, marginBottom: 4 }}>{o.book}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: col, fontFamily: MONO }}>{toAmerican(o.odds)}</div>
              <div style={{ fontSize: 10, color: C.textMuted, fontFamily: MONO }}>{fmtPct(o.prob)} imp</div>
            </div>
          ))}
        </div>
      </div>
      {open && (
        <div style={{ borderTop: `1px solid ${C.border}`, padding: "13px 14px", background: C.elevated }}>
          <div style={{ fontSize: 10, letterSpacing: "0.14em", color: C.textMuted, marginBottom: 10, fontFamily: MONO }}>OPTIMAL STAKES — $100 TOTAL</div>
          {arb.outcomes.map(s => (
            <div key={s.name} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 13 }}>
              <span style={{ fontWeight: 600, color: C.text }}>{s.name}</span>
              <div style={{ fontFamily: MONO, display: "flex", gap: 10 }}>
                <span style={{ color: C.amber }}>${s.stake}</span>
                <span style={{ color: C.textMuted }}>→</span>
                <span style={{ color: col }}>${s.payout}</span>
              </div>
            </div>
          ))}
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.border}`, fontSize: 11, fontFamily: MONO, color: C.textDim }}>
            Sum: {fmtPct(arb.sumProbs)} · <span style={{ color: col }}>Margin: {fmtPct(1 - arb.sumProbs)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function EVCard({ bet }) {
  const col = bet.ev >= 0.06 ? C.greenBright : bet.ev >= 0.03 ? C.green : C.amber;
  return (
    <div style={{ background: C.surface, borderLeft: `3px solid ${col}`, border: `1px solid ${col}28`, borderRadius: 8, marginBottom: 8, padding: "12px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: col, marginBottom: 2 }}>{bet.outcome}</div>
          <div style={{ fontSize: 12, color: C.textDim, marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bet.home} vs {bet.away}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            <Pill color={C.purple}>{bet.book}</Pill>
            <Pill color={C.blue}>{bet.sport}</Pill>
            <Pill color={C.textMuted} small>{fmtDate(bet.time)}</Pill>
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.white, fontFamily: MONO, lineHeight: 1 }}>{bet.americanOdds}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: col, fontFamily: MONO, marginTop: 2 }}>+{(bet.ev * 100).toFixed(2)}% EV</div>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.textDim, marginBottom: 4, fontFamily: MONO }}>
          <span>Implied {fmtPct(bet.impliedProb)}</span>
          <span style={{ color: col }}>True {fmtPct(bet.trueProb)} (+{fmtPct(bet.edge)})</span>
        </div>
        <div style={{ position: "relative", height: 5, background: C.elevated, borderRadius: 3, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${bet.impliedProb * 100}%`, background: C.textMuted, borderRadius: 3 }} />
          <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${bet.trueProb * 100}%`, background: col, borderRadius: 3, opacity: 0.85 }} />
        </div>
      </div>
      <KellyBar kellyPct={bet.kellyPct} color={col} />
    </div>
  );
}

function MarketRow({ event }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, cursor: "pointer" }} onClick={() => setOpen(!open)}>
      <div style={{ padding: "11px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.white, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {event.home_team} <span style={{ color: C.textMuted }}>vs</span> {event.away_team}
          </div>
          <div style={{ fontSize: 11, color: C.textDim, marginTop: 2 }}>
            {SPORT_LABEL[event.sport_key] || event.sport_key} · {event.bookmakers?.length || 0} books · {fmtDate(event.commence_time)}
          </div>
        </div>
        <span style={{ color: C.textMuted, fontSize: 14 }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && event.bookmakers?.length > 0 && (
        <div style={{ padding: "0 14px 14px" }}>
          {event.bookmakers.slice(0, 8).map(bk => {
            const mkt = bk.markets?.find(m => m.key === "h2h");
            if (!mkt) return null;
            return (
              <div key={bk.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px", background: C.elevated, borderRadius: 6, marginBottom: 5 }}>
                <span style={{ fontSize: 12, color: C.textDim, flex: "0 0 90px" }}>{bk.title}</span>
                <div style={{ display: "flex", gap: 12 }}>
                  {mkt.outcomes.map(o => (
                    <div key={o.name} style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 10, color: C.textMuted }}>{o.name.split(" ").pop()}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.white, fontFamily: MONO }}>{toAmerican(o.price)}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChartsTab({ events, arbs, evBets }) {
  const axisStyle = { fill: C.textDim, fontSize: 10, fontFamily: MONO };

  const evBuckets = Array.from({ length: 12 }, (_, i) => ({
    range: `${i}%`, count: evBets.filter(b => b.ev * 100 >= i && b.ev * 100 < i + 1).length,
  })).filter(b => b.count > 0);

  const bookMap = {};
  evBets.forEach(b => { bookMap[b.book] = (bookMap[b.book] || 0) + 1; });
  const bookData = Object.entries(bookMap)
    .map(([book, count]) => ({ book: book.replace("DraftKings", "DK").replace("FanDuel", "FD").replace("BetMGM", "MGM").replace("PointsBet", "PB"), count }))
    .sort((a, b) => b.count - a.count).slice(0, 8);

  const sportMap = {};
  events.forEach(e => { const k = SPORT_LABEL[e.sport_key] || e.sport_key; sportMap[k] = (sportMap[k] || 0) + 1; });
  const sportData = Object.entries(sportMap).map(([sport, count]) => ({ sport, count })).sort((a, b) => b.count - a.count);

  const scatterData = evBets.slice(0, 50).map(b => ({
    x: parseFloat((b.impliedProb * 100).toFixed(1)),
    y: parseFloat((b.trueProb * 100).toFixed(1)),
    ev: b.ev,
  }));

  const ChartBox = ({ title, children, height = 160 }) => (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px", marginBottom: 12 }}>
      <div style={{ fontSize: 11, letterSpacing: "0.1em", color: C.textMuted, marginBottom: 12, fontFamily: MONO }}>{title}</div>
      <ResponsiveContainer width="100%" height={height}>{children}</ResponsiveContainer>
    </div>
  );

  const NoData = () => <div style={{ color: C.textMuted, fontSize: 12, textAlign: "center", padding: 20, fontFamily: MONO }}>NO DATA YET</div>;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <StatCard label="EVENTS" value={events.length} color={C.blue} />
        <StatCard label="ARB OPPS" value={arbs.length} color={C.green} />
        <StatCard label="+EV BETS" value={evBets.length} color={C.amber} />
      </div>

      {evBuckets.length > 0 ? (
        <ChartBox title="EV DISTRIBUTION">
          <BarChart data={evBuckets} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis dataKey="range" tick={axisStyle} />
            <YAxis tick={axisStyle} />
            <Tooltip contentStyle={{ background: C.elevated, border: `1px solid ${C.borderHi}`, borderRadius: 6, fontFamily: MONO, fontSize: 11 }} />
            <Bar dataKey="count" name="bets" radius={[3, 3, 0, 0]}>
              {evBuckets.map((_, i) => <Cell key={i} fill={i < 3 ? C.amber : i < 6 ? C.green : C.greenBright} />)}
            </Bar>
          </BarChart>
        </ChartBox>
      ) : <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginBottom: 12 }}><div style={{ fontSize: 11, letterSpacing: "0.1em", color: C.textMuted, marginBottom: 12, fontFamily: MONO }}>EV DISTRIBUTION</div><NoData /></div>}

      {bookData.length > 0 ? (
        <ChartBox title="+EV OPPS BY BOOK" height={Math.max(bookData.length * 28, 100)}>
          <BarChart data={bookData} layout="vertical" margin={{ top: 0, right: 20, bottom: 0, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
            <XAxis type="number" tick={axisStyle} />
            <YAxis type="category" dataKey="book" tick={{ ...axisStyle, fontSize: 10 }} width={36} />
            <Tooltip contentStyle={{ background: C.elevated, border: `1px solid ${C.borderHi}`, borderRadius: 6, fontFamily: MONO, fontSize: 11 }} />
            <Bar dataKey="count" name="opportunities" fill={C.purple} radius={[0, 3, 3, 0]} />
          </BarChart>
        </ChartBox>
      ) : null}

      {scatterData.length > 0 ? (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px", marginBottom: 12 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.1em", color: C.textMuted, marginBottom: 4, fontFamily: MONO }}>IMPLIED vs TRUE PROBABILITY</div>
          <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 12, fontFamily: MONO }}>Points above diagonal = undervalued by book</div>
          <ResponsiveContainer width="100%" height={200}>
            <ScatterChart margin={{ top: 10, right: 10, bottom: 20, left: -10 }}>
              <CartesianGrid stroke={C.border} />
              <XAxis type="number" dataKey="x" name="Implied %" domain={[0, 100]} tick={axisStyle} label={{ value: "Implied %", fill: C.textMuted, fontSize: 10, position: "insideBottom", offset: -10 }} />
              <YAxis type="number" dataKey="y" name="True %" domain={[0, 100]} tick={axisStyle} label={{ value: "True %", fill: C.textMuted, fontSize: 10, angle: -90, position: "insideLeft", offset: 15 }} />
              <Tooltip contentStyle={{ background: C.elevated, border: `1px solid ${C.borderHi}`, borderRadius: 6, fontFamily: MONO, fontSize: 11 }}
                formatter={(val, name) => [val + "%", name]} />
              <Scatter data={scatterData} name="bets">
                {scatterData.map((d, i) => <Cell key={i} fill={d.ev > 0.05 ? C.greenBright : d.ev > 0.02 ? C.green : C.amber} />)}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      ) : null}

      {sportData.length > 0 ? (
        <ChartBox title="EVENTS BY SPORT" height={120}>
          <BarChart data={sportData} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis dataKey="sport" tick={axisStyle} />
            <YAxis tick={axisStyle} />
            <Tooltip contentStyle={{ background: C.elevated, border: `1px solid ${C.borderHi}`, borderRadius: 6, fontFamily: MONO, fontSize: 11 }} />
            <Bar dataKey="count" name="events" fill={C.blue} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ChartBox>
      ) : null}
    </div>
  );
}

export default function EdgeFinder() {
  useEffect(() => {
    const el = document.createElement("link");
    el.rel = "stylesheet";
    el.href = "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&display=swap";
    document.head.appendChild(el);
  }, []);

  const [tab, setTab] = useState("arb");
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [sportFilter, setSportFilter] = useState("all");
  const [minEV, setMinEV] = useState(0.01);
  const [remaining, setRemaining] = useState(null);
  const [fetchLog, setFetchLog] = useState([]);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL / 1000);
  const [marketSearch, setMarketSearch] = useState("");
  const timerRef = useRef(null);
  const countdownRef = useRef(null);

  const fetchAll = useCallback(async () => {
    setRefreshing(true);
    setCountdown(REFRESH_INTERVAL / 1000);
    const allEvents = [];
    const log = [];
    for (const sport of SPORTS_CONFIG) {
      try {
        const target = `https://api.the-odds-api.com/v4/sports/${sport.key}/odds/?apiKey=${API_KEY}&regions=us,eu,uk&markets=h2h&oddsFormat=decimal`;
        const res = await fetch(`https://corsproxy.io/?url=${encodeURIComponent(target)}`);
        const rem = res.headers.get("x-requests-remaining");
        if (rem !== null) setRemaining(parseInt(rem));
        if (res.ok) {
          const data = await res.json();
          allEvents.push(...data);
          log.push({ sport: sport.label, key: sport.key, count: data.length, ok: true });
        } else {
          const err = await res.json().catch(() => ({}));
          log.push({ sport: sport.label, key: sport.key, ok: false, msg: err.message || res.statusText });
        }
      } catch (e) {
        log.push({ sport: sport.label, key: sport.key, ok: false, msg: e.message });
      }
    }
    setEvents(allEvents);
    setFetchLog(log);
    setLastUpdated(new Date());
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    fetchAll();
    timerRef.current = setInterval(fetchAll, REFRESH_INTERVAL);
    return () => clearInterval(timerRef.current);
  }, [fetchAll]);

  useEffect(() => {
    countdownRef.current = setInterval(() => setCountdown(c => c <= 1 ? REFRESH_INTERVAL / 1000 : c - 1), 1000);
    return () => clearInterval(countdownRef.current);
  }, []);

  const filtered = sportFilter === "all" ? events : events.filter(e => e.sport_key === sportFilter);
  const arbs = computeArbs(filtered);
  const evBets = computeEV(filtered, minEV);
  const availSports = [...new Set(events.map(e => e.sport_key))].filter(k => SPORT_LABEL[k]);
  const filteredMarkets = filtered.filter(ev =>
    !marketSearch || ev.home_team?.toLowerCase().includes(marketSearch.toLowerCase()) || ev.away_team?.toLowerCase().includes(marketSearch.toLowerCase())
  );

  const TABS = [
    { id: "arb", label: "Arb", badge: arbs.length },
    { id: "ev", label: "+EV", badge: evBets.length },
    { id: "charts", label: "Charts" },
    { id: "markets", label: "Markets", badge: filtered.length },
    { id: "status", label: "Status" },
  ];

  if (loading) return (
    <div style={{ fontFamily: DISPLAY, background: C.bg, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: C.text }}>
      <style>{`@keyframes ef-p { 0%,100%{opacity:.15;transform:scale(.7)} 50%{opacity:1;transform:scale(1)} }`}</style>
      <div style={{ marginBottom: 20, display: "flex", gap: 6 }}>
        {[0, 0.15, 0.3].map((d, i) => <div key={i} style={{ width: 10, height: 10, borderRadius: "50%", background: C.green, animation: `ef-p 1.2s ease-in-out ${d}s infinite` }} />)}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: C.white, letterSpacing: "0.08em" }}>LOADING MARKETS</div>
      <div style={{ fontSize: 13, color: C.textDim, marginTop: 6 }}>Scanning {SPORTS_CONFIG.length} sports…</div>
    </div>
  );

  return (
    <div style={{ fontFamily: DISPLAY, background: C.bg, minHeight: "100vh", color: C.text, maxWidth: 520, margin: "0 auto" }}>
      <style>{`
        @keyframes ef-blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes ef-pulse { 0%,100%{opacity:.5;transform:scale(.9)} 50%{opacity:1;transform:scale(1.15)} }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input[type=range] { accent-color: ${C.green}; width: 100%; }
        ::-webkit-scrollbar { width: 3px; } ::-webkit-scrollbar-thumb { background: ${C.borderHi}; border-radius: 2px; }
      `}</style>

      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "12px 14px", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900, color: C.white, letterSpacing: "0.04em", lineHeight: 1 }}>⚡ EDGE<span style={{ color: C.green }}>FINDER</span></div>
            <div style={{ fontSize: 11, color: C.textDim, marginTop: 3, fontFamily: MONO }}>
              {events.length} events · {refreshing ? <span style={{ color: C.amber, animation: "ef-blink 1s infinite" }}>REFRESHING…</span> : <>refresh in <span style={{ color: C.green }}>{countdown}s</span></>}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, justifyContent: "flex-end" }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: refreshing ? C.amber : C.green, animation: "ef-pulse 2s infinite" }} />
              <span style={{ fontSize: 11, color: C.textDim, letterSpacing: "0.08em" }}>{USE_BACKEND ? "BACKEND" : "LIVE"}</span>
            </div>
            {remaining !== null && <div style={{ fontSize: 10, color: remaining < 50 ? C.red : C.textMuted, marginTop: 3, fontFamily: MONO }}>{remaining} req left</div>}
          </div>
        </div>
        {availSports.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginTop: 10, overflowX: "auto", paddingBottom: 2 }}>
            {["all", ...availSports].map(sk => {
              const isActive = sportFilter === sk;
              const col = sk === "all" ? C.green : C.blue;
              return (
                <button key={sk} onClick={() => setSportFilter(sk)} style={{
                  background: isActive ? col : C.elevated, color: isActive ? C.bg : C.textDim,
                  border: `1px solid ${isActive ? col : C.border}`, borderRadius: 5, padding: "4px 10px",
                  fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: DISPLAY, flexShrink: 0,
                }}>{sk === "all" ? "ALL" : SPORT_LABEL[sk] || sk}</button>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ display: "flex", background: C.surface, borderBottom: `1px solid ${C.border}`, overflowX: "auto" }}>
        {TABS.map(t => {
          const isActive = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              flex: 1, padding: "10px 4px", border: "none", borderBottom: `2px solid ${isActive ? C.green : "transparent"}`,
              background: "transparent", color: isActive ? C.white : C.textDim,
              fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: DISPLAY,
              letterSpacing: "0.05em", whiteSpace: "nowrap",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
            }}>
              {t.label}
              {t.badge !== undefined && (
                <span style={{ background: t.badge > 0 ? (isActive ? C.green : C.green + "25") : C.elevated, color: t.badge > 0 ? (isActive ? C.bg : C.green) : C.textMuted, borderRadius: 10, padding: "1px 5px", fontSize: 10, fontFamily: MONO }}>{t.badge}</span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ padding: "12px 12px 80px" }}>
        {tab === "arb" && (
          <div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <StatCard label="OPPS" value={arbs.length} color={arbs.length > 0 ? C.green : C.textDim} />
              <StatCard label="BEST" value={arbs.length > 0 ? `+${arbs[0].profitPct.toFixed(2)}%` : "—"} color={C.greenBright} />
              <StatCard label="AVG" value={arbs.length > 0 ? `+${(arbs.reduce((s, a) => s + a.profitPct, 0) / arbs.length).toFixed(2)}%` : "—"} color={C.amber} />
            </div>
            {arbs.length > 0
              ? <>{<div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10, fontFamily: MONO, letterSpacing: "0.06em" }}>TAP FOR STAKE CALCULATOR</div>}{arbs.map(a => <ArbCard key={a.id} arb={a} />)}</>
              : <div style={{ textAlign: "center", padding: "50px 24px", color: C.textDim }}>
                  <div style={{ fontSize: 36, marginBottom: 14, opacity: 0.5 }}>◎</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>No arbitrage detected</div>
                  <div style={{ fontSize: 13, lineHeight: 1.6 }}>Markets are efficient right now. Check +EV for softer edges.</div>
                </div>
            }
          </div>
        )}

        {tab === "ev" && (
          <div>
            <div style={{ background: C.surface, borderRadius: 8, padding: "12px 14px", marginBottom: 12, border: `1px solid ${C.border}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ fontSize: 11, color: C.textDim, letterSpacing: "0.1em", fontFamily: MONO }}>MIN EV THRESHOLD</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.green, fontFamily: MONO }}>+{(minEV * 100).toFixed(1)}%</span>
              </div>
              <input type="range" min="0" max="0.12" step="0.005" value={minEV} onChange={e => setMinEV(parseFloat(e.target.value))} />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.textMuted, marginTop: 3, fontFamily: MONO }}>
                <span>0% all</span><span>6%</span><span>12% strict</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <StatCard label="BETS FOUND" value={evBets.length} color={evBets.length > 0 ? C.green : C.textDim} />
              <StatCard label="BEST EV" value={evBets.length > 0 ? `+${(evBets[0].ev * 100).toFixed(2)}%` : "—"} color={C.greenBright} />
              <StatCard label="BOOKS" value={[...new Set(evBets.map(b => b.book))].length} color={C.purple} />
            </div>
            {evBets.length > 0 ? evBets.map(b => <EVCard key={b.id} bet={b} />) : (
              <div style={{ textAlign: "center", padding: "50px 24px", color: C.textDim }}>
                <div style={{ fontSize: 36, marginBottom: 14, opacity: 0.5 }}>◈</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 6 }}>No +EV bets at this threshold</div>
                <div style={{ fontSize: 13 }}>Lower the threshold or wait for refresh.</div>
              </div>
            )}
          </div>
        )}

        {tab === "charts" && <ChartsTab events={filtered} arbs={arbs} evBets={evBets} />}

        {tab === "markets" && (
          <div>
            <input type="text" placeholder="Search teams…" value={marketSearch} onChange={e => setMarketSearch(e.target.value)}
              style={{ width: "100%", padding: "9px 14px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, color: C.text, fontSize: 14, fontFamily: DISPLAY, outline: "none", marginBottom: 10 }} />
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
              {filteredMarkets.slice(0, 60).map(ev => <MarketRow key={ev.id} event={ev} />)}
            </div>
          </div>
        )}

        {tab === "status" && (
          <div>
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px", marginBottom: 10 }}>
              <div style={{ fontSize: 11, letterSpacing: "0.12em", color: C.textMuted, marginBottom: 10, fontFamily: MONO }}>SYSTEM</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {[
                  { l: "Status", v: refreshing ? "FETCHING" : "LIVE", c: refreshing ? C.amber : C.green },
                  { l: "API Quota", v: remaining !== null ? `${remaining} left` : "—", c: remaining !== null && remaining < 50 ? C.red : C.text },
                  { l: "Events", v: events.length, c: C.white },
                  { l: "Sports", v: availSports.length, c: C.blue },
                  { l: "Arb Opps", v: arbs.length, c: arbs.length > 0 ? C.green : C.textDim },
                  { l: "Updated", v: lastUpdated ? lastUpdated.toLocaleTimeString() : "—", c: C.text },
                ].map(s => (
                  <div key={s.l} style={{ background: C.elevated, borderRadius: 7, padding: "10px 12px" }}>
                    <div style={{ fontSize: 10, color: C.textMuted, letterSpacing: "0.1em", fontFamily: MONO }}>{s.l}</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: s.c, fontFamily: MONO, marginTop: 4 }}>{s.v}</div>
                  </div>
                ))}
              </div>
            </div>
            {fetchLog.length > 0 && (
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px", marginBottom: 10 }}>
                <div style={{ fontSize: 11, letterSpacing: "0.12em", color: C.textMuted, marginBottom: 10, fontFamily: MONO }}>DATA SOURCES</div>
                {fetchLog.map(log => (
                  <div key={log.sport} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 8, height: 8, borderRadius: "50%", background: log.ok ? C.green : C.red, flexShrink: 0 }} />
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{log.sport}</span>
                    </div>
                    <span style={{ fontSize: 12, color: log.ok ? C.textDim : C.red, fontFamily: MONO }}>{log.ok ? `${log.count} events` : (log.msg || "error").slice(0, 24)}</span>
                  </div>
                ))}
              </div>
            )}
            <button onClick={fetchAll} disabled={refreshing} style={{
              width: "100%", padding: "14px", background: refreshing ? C.elevated : C.green,
              color: refreshing ? C.textDim : C.bg, border: "none", borderRadius: 8,
              fontSize: 16, fontWeight: 900, cursor: refreshing ? "not-allowed" : "pointer",
              fontFamily: DISPLAY, letterSpacing: "0.1em",
            }}>{refreshing ? "SCANNING MARKETS…" : "⟳ REFRESH NOW"}</button>
            <div style={{ marginTop: 12, padding: "12px 14px", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8 }}>
              <div style={{ fontSize: 10, color: C.textMuted, fontFamily: MONO, lineHeight: 1.9 }}>
                KELLY CRITERION: Full Kelly = (bp−q)/b · 25% fractional applied to reduce variance{"\n"}
                ARBITRAGE: sumProbs {"<"} 1 across best odds per book{"\n"}
                EV: (trueProb / impliedProb) − 1 vs devigged consensus{"\n\n"}
                ⚠ Educational purposes only. Verify before betting.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
