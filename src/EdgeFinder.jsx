import { useState, useEffect, useCallback, useRef } from "react";

const BACKEND = "http://localhost:8000";
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

// ─── Math (unchanged — this is the core model) ────────────────────────────

function dtProb(d) { return 1 / d; }
function toAmerican(d) {
  if (d >= 2) return `+${Math.round((d - 1) * 100)}`;
  if (d <= 1) return "—";
  return `${Math.round(-100 / (d - 1))}`;
}
function fmtPct(n, d = 2) { return `${(n * 100).toFixed(d)}%`; }
function fmtDate(iso) {
  const diff = new Date(iso) - new Date();
  if (diff < 0) return "Live";
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
          bets.push({
            id: `${ev.id}-${bk.key}-${out.name}`, home: ev.home_team, away: ev.away_team,
            sport: SPORT_LABEL[ev.sport_key] || ev.sport_key, sportKey: ev.sport_key,
            outcome: out.name, book: bk.title, decimalOdds: out.price, americanOdds: toAmerican(out.price),
            impliedProb: ip, trueProb: tp, edge: tp - ip, ev: ev_val,
            time: ev.commence_time,
          });
        }
      }
    }
  }
  return bets.sort((a, b) => b.ev - a.ev).slice(0, 80);
}

// ─── Design tokens ─────────────────────────────────────────────────────────

const C = {
  ink: "#0A0D13", panel: "#12161F", panel2: "#1A2130", line: "#212938", lineHi: "#31405A",
  gold: "#E3B341", goldHi: "#F2C75C",
  teal: "#2FD4C4", tealHi: "#5CE6D8",
  rose: "#F2748C", slate: "#7C93C9", violet: "#A48CF0",
  fg: "#F1EFEA", fgDim: "#B6BECF", fgMute: "#7C869C",
};
// One warm, modern grotesk for everything; a mono face reserved for numeric
// readouts where digit alignment actually matters (odds, percentages).
const SANS = "'Manrope', sans-serif";
const NUM = "'IBM Plex Mono', monospace";

function Label({ children, style }) {
  return <div style={{ fontSize: 13, fontWeight: 600, color: C.fgDim, marginBottom: 10, ...style }}>{children}</div>;
}

// ─── Small shared pieces ─────────────────────────────────────────────────────

function CaliperMark({ size = 20, color = C.gold }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M4 5v6M20 5v6" stroke={color} strokeWidth="2" strokeLinecap="round" />
      <path d="M4 8h16" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray="1 3.4" />
      <path d="M8 15l-3 4M16 15l3 4" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Pill({ color, children, small }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", background: color + "16", color,
      border: `1px solid ${color}38`, borderRadius: 6, padding: small ? "2px 8px" : "3px 9px",
      fontSize: small ? 11 : 12, fontWeight: 600, lineHeight: 1.6, whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

function StatCard({ label, value, color, sub }) {
  return (
    <div style={{ flex: 1, minWidth: 130, background: C.panel, borderRadius: 12, padding: "16px 18px", border: `1px solid ${C.line}` }}>
      <div style={{ fontSize: 13, color: C.fgDim, fontWeight: 500, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color: color || C.fg, fontFamily: NUM, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: C.fgMute, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

function EmptyState({ icon, title, msg }) {
  return (
    <div style={{ textAlign: "center", padding: "56px 24px", color: C.fgDim, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14 }}>
      <div style={{ marginBottom: 16, display: "flex", justifyContent: "center", opacity: 0.6 }}>{icon}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: C.fg, marginBottom: 7 }}>{title}</div>
      <div style={{ fontSize: 14, lineHeight: 1.6, maxWidth: 340, margin: "0 auto", color: C.fgDim }}>{msg}</div>
    </div>
  );
}

// ─── Cards ────────────────────────────────────────────────────────────────

function ArbCard({ arb }) {
  const [open, setOpen] = useState(false);
  const col = arb.profitPct >= 3 ? C.goldHi : arb.profitPct >= 1 ? C.gold : C.slate;
  return (
    <div onClick={() => setOpen(!open)} style={{
      background: C.panel, border: `1px solid ${col}30`, borderRadius: 14, cursor: "pointer",
      overflow: "hidden", transition: "border-color 120ms ease",
    }}>
      <div style={{ padding: "18px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.fg, lineHeight: 1.3, marginBottom: 8 }}>
              {arb.home} <span style={{ color: C.fgMute, fontWeight: 500 }}>vs</span> {arb.away}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <Pill color={C.slate}>{arb.sport}</Pill>
              <Pill color={C.fgDim} small>{fmtDate(arb.time)}</Pill>
              <Pill color={C.fgMute} small>{arb.bookCount} books</Pill>
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 27, fontWeight: 700, color: col, fontFamily: NUM, lineHeight: 1 }}>+{arb.profitPct.toFixed(2)}%</div>
            <div style={{ fontSize: 12, color: C.fgMute, marginTop: 5 }}>profit</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          {arb.outcomes.map(o => (
            <div key={o.name} style={{ background: C.panel2, border: `1px solid ${C.lineHi}`, borderRadius: 10, padding: "9px 13px", flex: 1, minWidth: 110 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.fg, marginBottom: 3 }}>{o.name}</div>
              <div style={{ fontSize: 12, color: C.fgDim, marginBottom: 6 }}>{o.book}</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: col, fontFamily: NUM }}>{toAmerican(o.odds)}</div>
              <div style={{ fontSize: 11, color: C.fgMute, fontFamily: NUM }}>{fmtPct(o.prob)} implied</div>
            </div>
          ))}
        </div>
      </div>
      {open && (
        <div style={{ borderTop: `1px solid ${C.line}`, padding: "16px 20px", background: C.panel2 }}>
          <Label style={{ marginBottom: 12 }}>Optimal stakes · $100 total</Label>
          {arb.outcomes.map(s => (
            <div key={s.name} style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, fontSize: 14 }}>
              <span style={{ fontWeight: 600, color: C.fg }}>{s.name}</span>
              <div style={{ fontFamily: NUM, display: "flex", gap: 10 }}>
                <span style={{ color: C.fgDim }}>${s.stake}</span>
                <span style={{ color: C.fgMute }}>→</span>
                <span style={{ color: col }}>${s.payout}</span>
              </div>
            </div>
          ))}
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.line}`, fontSize: 13, fontFamily: NUM, color: C.fgDim }}>
            Sum: {fmtPct(arb.sumProbs)} · <span style={{ color: col }}>Margin: {fmtPct(1 - arb.sumProbs)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function EVCard({ bet }) {
  const col = bet.ev >= 0.06 ? C.tealHi : bet.ev >= 0.03 ? C.teal : C.slate;
  return (
    <div style={{ background: C.panel, borderLeft: `3px solid ${col}`, border: `1px solid ${col}26`, borderRadius: 12, padding: "16px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: col, marginBottom: 4 }}>{bet.outcome}</div>
          <div style={{ fontSize: 13, color: C.fgDim, marginBottom: 9, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bet.home} vs {bet.away}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <Pill color={C.violet}>{bet.book}</Pill>
            <Pill color={C.slate}>{bet.sport}</Pill>
            <Pill color={C.fgMute} small>{fmtDate(bet.time)}</Pill>
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: C.fg, fontFamily: NUM, lineHeight: 1 }}>{bet.americanOdds}</div>
          <div style={{ fontSize: 17, fontWeight: 700, color: col, fontFamily: NUM, marginTop: 4 }}>+{(bet.ev * 100).toFixed(2)}% EV</div>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.fgDim, marginBottom: 6, fontFamily: NUM }}>
          <span>Implied {fmtPct(bet.impliedProb)}</span>
          <span style={{ color: col }}>True {fmtPct(bet.trueProb)} (+{fmtPct(bet.edge)})</span>
        </div>
        <div style={{ position: "relative", height: 6, background: C.panel2, borderRadius: 3, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${bet.impliedProb * 100}%`, background: C.fgMute, borderRadius: 3 }} />
          <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${bet.trueProb * 100}%`, background: col, borderRadius: 3, opacity: 0.9 }} />
        </div>
      </div>
    </div>
  );
}

// ─── App shell ────────────────────────────────────────────────────────────

export default function EdgeFinder() {
  useEffect(() => {
    const el = document.createElement("link");
    el.rel = "stylesheet";
    el.href = "https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=IBM+Plex+Mono:wght@500;600;700&display=swap";
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
  const timerRef = useRef(null);
  const countdownRef = useRef(null);

  const fetchAll = useCallback(async () => {
    setRefreshing(true);
    setCountdown(REFRESH_INTERVAL / 1000);
    const allEvents = [];
    const log = [];
    try {
      await fetch(`${BACKEND}/refresh`, { method: "POST" }).catch(() => {});
      const res = await fetch(`${BACKEND}/events`);
      if (res.ok) {
        const data = await res.json();
        allEvents.push(...data.events);
        setRemaining(data.requests_remaining ?? null);
        for (const sport of SPORTS_CONFIG) {
          const count = data.events.filter(e => e.sport_key === sport.key).length;
          log.push({ sport: sport.label, key: sport.key, count, ok: true });
        }
      } else {
        log.push({ sport: "backend", key: "all", ok: false, msg: `HTTP ${res.status} from ${BACKEND}` });
      }
    } catch (e) {
      log.push({ sport: "backend", key: "all", ok: false, msg: `Could not reach backend at ${BACKEND}: ${e.message}` });
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

  const NAV = [
    { id: "arb", label: "Arbitrage", badge: arbs.length },
    { id: "ev", label: "+EV Bets", badge: evBets.length },
    { id: "status", label: "Status" },
  ];

  if (loading) return (
    <div style={{ fontFamily: SANS, background: C.ink, minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: C.fg }}>
      <style>{`@keyframes ef-p { 0%,100%{opacity:.15;transform:scale(.7)} 50%{opacity:1;transform:scale(1)} }`}</style>
      <CaliperMark size={30} />
      <div style={{ marginTop: 20, marginBottom: 16, display: "flex", gap: 7 }}>
        {[0, 0.15, 0.3].map((d, i) => <div key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: C.gold, animation: `ef-p 1.2s ease-in-out ${d}s infinite` }} />)}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: C.fg }}>Loading markets</div>
      <div style={{ fontSize: 14, color: C.fgDim, marginTop: 6 }}>Scanning {SPORTS_CONFIG.length} sports…</div>
    </div>
  );

  return (
    <div style={{ fontFamily: SANS, background: C.ink, minHeight: "100vh", color: C.fg, display: "flex" }}>
      <style>{`
        @keyframes ef-blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes ef-pulse { 0%,100%{opacity:.5;transform:scale(.9)} 50%{opacity:1;transform:scale(1.15)} }
        * { box-sizing: border-box; }
        body { margin: 0; }
        input[type=range] { accent-color: ${C.gold}; width: 100%; }
        ::-webkit-scrollbar { width: 8px; height: 8px; }
        ::-webkit-scrollbar-thumb { background: ${C.lineHi}; border-radius: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        .ef-navbtn:hover { background: ${C.panel2}; color: ${C.fg}; }
        .ef-sportpill:hover { border-color: ${C.lineHi}; }
      `}</style>

      {/* Sidebar */}
      <div style={{ width: 240, flexShrink: 0, background: C.panel, borderRight: `1px solid ${C.line}`, display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh" }}>
        <div style={{ padding: "22px 20px 18px", borderBottom: `1px solid ${C.line}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <CaliperMark size={22} />
            <div style={{ fontSize: 19, fontWeight: 800 }}>Edge<span style={{ color: C.gold }}>Finder</span></div>
          </div>
          <div style={{ fontSize: 13, color: C.fgDim, marginTop: 9 }}>
            {events.length} events · {refreshing
              ? <span style={{ color: C.gold, animation: "ef-blink 1s infinite" }}>refreshing…</span>
              : <>next in <span style={{ color: C.teal, fontFamily: NUM }}>{countdown}s</span></>}
          </div>
        </div>

        <div style={{ padding: "14px 12px", flex: 1, overflowY: "auto" }}>
          {NAV.map(t => {
            const isActive = tab === t.id;
            return (
              <button key={t.id} onClick={() => setTab(t.id)} className="ef-navbtn" style={{
                width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "10px 12px", marginBottom: 3, border: "none", borderRadius: 9, cursor: "pointer",
                background: isActive ? C.panel2 : "transparent", color: isActive ? C.fg : C.fgDim,
                fontSize: 15, fontWeight: 600, fontFamily: SANS, textAlign: "left",
                borderLeft: `2px solid ${isActive ? C.gold : "transparent"}`, transition: "background 100ms ease",
              }}>
                <span>{t.label}</span>
                {t.badge !== undefined && (
                  <span style={{
                    background: t.badge > 0 ? (isActive ? C.gold + "22" : C.panel2) : "transparent",
                    color: t.badge > 0 ? C.gold : C.fgMute, borderRadius: 10, padding: "2px 8px", fontSize: 12, fontFamily: NUM,
                  }}>{t.badge}</span>
                )}
              </button>
            );
          })}

          {availSports.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontSize: 13, color: C.fgDim, fontWeight: 600, padding: "0 12px 10px" }}>Filter by sport</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 12px" }}>
                {["all", ...availSports].map(sk => {
                  const isActive = sportFilter === sk;
                  const col = sk === "all" ? C.gold : C.slate;
                  return (
                    <button key={sk} onClick={() => setSportFilter(sk)} className="ef-sportpill" style={{
                      background: isActive ? col : "transparent", color: isActive ? C.ink : C.fgDim,
                      border: `1px solid ${isActive ? col : C.line}`, borderRadius: 7, padding: "5px 10px",
                      fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: SANS,
                    }}>{sk === "all" ? "All" : SPORT_LABEL[sk] || sk}</button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: "14px 16px", borderTop: `1px solid ${C.line}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: remaining !== null ? 6 : 0 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: refreshing ? C.gold : C.teal, animation: "ef-pulse 2s infinite" }} />
            <span style={{ fontSize: 13, color: C.fgDim }}>Backend connected</span>
          </div>
          {remaining !== null && <div style={{ fontSize: 12, color: remaining < 50 ? C.rose : C.fgMute, fontFamily: NUM }}>{remaining} requests left</div>}
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, minWidth: 0, padding: "28px 36px 60px", maxWidth: 1280 }}>
        {tab === "arb" && (
          <div>
            <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
              <StatCard label="Opportunities" value={arbs.length} color={arbs.length > 0 ? C.gold : C.fgDim} />
              <StatCard label="Best margin" value={arbs.length > 0 ? `+${arbs[0].profitPct.toFixed(2)}%` : "—"} color={C.goldHi} />
              <StatCard label="Average margin" value={arbs.length > 0 ? `+${(arbs.reduce((s, a) => s + a.profitPct, 0) / arbs.length).toFixed(2)}%` : "—"} color={C.slate} />
            </div>
            {arbs.length > 0
              ? <>
                  <div style={{ fontSize: 13, color: C.fgDim, marginBottom: 14 }}>Click a card for the stake calculator</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))", gap: 14 }}>
                    {arbs.map(a => <ArbCard key={a.id} arb={a} />)}
                  </div>
                </>
              : <EmptyState icon={<CaliperMark size={32} color={C.fgMute} />} title="No arbitrage detected" msg="Markets are efficient right now. Check the +EV tab for softer edges." />
            }
          </div>
        )}

        {tab === "ev" && (
          <div>
            <div style={{ background: C.panel, borderRadius: 14, padding: "18px 20px", marginBottom: 20, border: `1px solid ${C.line}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 9 }}>
                <span style={{ fontSize: 14, color: C.fgDim, fontWeight: 600 }}>Minimum EV threshold</span>
                <span style={{ fontSize: 15, fontWeight: 700, color: C.teal, fontFamily: NUM }}>+{(minEV * 100).toFixed(1)}%</span>
              </div>
              <input type="range" min="0" max="0.12" step="0.005" value={minEV} onChange={e => setMinEV(parseFloat(e.target.value))} />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.fgMute, marginTop: 5 }}>
                <span>0% — all</span><span>6%</span><span>12% — strict</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
              <StatCard label="Bets found" value={evBets.length} color={evBets.length > 0 ? C.teal : C.fgDim} />
              <StatCard label="Best EV" value={evBets.length > 0 ? `+${(evBets[0].ev * 100).toFixed(2)}%` : "—"} color={C.tealHi} />
              <StatCard label="Books represented" value={[...new Set(evBets.map(b => b.book))].length} color={C.violet} />
            </div>
            {evBets.length > 0
              ? <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))", gap: 14 }}>
                  {evBets.map(b => <EVCard key={b.id} bet={b} />)}
                </div>
              : <EmptyState icon={<CaliperMark size={32} color={C.fgMute} />} title="No +EV bets at this threshold" msg="Lower the threshold above, or wait for the next refresh cycle." />
            }
          </div>
        )}

        {tab === "status" && (
          <div style={{ maxWidth: 720 }}>
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: "20px", marginBottom: 16 }}>
              <Label>System</Label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                {[
                  { l: "Status", v: refreshing ? "Fetching" : "Live", c: refreshing ? C.gold : C.teal },
                  { l: "API quota", v: remaining !== null ? `${remaining} left` : "—", c: remaining !== null && remaining < 50 ? C.rose : C.fg },
                  { l: "Events", v: events.length, c: C.fg },
                  { l: "Sports", v: availSports.length, c: C.slate },
                  { l: "Arb opps", v: arbs.length, c: arbs.length > 0 ? C.gold : C.fgDim },
                  { l: "Updated", v: lastUpdated ? lastUpdated.toLocaleTimeString() : "—", c: C.fg },
                ].map(s => (
                  <div key={s.l} style={{ background: C.panel2, borderRadius: 10, padding: "12px 14px" }}>
                    <div style={{ fontSize: 12, color: C.fgMute }}>{s.l}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: s.c, fontFamily: NUM, marginTop: 5 }}>{s.v}</div>
                  </div>
                ))}
              </div>
            </div>
            {fetchLog.length > 0 && (
              <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 14, padding: "20px", marginBottom: 16 }}>
                <Label>Data sources</Label>
                {fetchLog.map(log => (
                  <div key={log.sport} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 0", borderBottom: `1px solid ${C.line}` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ width: 7, height: 7, borderRadius: "50%", background: log.ok ? C.teal : C.rose, flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, fontSize: 15 }}>{log.sport}</span>
                    </div>
                    <span style={{ fontSize: 13, color: log.ok ? C.fgDim : C.rose, fontFamily: NUM }}>{log.ok ? `${log.count} events` : (log.msg || "error").slice(0, 40)}</span>
                  </div>
                ))}
              </div>
            )}
            <button onClick={fetchAll} disabled={refreshing} style={{
              width: "100%", padding: "14px", background: refreshing ? C.panel2 : C.gold,
              color: refreshing ? C.fgDim : C.ink, border: "none", borderRadius: 10,
              fontSize: 15, fontWeight: 700, cursor: refreshing ? "not-allowed" : "pointer",
              fontFamily: SANS,
            }}>{refreshing ? "Scanning markets…" : "Refresh now"}</button>
            <div style={{ marginTop: 16, padding: "16px 18px", background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12 }}>
              <div style={{ fontSize: 13, color: C.fgDim, lineHeight: 2 }}>
                Arbitrage — sum of implied probabilities {"<"} 1 across best odds per book{"\n"}
                EV — (true probability / implied probability) − 1, vs. devigged consensus{"\n\n"}
                Educational purposes only. Verify before betting.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
