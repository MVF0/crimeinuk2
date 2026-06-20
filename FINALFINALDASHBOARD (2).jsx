import { useState, useMemo, useEffect } from "react";
 

 

//  KPT  happens in observed-stop space, pred factor applied at end
function runEngine(groups, totalBudget, floorFraction = 0.8, minStops = 10, scale = 1, effWindow = 12, budgetPeriod = 1) {
  
  if (!groups.length || totalBudget <= 0) return [];
 
  // drop pop=1 (MEP uses 1 as a placeholder for "basically zero census presence") and Unknown
  // display-only groups still appear in the UI (they just dont get quotas or disproportion stats)
  
  const engineGroups  = groups.filter(g => g.name !== "Unknown" && (g.population || 0) >= 2);
  const displayGroups = groups.filter(g => g.name !== "Unknown" && (g.population || 0) < 2 && (g.stops || 0) > 0); // show but dont allocate
 
  // basic area aggregates (these are the window counts )
  const totalPop   = engineGroups.reduce((s, g) => s + g.population, 0);
  const totalStops = engineGroups.reduce((s, g) => s + g.stops, 0);
  const totalHits  = engineGroups.reduce((s, g) => s + g.hits, 0);
  const areaAvgHR  = totalStops > 0 ? totalHits / totalStops : 0; // the KPT target (every group converges toward this)
 
  const popShare   = g => g.population / totalPop;
  const stopShare  = g => totalStops > 0 ? g.stops / totalStops : popShare(g);
  const hitRate    = g => g.stops > 0 ? g.hits / g.stops : 0;
  const popProp    = g => popShare(g) * totalBudget;
 
  // ROT flagging (both signals must fire simultaneously)
  // hasData checks we have enough stops  (minStops=10)
  // flagDec: group over-represented in stops vs population (decision rate signal A)
  // flagOut: hit rate below area average (outcome rate signal B)
  const rotFlagged = g => {
    const hasData  = g.stops >= minStops;
    const flagDec  = stopShare(g) > popShare(g);
    const flagOut  = hitRate(g) < areaAvgHR;
    return hasData && flagDec && flagOut; // BOTH needed
  };
 
  
  // All KPT arithmetic happens in OBSERVED-STOP space (window stops, not budget).
  //    At the end we multiply by predFactor = budgetPeriod/effWindow to get horizon volume, then apply the scaling cap.  This exactly replicates apply_kpt() in rot_kpt_json.ipynb.
 
  // pred factor converts observed window stops into budget horizon
  const predFactor = effWindow > 0 ? budgetPeriod / effWindow : 1;
 
  // Step 1: KPT reallocation (everything in observed stop space here)
  // start by setting adj = observed stops for every group, then we adjust the flagged ones
  const stopsAdj = {};
  engineGroups.forEach(g => { stopsAdj[g.name] = g.stops; });  // default = observed, will be overwritten if flagged
 
  const anyFlagged = engineGroups.some(g => rotFlagged(g));
  let totalPool = 0;   // freed stops (in observed space), used only for floor indicator
 
  if (anyFlagged && areaAvgHR > 0) {
    // KPT adjustment for flagged groups:
    //   fair = hits/area_avg 
    //   floor = phi * pop_share * total_stops  (safety net)
    //   adj = max(fair, floor) 
    // in most real cases fair is greater than floor
    engineGroups.forEach(g => {
      if (rotFlagged(g)) {
        const fair  = g.hits / areaAvgHR; // KPT fair count
        const floor = floorFraction * popShare(g) * totalStops; //minimum quota floor
        stopsAdj[g.name] = Math.max(fair, floor);
      }
    });
 
    
    //  redistribute to unflagged groups proportional to pop share
    const freedObs = engineGroups
      .filter(g => rotFlagged(g))
      .reduce((s, g) => s + (g.stops - stopsAdj[g.name]), 0);
    totalPool = Math.max(0, freedObs); // clamp to 0 just in case rounding gives tiny negatives
 
    if (freedObs > 0) {
      const unflagged    = engineGroups.filter(g => !rotFlagged(g));
      const unflaggedPop = unflagged.reduce((s, g) => s + popShare(g), 0);
      if (unflaggedPop > 0) {
        // each unflagged group gets a slice of the freed stops proportional to their pop share
        unflagged.forEach(g => {
          stopsAdj[g.name] += popShare(g) / unflaggedPop * freedObs;
        });
      }
    }
  }
 
  
  // multiply by predFactor to get predicted stops over the budget period
  const stopsAdjPred = {};
  engineGroups.forEach(g => { stopsAdjPred[g.name] = stopsAdj[g.name] * predFactor; });
 
  
  // scale = area_HR / national_HR (capped at 1) (areas below national benchmark get fewer searches)
 
  const stopsFinal = {};
  engineGroups.forEach(g => { stopsFinal[g.name] = stopsAdjPred[g.name] * scale; });
 
  //  Hamilton/largest-remainder rounding
  
  
  const floored    = {};
  const remainders = {};
  engineGroups.forEach(g => {
    floored[g.name]    = Math.floor(stopsFinal[g.name]);
    remainders[g.name] = stopsFinal[g.name] - floored[g.name];
  });
  const deficit = totalBudget - engineGroups.reduce((s, g) => s + floored[g.name], 0); // how many extra slots to hand out
  const byRem   = [...engineGroups].sort((a, b) => remainders[b.name] - remainders[a.name]); // biggest remainder first
  const finalQ  = { ...floored };
  byRem.forEach((g, i) => { if (i < deficit) finalQ[g.name] += 1; }); // give +1 to top-remainder groups
 
  
  const excessQuota = {};
  const rawQuota    = {};
  const afterFloor  = {};
  engineGroups.forEach(g => {
    excessQuota[g.name] = Math.max(0, g.stops - stopsAdj[g.name]) * predFactor * scale;
    rawQuota[g.name]    = stopsAdjPred[g.name];           // pre-cap KPT allocation
    afterFloor[g.name]  = stopsFinal[g.name];             // = rawQuota × scale
  });
 
  
  const engineResults = engineGroups.map(g => {
    const fq = finalQ[g.name];
    const ps = popShare(g);
    const ss = stopShare(g);
    const hr = hitRate(g);
    const pp = popProp(g);
    const flagDec = ss > ps;
    const flagOut = hr < areaAvgHR;
    const flagged = rotFlagged(g);
    const kptFairSS = areaAvgHR > 0 && totalStops > 0
      ? (g.hits / areaAvgHR) / totalStops : ps;
    return {
      name: g.name, population: g.population, stops: g.stops, hits: g.hits,
      popShare: ps, stopShare: ss, hitRate: hr, areaAvgHR,
      flagDecision: flagDec, flagOutcome: flagOut,
      hasData: g.stops >= minStops, rotFlagged: flagged,
      popProportional: pp, kptFairStopShare: kptFairSS,
      excessQuota: excessQuota[g.name], rawQuota: rawQuota[g.name],
      floorQuota: floorFraction * popShare(g) * totalStops * predFactor * scale,
      afterFloor: afterFloor[g.name],
      finalQuota: fq, perPersonRate: fq / g.population,
      disproportion: ps > 0 ? Math.min(50, anyFlagged ? (fq / totalBudget) / ps : ss / ps) : 0,
      floorEnforced: anyFlagged && flagged && (g.hits / (areaAvgHR || 1)) < (floorFraction * ps * totalStops),
      totalPool,
      displayOnly: false,
    };
  });
 
  // Append display-only groups — shown in tables but marked N/A for engine fields
  const displayResults = displayGroups.map(g => ({
    name: g.name, population: g.population, stops: g.stops, hits: g.hits,
    popShare: 0, stopShare: totalStops > 0 ? g.stops / totalStops : 0,
    hitRate: g.stops > 0 ? g.hits / g.stops : 0, areaAvgHR,
    flagDecision: false, flagOutcome: false, hasData: g.stops >= minStops,
    rotFlagged: false, popProportional: 0, kptFairStopShare: 0,
    excessQuota: 0, rawQuota: 0, floorQuota: 0, afterFloor: 0,
    finalQuota: 0, perPersonRate: 0, disproportion: null,
    floorEnforced: false, totalPool, displayOnly: true,
  }));
 
  return [...engineResults, ...displayResults];
}
 

 
const C = {
  bg:       "#0A0F1E",
  surface:  "#111827",
  card:     "#1A2235",
  border:   "#243046",
  accent:   "#00E5FF",
  gold:     "#FFD166",
  red:      "#FF4D4D",
  green:    "#39D98A",
  muted:    "#4A5568",
  text:     "#E8EDFB",
  sub:      "#8896B3",
  white:    "#FFFFFF",
};
 
const GROUP_PALETTE = [
  { solid: "#4F8EF7", glow: "rgba(79,142,247,0.25)" },
  { solid: "#FF6B6B", glow: "rgba(255,107,107,0.25)" },
  { solid: "#FFD166", glow: "rgba(255,209,102,0.25)" },
  { solid: "#39D98A", glow: "rgba(57,217,138,0.25)" },
  { solid: "#C77DFF", glow: "rgba(199,125,255,0.25)" },
  { solid: "#FF9F43", glow: "rgba(255,159,67,0.25)" },
];
 
//ui
const pct = (v, d = 2) => `${(v * 100).toFixed(d)}%`;
const fmt1 = v => v.toFixed(1);
 
function Tag({ children, color = C.accent }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
      textTransform: "uppercase", padding: "2px 8px",
      borderRadius: 4, background: color + "22", color, border: `1px solid ${color}44`,
    }}>{children}</span>
  );
}
 
function StatBox({ label, value, sub, color = C.accent, small = false }) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      borderRadius: 10, padding: small ? "10px 14px" : "14px 18px",
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <div style={{ fontSize: small ? 11 : 10, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: small ? 20 : 26, fontWeight: 800, color, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted }}>{sub}</div>}
    </div>
  );
}
 
function Bar({ value, max, color, height = 6 }) {
  const pctVal = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={{ height, background: C.border, borderRadius: height / 2, overflow: "hidden" }}>
      <div style={{
        height: "100%", width: `${pctVal}%`, background: color,
        borderRadius: height / 2, transition: "width 0.5s cubic-bezier(.4,0,.2,1)",
      }} />
    </div>
  );
}
 
function NumInput({ label, value, onChange, min = 0, step = 1, unit = "" }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 11, color: C.sub, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</label>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        background: "#0D1525", border: `1px solid ${C.border}`,
        borderRadius: 8, padding: "7px 12px",
      }}>
        <input
          type="number" value={value} min={min} step={step}
          onChange={e => onChange(Number(e.target.value))}
          style={{
            flex: 1, background: "none", border: "none", outline: "none",
            color: C.text, fontSize: 14, fontWeight: 700,
            fontFamily: "'DM Mono', monospace",
          }}
        />
        {unit && <span style={{ fontSize: 11, color: C.muted }}>{unit}</span>}
      </div>
    </div>
  );
}
 

// groiup editor
 
function GroupEditor({ group, index, onChange, onRemove }) {
  const pal = GROUP_PALETTE[index % GROUP_PALETTE.length];
  return (
    <div style={{
      background: C.card, borderRadius: 10, padding: "14px 16px",
      border: `1px solid ${C.border}`, borderLeft: `3px solid ${pal.solid}`,
      marginBottom: 10,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 6, background: pal.glow,
          border: `1.5px solid ${pal.solid}`, display: "flex", alignItems: "center",
          justifyContent: "center", flexShrink: 0,
        }}>
          <span style={{ color: pal.solid, fontSize: 12, fontWeight: 800 }}>{group.name[0]?.toUpperCase()}</span>
        </div>
        <input
          value={group.name}
          onChange={e => onChange({ ...group, name: e.target.value })}
          style={{
            flex: 1, background: "none", border: "none", outline: "none",
            color: C.text, fontSize: 14, fontWeight: 700,
          }}
          placeholder="Group name"
        />
        <button onClick={onRemove} style={{
          background: "none", border: "none", cursor: "pointer",
          color: C.muted, fontSize: 18, padding: "0 4px", lineHeight: 1,
        }}>×</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <NumInput label="Population" value={group.population} step={500}
          onChange={v => onChange({ ...group, population: Math.max(1, v) })} />
        <NumInput label="Stops (window)" value={group.stops} step={100}
          onChange={v => onChange({ ...group, stops: Math.max(0, v) })} />
        <NumInput label="Hits (finds)" value={group.hits} step={10}
          onChange={v => onChange({ ...group, hits: Math.max(0, Math.min(v, group.stops)) })} />
      </div>
    </div>
  );
}
 

//results
function ResultCard({ r, index, maxQuota, areaAvgHR }) {
  const pal = GROUP_PALETTE[index % GROUP_PALETTE.length];
  const dispColor = r.disproportion == null ? C.muted : r.disproportion > 1.3 ? C.red : r.disproportion < 0.85 ? C.gold : C.green;
  const freq = r.perPersonRate > 0 ? `1 in ${Math.round(1 / r.perPersonRate).toLocaleString()}` : "N/A";
 
  return (
    <div style={{
      background: C.card, borderRadius: 12, padding: "16px",
      border: `1px solid ${r.displayOnly ? C.muted + "55" : r.rotFlagged ? C.red + "55" : C.border}`,
      borderTop: `3px solid ${r.displayOnly ? C.muted : r.rotFlagged ? C.red : pal.solid}`,
      position: "relative", overflow: "hidden", opacity: r.displayOnly ? 0.85 : 1,
    }}>
      {r.displayOnly && (
        <div style={{ position: "absolute", top: 10, right: 12, fontSize: 10, fontWeight: 700, color: C.gold, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          ⚠ no population data
        </div>
      )}
      {r.rotFlagged && (
        <div style={{
          position: "absolute", top: 10, right: 12,
          fontSize: 10, fontWeight: 700, color: C.red,
          letterSpacing: "0.08em", textTransform: "uppercase",
        }}>⚑ ROT FLAGGED</div>
      )}
      {r.floorEnforced && !r.rotFlagged && (
        <div style={{
          position: "absolute", top: 10, right: 12,
          fontSize: 10, fontWeight: 700, color: C.gold,
          letterSpacing: "0.08em", textTransform: "uppercase",
        }}>▲ FLOOR</div>
      )}
 
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8, background: pal.glow,
          border: `1.5px solid ${pal.solid}`, display: "flex",
          alignItems: "center", justifyContent: "center",
        }}>
          <span style={{ color: pal.solid, fontSize: 14, fontWeight: 800 }}>{r.name[0]}</span>
        </div>
        <div>
          <div style={{ fontWeight: 800, fontSize: 15, color: C.text }}>{r.name}</div>
          <div style={{ fontSize: 11, color: C.sub }}>
            {r.displayOnly ? "pop. estimate unavailable" : (() => {
              const totalPop = results.reduce((s, x) => s + (x.population || 0), 0);
              const pct = totalPop > 0 ? (r.population / totalPop * 100).toFixed(1) : '?';
              return `${pct}% of area population`;
            })()}
          </div>
        </div>
      </div>
 
      {/* Main quota stat */}
      <div style={{
        background: "#0D1525", borderRadius: 8, padding: "12px 14px",
        marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div>
          <div style={{ fontSize: 10, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Monthly quota</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: r.displayOnly ? C.muted : pal.solid, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>
            {r.displayOnly ? "—" : r.finalQuota.toLocaleString()}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 10, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Disproportion</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: r.displayOnly ? C.muted : dispColor, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>
            {r.displayOnly ? "N/A" : (r.disproportion > 50 ? ">50×" : `${r.disproportion.toFixed(2)}×`)}
          </div>
        </div>
      </div>
 
      {r.displayOnly && (
        <div style={{ margin: "10px 0 4px", padding: "8px 10px", background: "#1a1a00", border: "1px solid #FFD16644", borderRadius: 6, fontSize: 11, color: C.gold, lineHeight: 1.5 }}>
          ⚠ Population data unavailable for this group — census proportion rounds to zero in this area, likely due to the Mixed/Other category mismatch between stop records and census data. Quota and disproportion cannot be computed reliably and are excluded from the engine.
        </div>
      )}
 
      <Bar value={r.displayOnly ? 0 : r.finalQuota} max={maxQuota} color={r.rotFlagged ? C.red : pal.solid} height={5} />
 
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
        <div>
          <div style={{ fontSize: 10, color: C.sub, marginBottom: 2 }}>Hit rate</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: r.hitRate < areaAvgHR ? C.red : C.green, fontFamily: "monospace" }}>
            {pct(r.hitRate)} {r.hitRate < areaAvgHR ? "▼" : "▲"}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: C.sub, marginBottom: 2 }}>Per-person rate</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, fontFamily: "monospace" }}>{freq}/mo</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: C.sub, marginBottom: 2 }}>Pop. share</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.sub, fontFamily: "monospace" }}>{pct(r.popShare)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: C.sub, marginBottom: 2 }}>Stop share</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: r.flagDecision ? C.red : C.sub, fontFamily: "monospace" }}>{pct(r.stopShare)}</div>
        </div>
      </div>
 
      {r.rotFlagged && (
        <div style={{
          marginTop: 12, background: C.red + "11", border: `1px solid ${C.red}33`,
          borderRadius: 6, padding: "8px 10px", fontSize: 11, color: C.red,
        }}>
          Excess quota removed: <strong style={{ fontFamily: "monospace" }}>{fmt1(r.excessQuota)}</strong> searches
          {r.floorEnforced && <span> → floor enforced at <strong style={{ fontFamily: "monospace" }}>{fmt1(r.floorQuota)}</strong></span>}
        </div>
      )}
    </div>
  );
}
 

//  rot table

 
function ROTTable({ results }) {
  const areaAvgHR = results[0]?.areaAvgHR ?? 0;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${C.border}` }}>
            {["Group", "Pop%", "Stop%", "Hit Rate", "Area Avg", "ΔHR", "Dec?", "Out?", "ROT"].map(h => (
              <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: C.sub, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", whiteSpace: "nowrap" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => {
            const pal = GROUP_PALETTE[i % GROUP_PALETTE.length];
            const delta = r.hitRate - areaAvgHR;
            return (
              <tr key={r.name} style={{ borderBottom: `1px solid ${C.border}22` }}>
                <td style={{ padding: "9px 12px", fontWeight: 700, color: pal.solid }}>{r.name}</td>
                <td style={{ padding: "9px 12px", fontFamily: "monospace", color: C.sub }}>{pct(r.popShare)}</td>
                <td style={{ padding: "9px 12px", fontFamily: "monospace", color: r.flagDecision ? C.red : C.sub }}>{pct(r.stopShare)}</td>
                <td style={{ padding: "9px 12px", fontFamily: "monospace", color: r.flagOutcome ? C.red : C.green }}>{pct(r.hitRate)}</td>
                <td style={{ padding: "9px 12px", fontFamily: "monospace", color: C.muted }}>{pct(areaAvgHR)}</td>
                <td style={{ padding: "9px 12px", fontFamily: "monospace", color: delta >= 0 ? C.green : C.red }}>
                  {delta >= 0 ? "+" : ""}{pct(delta)}
                </td>
                <td style={{ padding: "9px 12px" }}>{r.flagDecision ? <Tag color={C.red}>YES</Tag> : <Tag color={C.green}>no</Tag>}</td>
                <td style={{ padding: "9px 12px" }}>{r.flagOutcome ? <Tag color={C.red}>YES</Tag> : <Tag color={C.green}>no</Tag>}</td>
                <td style={{ padding: "9px 12px" }}>
                  {r.rotFlagged ? <Tag color={C.red}>⚑ FLAGGED</Tag> : <Tag color={C.green}>✓ ok</Tag>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
 
//kpt
 
function KPTTable({ results }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${C.border}` }}>
            {["Group", "Pop-Prop.", "Excess", "Raw Quota", "Floor", "After Floor", "Final", "Disp."].map(h => (
              <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: C.sub, fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.07em", whiteSpace: "nowrap" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => {
            const pal = GROUP_PALETTE[i % GROUP_PALETTE.length];
            const dispColor = r.disproportion == null ? C.muted : r.disproportion > 1.3 ? C.red : r.disproportion < 0.85 ? C.gold : C.green;
            return (
              <tr key={r.name} style={{ borderBottom: `1px solid ${C.border}22` }}>
                <td style={{ padding: "9px 12px", fontWeight: 700, color: pal.solid }}>{r.name}</td>
                <td style={{ padding: "9px 12px", fontFamily: "monospace", color: C.sub }}>{fmt1(r.popProportional)}</td>
                <td style={{ padding: "9px 12px", fontFamily: "monospace", color: r.excessQuota > 0 ? C.red : C.muted }}>{fmt1(r.excessQuota)}</td>
                <td style={{ padding: "9px 12px", fontFamily: "monospace", color: C.text }}>{fmt1(r.rawQuota)}</td>
                <td style={{ padding: "9px 12px", fontFamily: "monospace", color: C.muted }}>{fmt1(r.floorQuota)}</td>
                <td style={{ padding: "9px 12px", fontFamily: "monospace", color: r.floorEnforced ? C.gold : C.muted }}>
                  {fmt1(r.afterFloor)} {r.floorEnforced ? "▲" : ""}
                </td>
                <td style={{ padding: "9px 12px", fontFamily: "monospace", fontWeight: 700, color: C.text }}>{r.finalQuota.toLocaleString()}</td>
                <td style={{ padding: "9px 12px", fontFamily: "monospace", fontWeight: 700, color: dispColor }}>{r.disproportion == null ? "N/A" : (r.disproportion > 50 ? ">50×" : `${r.disproportion.toFixed(2)}×`)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
 

//  dashboard
 
 
const fGBP = v => v >= 1e6 ? `£${(v / 1e6).toFixed(2)}m` : v >= 1e3 ? `£${(v / 1e3).toFixed(1)}k` : `£${v.toFixed(0)}`;
 
function Card({ children, accent, style = {} }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${accent ? accent + "44" : C.border}`, borderRadius: 10, padding: "14px 16px", ...style }}>
      {children}
    </div>
  );
}
 

function HorizChart({ title, titleColor, subtitle, rows, note }) {
  const safeRows = (rows || []).filter(Boolean);
  const maxVal = Math.max(...safeRows.flatMap(r => [r.a || 0, r.b || 0]), 0.001);
  return (
    <div style={{ background: "#0F1829", border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px", height: "100%", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <div style={{ background: titleColor + "22", border: `1px solid ${titleColor}44`, borderRadius: 5, padding: "1px 7px", fontSize: 8, fontWeight: 700, color: titleColor, textTransform: "uppercase", letterSpacing: "0.1em", flexShrink: 0 }}>{title}</div>
      </div>
      <div style={{ fontSize: 13, fontWeight: 800, color: C.text, marginBottom: 2, lineHeight: 1.2 }}>{subtitle}</div>
      {note && <div style={{ fontSize: 10, color: C.sub, marginBottom: 10, lineHeight: 1.4 }}>{note}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {safeRows.map((row, i) => {
          const pal = GROUP_PALETTE[i % GROUP_PALETTE.length];
          const aW = Math.min(96, (row.a / maxVal) * 96);
          const bW = Math.min(96, (row.b / maxVal) * 96);
          const tagColor = row.tag === "over" ? C.red : row.tag === "under" ? C.gold : row.tag === "flag" ? C.red : null;
          return (
            <div key={row.group} style={{ paddingBottom: 10, marginBottom: 10, borderBottom: i < safeRows.length - 1 ? `1px solid ${C.border}22` : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                <span style={{ fontWeight: 800, color: pal.solid, fontSize: 12 }}>{row.group}</span>
                {row.badge && <span style={{ fontSize: 10, fontWeight: 700, color: tagColor || C.sub }}>{row.badge}</span>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                <span style={{ fontSize: 9, color: C.muted, width: 46, textAlign: "right", flexShrink: 0, letterSpacing: "0.03em" }}>{row.labelA}</span>
                <div style={{ flex: 1, background: "#1A2640", borderRadius: 2, height: 10, overflow: "hidden", position: "relative" }}>
                  <div style={{ position: "absolute", top: 0, left: 0, width: `${aW}%`, height: "100%", background: pal.solid, opacity: 0.32, borderRadius: 2, transition: "width 0.5s" }} />
                </div>
                <span style={{ fontSize: 10, fontWeight: 600, color: C.sub, width: 46, textAlign: "right", flexShrink: 0 }}>{row.valA}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 9, color: C.muted, width: 46, textAlign: "right", flexShrink: 0, letterSpacing: "0.03em" }}>{row.labelB}</span>
                <div style={{ flex: 1, background: "#1A2640", borderRadius: 2, height: 10, overflow: "hidden", position: "relative" }}>
                  <div style={{ position: "absolute", top: 0, left: 0, width: `${bW}%`, height: "100%", background: row.bColor || pal.solid, opacity: 0.9, borderRadius: 2, transition: "width 0.5s" }} />
                </div>
                <span style={{ fontSize: 10, fontWeight: 700, color: row.bColor || pal.solid, width: 46, textAlign: "right", flexShrink: 0 }}>{row.valB}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
 
export default function Dashboard() {
  const [groups,        setGroups]        = useState([]);
  const [floorFrac,     setFloorFrac]     = useState(0.8);
  const [windowMonths,  setWindowMonths]  = useState(12);
  // budgetPeriod: 1 = monthly, 6 = 6-monthly, 12 = annual
  const [budgetPeriod,  setBudgetPeriod]  = useState(12);
  const minStops = 10;  // fixed — matches notebook MIN_STOPS
  const [activeTab,     setActiveTab]     = useState("results");
  const [nextId,        setNextId]        = useState(6);
 
  // ── navigation ──
  const [page,    setPage]    = useState("input");      // "input" | "results"
  const [layer,   setLayer]   = useState("overview");   // "overview" | "technical"
  const [techTab, setTechTab] = useState("rot");        // "rot" | "kpt"
 
  // Loaded from public/combined_dashboard_data.json
  const [allUnits,      setAllUnits]      = useState({ administrative: [], pfa: [], nationwide: [] });
  const [geoLevel,      setGeoLevel]      = useState("administrative");
  const [selectedUnit,  setSelectedUnit]  = useState("");
  const [dataError,     setDataError]     = useState("");
  const [uploadedData,  setUploadedData]  = useState(null);
 
  const makeNationwide = (adminUnits = [], pfaUnits = []) => {
    const sourceUnits = adminUnits.length ? adminUnits : pfaUnits;
    const byGroup = {};
 
    sourceUnits.forEach(unit => {
      (unit.groups || []).forEach(g => {
        const name = g.name || "Unknown";
        if (!byGroup[name]) {
          byGroup[name] = { id: Object.keys(byGroup).length + 1, name, population: 0, stops: 0, hits: 0, s: [], h: [] };
        }
        byGroup[name].population += Number(g.population || 0);
        byGroup[name].stops += Number(g.stops || 0);
        byGroup[name].hits += Number(g.hits || 0);
        // Accumulate per-month arrays so the nationwide rollup keeps a monthly dimension.
        if (Array.isArray(g.s)) {
          g.s.forEach((v, i) => { byGroup[name].s[i] = (byGroup[name].s[i] || 0) + (v || 0); });
        }
        if (Array.isArray(g.h)) {
          g.h.forEach((v, i) => { byGroup[name].h[i] = (byGroup[name].h[i] || 0) + (v || 0); });
        }
        // Accumulate periods[] for files using periods format
        if (Array.isArray(g.periods)) {
          if (!byGroup[name].periods) byGroup[name].periods = [];
          g.periods.forEach(p => {
            const existing = byGroup[name].periods.find(x => x.months === p.months);
            if (existing) { existing.stops += p.stops || 0; existing.hits += p.hits || 0; }
            else byGroup[name].periods.push({ months: p.months, stops: p.stops || 0, hits: p.hits || 0 });
          });
        }
      });
    });
 
    const groups = Object.values(byGroup);
    return [{
      code: "NATIONWIDE",
      name: "Nationwide",
      groups,
      totalStops: groups.reduce((s, g) => s + g.stops, 0),
      totalHits: groups.reduce((s, g) => s + g.hits, 0),
    }];
  };
 
  const selectFirstUnit = (level, data) => {
    const units = data[level] || [];
    if (units.length > 0) {
      setSelectedUnit(units[0].code);
      setGroups((units[0].groups || []).filter(g => g.name !== "Unknown" && ((g.population || 0) >= 100 || (g.stops || 0) > 0)));
    } else {
      setSelectedUnit("");
      setGroups([]);
    }
  };
 
    useEffect(() => {
    try {
      if (!uploadedData) {
        // No data uploaded yet — show empty state
        setAllUnits({ administrative: [], pfa: [], nationwide: [] });
        setGroups([]);
        return;
      }
      const administrative = uploadedData.administrative || [];
      const pfa = uploadedData.pfa || [];
      const nationwide = uploadedData.nationwide?.length
        ? uploadedData.nationwide
        : makeNationwide(administrative, pfa);
 
      const cleaned = { administrative, pfa, nationwide };
      setAllUnits(cleaned);
      selectFirstUnit("administrative", cleaned);
    } catch (err) {
      console.warn(err);
      setDataError(err.message);
      setGroups([]);
    }
  }, [uploadedData]);
 
  // Re-select first unit whenever geoLevel or allUnits changes
  // This ensures groups state updates when switching geography or uploading new data
  useEffect(() => {
    if (allUnits[geoLevel] && (allUnits[geoLevel]).length > 0) {
      selectFirstUnit(geoLevel, allUnits);
    }
  }, [geoLevel, allUnits]);
;
 
 
  // The rolling window selects the LAST N calendar months of recorded data.
 
  const MONTHS = (uploadedData?.months) || [];
  const DATA_SPAN_MONTHS = MONTHS.length || 36;
  
  const effWindow = Math.max(1, Math.min(windowMonths, DATA_SPAN_MONTHS));
  const totalPop = useMemo(() => groups.reduce((sum, g) => sum + (g.population || 0), 0), [groups]);
  const totalRecordedStops = useMemo(() => groups.reduce((sum, g) => {
    // Use 36-month period entry if available, else raw stops field
    if (Array.isArray(g.periods) && g.periods.length > 0) {
      const p36 = g.periods.find(p => p.months === 36) || g.periods[g.periods.length - 1];
      return sum + (p36.stops || 0);
    }
    return sum + (g.stops || 0);
  }, 0), [groups]);
 
  // rolling window: pick the right period entry for each group
  
  const windowGroups = useMemo(
    () => groups.map(g => {
      // Priority 1: pre-computed periods array (combined_dashboard_data_periods.json)
      if (Array.isArray(g.periods) && g.periods.length > 0) {
        const match = g.periods.find(p => p.months === effWindow)
                   || g.periods.reduce((best, p) =>
                        Math.abs(p.months - effWindow) < Math.abs(best.months - effWindow) ? p : best
                      );
        return { ...g, stops: match.stops, hits: match.hits };
      }
      // Priority 2: monthly s[]/h[] arrays (original embedded dataset)
      const sArr = Array.isArray(g.s) ? g.s : null;
      const hArr = Array.isArray(g.h) ? g.h : null;
      if (sArr) {
        const start = Math.max(0, sArr.length - effWindow);
        const stops = sArr.slice(start).reduce((a, b) => a + (b || 0), 0);
        const hits  = (hArr || []).slice(start).reduce((a, b) => a + (b || 0), 0);
        return { ...g, stops, hits };
      }
      // Fallback: proportional slice from 36mo totals
      const frac = Math.min(1, effWindow / DATA_SPAN_MONTHS);
      return {
        ...g,
        stops: Math.round((g.stops || 0) * frac),
        hits:  Math.round((g.hits  || 0) * frac),
      };
    }),
    [groups, effWindow, DATA_SPAN_MONTHS]
  );
 
  // Stops inside the window (sum across groups)
  const windowStops = useMemo(
    () => windowGroups.reduce((s, g) => s + (g.stops || 0), 0),
    [windowGroups]
  );
 
  
  const windowFraction = totalRecordedStops > 0 ? windowStops / totalRecordedStops : 0;
 
  // ── National benchmark hit rate (needed for volume scaling, computed early) ─
  const nationalHR = useMemo(() => {
    const nw = (allUnits.nationwide || [])[0];
    if (nw) {
      let ts = 0, th = 0;
      (nw.groups || []).forEach(g => {
        if (g.name === 'Unknown') return;   // exclude Unknown (no real population)
        // Priority 1: periods array
        if (Array.isArray(g.periods) && g.periods.length > 0) {
          const match = g.periods.find(p => p.months === effWindow)
                     || g.periods.reduce((best, p) =>
                          Math.abs(p.months - effWindow) < Math.abs(best.months - effWindow) ? p : best
                        );
          ts += match.stops; th += match.hits;
          return;
        }
        // Priority 2: s[]/h[] monthly arrays
        const sArr = Array.isArray(g.s) ? g.s : null;
        const hArr = Array.isArray(g.h) ? g.h : null;
        if (sArr) {
          const start = Math.max(0, sArr.length - effWindow);
          ts += sArr.slice(start).reduce((a, b) => a + (b || 0), 0);
          th += (hArr || []).slice(start).reduce((a, b) => a + (b || 0), 0);
        } else {
          const frac = Math.min(1, effWindow / DATA_SPAN_MONTHS);
          ts += Math.round((g.stops || 0) * frac);
          th += Math.round((g.hits  || 0) * frac);
        }
      });
      if (ts > 0) return th / ts;
    }
    const units = allUnits[geoLevel] || [];
    const ts = units.reduce((s, u) => s + (u.totalStops || 0), 0);
    const th = units.reduce((s, u) => s + (u.totalHits || 0), 0);
    return ts > 0 ? th / ts : 0;
  }, [allUnits, geoLevel]);
 
// budget is derived from the rolling window so it changes when you change the window

// scale = min(1, area_hr / national_hr) (areas below national benchmark get fewer searches)
// windowAreaStops/Hits exclude pop<2 and Unknown so budget matches allocated exactly


  const windowAreaStops = useMemo(() => windowGroups.reduce((s, g) => (g.name !== "Unknown" && (g.population || 0) >= 2) ? s + (g.stops || 0) : s, 0), [windowGroups]);
  const windowAreaHits  = useMemo(() => windowGroups.reduce((s, g) => (g.name !== "Unknown" && (g.population || 0) >= 2) ? s + (g.hits  || 0) : s, 0), [windowGroups]);
  const windowAreaHR    = windowAreaStops > 0 ? windowAreaHits / windowAreaStops : 0;
  const volumeScale     = nationalHR > 0 ? Math.min(1, windowAreaHR / nationalHR) : 1; // never goes above 1 (only penalises underperformers)
 
  // annualise from the window stops (this means budget changes with the window)
  // which is intentional: we want the budget to reflect current activity not historical average
  // (different from the old version which used the fixed 36mo baseline)
  const annualRate   = effWindow > 0 ? Math.round(windowAreaStops / effWindow * 12) : Math.round(totalRecordedStops / (DATA_SPAN_MONTHS / 12));
  const annualBudget = annualRate;   // kept for display
  const rawBudget    = Math.round(annualRate * (budgetPeriod / 12));
  const totalBudget  = Math.round(rawBudget * volumeScale);
 
  const BUDGET_PERIOD_LABEL = budgetPeriod === 1 ? "month" : budgetPeriod === 6 ? "6 months" : "year";
  const BUDGET_PERIOD_SHORT = budgetPeriod === 1 ? "/month" : budgetPeriod === 6 ? "/6 months" : "/year";
 
  const results = useMemo(
    () => runEngine(windowGroups, totalBudget, floorFrac, minStops, volumeScale, effWindow, budgetPeriod),
    [windowGroups, totalBudget, floorFrac]
  );
 
 
  const areaAvgHR = results[0]?.areaAvgHR ?? 0;
  const flaggedCount = results.filter(r => r.rotFlagged).length;
  const totalAllocated = results.filter(r => !r.displayOnly).reduce((s, r) => s + r.finalQuota, 0);
  const totalPool = results[0]?.totalPool ?? 0;
  const maxQuota = Math.max(1, ...results.map(r => r.finalQuota));
 
 
  const addGroup = () => {
    setGroups(g => [...g, { id: nextId, name: `Group ${nextId}`, population: 10000, stops: 2000, hits: 400 }]);
    setNextId(n => n + 1);
  };
 
  const budgetEmpty = totalBudget <= 0;
  const currentAreaName = (allUnits[geoLevel] || []).find(u => u.code === selectedUnit)?.name || selectedUnit || "—";
 
  // File upload handler 
  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target.result);
        if (!parsed.administrative && !parsed.pfa) {
          setDataError("Invalid data file: missing 'administrative' or 'pfa' keys.");
          return;
        }
        setUploadedData(parsed);
        setDataError("");
      } catch {
        setDataError("Could not parse JSON file. Please check the file format.");
      }
    };
    reader.readAsText(file);
  };
 
  const handleResetData = () => {
    setUploadedData(null);
    setDataError("");
  };
 
 
  //inputs page
  if (page === "input") {
    const units = allUnits[geoLevel] || [];
    return (
      <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'DM Sans', system-ui, sans-serif", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px", boxSizing: "border-box" }}>
        <div style={{ width: "100%", maxWidth: 540 }}>
          {/* ── No data prompt ── */}
          {!uploadedData && (
            <div style={{ textAlign: "center", padding: "40px 20px", color: C.muted }}>
              <div style={{ fontSize: 40, marginBottom: 16 }}>📂</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: C.text, marginBottom: 8 }}>No data loaded</div>
              <div style={{ fontSize: 13, marginBottom: 20 }}>Upload a <code>combined_dashboard_data_periods.json</code> file to begin.</div>
              <label style={{ cursor: "pointer", background: C.accent, color: "#000", padding: "10px 24px", borderRadius: 8, fontSize: 14, fontWeight: 700 }}>
                Upload JSON
                <input type="file" accept=".json" onChange={handleFileUpload} style={{ display: "none" }} />
              </label>
              {dataError && <div style={{ color: C.red, fontSize: 12, marginTop: 12 }}>{dataError}</div>}
            </div>
          )}
 
          {/* ── Data upload ── */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 18px", marginBottom: 16 }}>
            <div style={{ fontWeight: 700, color: C.text, marginBottom: 8, fontSize: 14 }}>
              Data source
              {uploadedData && <span style={{ marginLeft: 10, fontSize: 12, color: C.green, fontWeight: 600 }}>&#9679; Custom file loaded</span>}
              {!uploadedData && <span style={{ marginLeft: 10, fontSize: 12, color: C.muted }}>&#9679; Using embedded dataset</span>}
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ cursor: "pointer", background: C.accent, color: "#000", padding: "6px 14px", borderRadius: 6, fontSize: 13, fontWeight: 600 }}>
                Upload JSON
                <input type="file" accept=".json" onChange={handleFileUpload} style={{ display: "none" }} />
              </label>
              {uploadedData && (
                <button onClick={handleResetData}
                  style={{ background: "transparent", border: `1px solid ${C.border}`, color: C.muted, padding: "6px 14px", borderRadius: 6, fontSize: 13, cursor: "pointer" }}>
                  Reset to embedded
                </button>
              )}
            </div>
            {dataError && <div style={{ color: C.red, fontSize: 12, marginTop: 8 }}>{dataError}</div>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 22 }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: C.accent + "18", border: `1.5px solid ${C.accent}44`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>⚖</div>
            <div>
              <div style={{ fontSize: 10, color: C.accent, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase" }}>Group 24 · S&amp;S Reallocation Engine</div>
              <h1 style={{ margin: "2px 0 0", fontSize: 22, fontWeight: 800, color: C.white, letterSpacing: "-0.02em" }}>Fair Search Algorithm</h1>
            </div>
          </div>
 
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: "24px" }}>
            <div style={{ fontSize: 13, color: C.sub, marginBottom: 22, lineHeight: 1.6 }}>
              Choose the budget period and rolling window, then select your area.
            </div>
 
            {/* ── Budget period ── */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6, fontWeight: 700 }}>Budget period</label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                {[
                  { months: 1,  label: "Monthly",    desc: "1 month of searches" },
                  { months: 6,  label: "6-Monthly",  desc: "6 months of searches" },
                  { months: 12, label: "Annual",     desc: "12 months of searches" },
                ].map(({ months, label, desc }) => (
                  <button key={months} onClick={() => {
                    setBudgetPeriod(months);
                    // Ensure window is at least as long as the new budget period
                    const validWindows = [3, 6, 12, 24, 36].filter(w => w >= months);
                    if (windowMonths < months) setWindowMonths(validWindows[0] || months);
                  }}
                    style={{ padding: "10px 8px", borderRadius: 8, border: `2px solid ${budgetPeriod === months ? C.accent : C.border}`, background: budgetPeriod === months ? C.accent + "18" : "transparent", color: budgetPeriod === months ? C.accent : C.sub, cursor: "pointer", textAlign: "center" }}>
                    <div style={{ fontSize: 13, fontWeight: 800 }}>{label}</div>
                    <div style={{ fontSize: 10, marginTop: 2, opacity: 0.8 }}>{desc}</div>
                  </button>
                ))}
              </div>
            </div>
 
            {/* ── Rolling window ── */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6, fontWeight: 700 }}>Rolling window — data used for allocation</label>
              <select
                value={windowMonths}
                onChange={e => setWindowMonths(parseInt(e.target.value, 10))}
                style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${C.border}`, background: C.card, color: C.white, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}
              >
                {[3, 6, 12, 24, 36].filter(m => m >= budgetPeriod && m <= DATA_SPAN_MONTHS).map(m => (
                  <option key={m} value={m}>Last {m} months{m === DATA_SPAN_MONTHS ? " (full record)" : ""}</option>
                ))}
              </select>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
                Determines <em>which</em> data drives the allocation, and the area hit rate used for volume scaling — not how many searches are authorised.
                Using the last {effWindow} months{MONTHS.length ? ` (${MONTHS[Math.max(0, MONTHS.length - effWindow)]} → ${MONTHS[MONTHS.length - 1]})` : ""} = {(windowFraction * 100).toFixed(0)}% of all recorded stops. Window area hit rate: {(windowAreaHR*100).toFixed(1)}%.
              </div>
            </div>
 
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 11, color: C.sub, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>Geography level</label>
              <select value={geoLevel} onChange={e => { const level = e.target.value; setGeoLevel(level); selectFirstUnit(level, allUnits); }}
                style={{ width: "100%", marginTop: 6, background: "#0D1525", color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", fontWeight: 700 }}>
                <option value="administrative">Administrative units</option>
                <option value="pfa">Police force areas</option>
                <option value="nationwide">Nationwide</option>
              </select>
            </div>
 
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 11, color: C.sub, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em" }}>Area where the data is from</label>
              {units.length > 0 ? (
                <select value={selectedUnit} disabled={geoLevel === "nationwide"}
                  onChange={e => { const code = e.target.value; setSelectedUnit(code); const unit = units.find(u => u.code === code); if (unit) setGroups((unit.groups || []).filter(g => g.name !== "Unknown" && ((g.population || 0) >= 100 || (g.stops || 0) > 0))); }}
                  style={{ width: "100%", marginTop: 6, background: "#0D1525", color: C.text, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", fontWeight: 700, opacity: geoLevel === "nationwide" ? 0.7 : 1 }}>
                  {units.map(u => <option key={u.code} value={u.code}>{u.name} ({u.code}) — {(() => {
                          const gs = (u.groups || []).filter(g => g.name !== 'Unknown');
                          if (gs.length && Array.isArray(gs[0].periods)) {
                            const match = gs[0].periods.find(p => p.months === effWindow)
                                       || gs[0].periods[gs[0].periods.length - 1];
                            const w = match ? match.months : 36;
                            const total = gs.reduce((s, g) => {
                              const p = (g.periods || []).find(x => x.months === w)
                                     || (g.periods || [])[g.periods.length - 1];
                              return s + (p ? p.stops : 0);
                            }, 0);
                            return total.toLocaleString();
                          }
                          if (gs.length && Array.isArray(gs[0].s)) {
                            const start = Math.max(0, gs[0].s.length - effWindow);
                            return gs.reduce((s, g) => s + (g.s || []).slice(start).reduce((a,b)=>a+b,0), 0).toLocaleString();
                          }
                          return Math.round((u.totalStops || 0) * effWindow / 36).toLocaleString();
                        })()} stops</option>)}
                </select>
              ) : (
                <div style={{ marginTop: 6, fontSize: 12, color: dataError ? C.red : C.sub }}>{dataError ? "Could not load data — showing default demo groups." : "Loading geography data…"}</div>
              )}
            </div>
 
            <div style={{ background: "#0D1525", border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 14px", marginBottom: 20 }}>
              <div style={{ fontSize: 10, color: C.sub, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>
                Search budget · {BUDGET_PERIOD_LABEL}{volumeScale < 1 ? " · scaled down" : ""}
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: volumeScale < 1 ? C.gold : C.accent, fontFamily: "'DM Mono', monospace", lineHeight: 1.15 }}>
                {totalBudget.toLocaleString()}
                <span style={{ fontSize: 12, color: C.sub, fontWeight: 600 }}> searches{BUDGET_PERIOD_SHORT}</span>
                {volumeScale < 1 && (
                  <span style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}> &nbsp;(was {rawBudget.toLocaleString()})</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                Annual rate (3-yr record): {annualRate.toLocaleString()}/yr. Budget period: {BUDGET_PERIOD_LABEL} → {rawBudget.toLocaleString()} raw{volumeScale < 1 ? <> × volume scale {volumeScale.toFixed(3)}</> : ""} = <strong style={{ color: C.text }}>{totalBudget.toLocaleString()}</strong> searches per {BUDGET_PERIOD_LABEL}.
              </div>
            </div>
 
            {/* ── Floor fraction ── */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6, fontWeight: 700 }}>
                Floor fraction — minimum group allocation
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <input type="range" min={0} max={1} step={0.05} value={floorFrac}
                  onChange={e => setFloorFrac(parseFloat(e.target.value))}
                  style={{ flex: 1, accentColor: C.green }} />
                <span style={{ fontFamily: "monospace", fontWeight: 800, color: C.green, fontSize: 15, minWidth: 42, textAlign: "right" }}>
                  {Math.round(floorFrac * 100)}%
                </span>
              </div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>
                No group's quota falls below <strong style={{ color: C.text }}>{Math.round(floorFrac * 100)}%</strong> of its population-proportional share.
                At 0% the KPT formula runs unconstrained. At 100% no reallocation occurs — every group gets exactly its population share.
                Default 80% is a conservative design choice: it limits any single-period reduction to 20%, preventing a group from being left under-policed before the algorithm self-corrects. This parameter should be agreed by national oversight bodies before operational deployment.
              </div>
            </div>
 
            <button onClick={() => setPage("results")} disabled={!groups.length}
              style={{ width: "100%", background: groups.length ? C.accent : C.muted, color: "#04121f", border: "none", borderRadius: 10, padding: "14px", fontSize: 15, fontWeight: 800, cursor: groups.length ? "pointer" : "not-allowed", letterSpacing: "0.02em" }}>
              View results →
            </button>
          </div>
 
          <div style={{ textAlign: "center", marginTop: 16, fontSize: 11, color: C.muted }}>
            Automated fair allocation of stop and search resources
          </div>
          <div style={{ background: "#1A2235", border: "1px solid #243046", borderRadius: 10, padding: "12px 16px", marginTop: 14, fontSize: 11, color: "#8896B3", lineHeight: 1.7 }}>
            <strong style={{ color: "#E8EDFB" }}>Legal notice —</strong> The monthly quotas produced by this algorithm are <strong style={{ color: "#E8EDFB" }}>aggregate policing unit ceilings</strong>, not individual stop authorisations. Every individual stop and search must be authorised by a constable who has <strong style={{ color: "#E8EDFB" }}>reasonable grounds</strong> to suspect that the person is carrying stolen articles, offensive weapons, or other prohibited items, in accordance with <strong style={{ color: "#00E5FF" }}>PACE Section 1 (Police and Criminal Evidence Act 1984)</strong>. This tool does not alter or replace the individual reasonable-grounds requirement.
          </div>
        </div>
      </div>
    );
  }
 
  //results technical and non-technical
  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: "'DM Sans', system-ui, sans-serif", fontSize: 14 }}>
 
      {/* ── HEADER ── */}
      <div style={{ background: `linear-gradient(135deg, #0D1525 0%, #111E35 100%)`, borderBottom: `1px solid ${C.border}`, padding: "16px 20px 0" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => setPage("input")} style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 12px", color: C.sub, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>← Edit inputs</button>
            <div>
              <div style={{ fontSize: 16, fontWeight: 800, color: C.white }}>Fair Search Algorithm</div>
              <div style={{ fontSize: 11, color: C.sub }}>{currentAreaName} · last {windowMonths} months · {BUDGET_PERIOD_LABEL} budget</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 2, background: C.surface, borderRadius: 8, padding: 3, border: `1px solid ${C.border}` }}>
            {[{ id: "overview", label: "📊 Overview" }, { id: "technical", label: "⚙ Technical" }].map(l => (
              <button key={l.id} onClick={() => setLayer(l.id)}
                style={{ padding: "7px 14px", borderRadius: 6, border: "none", cursor: "pointer", background: layer === l.id ? (l.id === "technical" ? C.accent + "22" : C.green + "22") : "transparent", color: layer === l.id ? (l.id === "technical" ? C.accent : C.green) : C.sub, fontSize: 12, fontWeight: 700 }}>
                {l.label}
              </button>
            ))}
          </div>
        </div>
 
        {/* Summary bar */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 1, background: C.border, borderRadius: "10px 10px 0 0", overflow: "hidden" }}>
          {[
            { label: `Budget / ${BUDGET_PERIOD_LABEL}`, value: totalBudget.toLocaleString(), color: C.accent },
            { label: "Allocated", value: totalAllocated.toLocaleString(), color: totalAllocated === totalBudget ? C.green : C.red },
            { label: "Groups Flagged", value: `${flaggedCount} / ${results.length}`, color: flaggedCount > 0 ? C.red : C.green },
            { label: "Pool Freed", value: fmt1(Math.round(totalPool * budgetPeriod / effWindow * volumeScale)), color: C.gold },
          ].map(s => (
            <div key={s.label} style={{ background: C.surface, padding: "10px 16px" }}>
              <div style={{ fontSize: 10, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em" }}>{s.label}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: s.color, fontFamily: "'DM Mono', monospace" }}>{s.value}</div>
            </div>
          ))}
        </div>
 
        {layer === "technical" && (
          <div style={{ display: "flex", gap: 2, marginTop: 1, background: C.border }}>
            {[{ id: "rot", label: "Stage 1: ROT" }, { id: "kpt", label: "Stage 2: KPT" }, { id: "volume", label: "Stage 3: Volume Scale" }].map(t => (
              <button key={t.id} onClick={() => setTechTab(t.id)}
                style={{ flex: 1, padding: "10px 8px", background: techTab === t.id ? C.accent + "18" : C.surface, border: "none", borderBottom: techTab === t.id ? `2px solid ${C.accent}` : "2px solid transparent", color: techTab === t.id ? C.accent : C.sub, fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>
 
      {/* ── CONTENT ── */}
      <div style={{ padding: "20px 20px 40px" }}>
 
        {/* ─────────── OVERVIEW (non-technical) ─────────── */}
        {layer === "overview" && (
          <div>
            <div style={{ background: C.card, border: `1px solid ${C.accent}33`, borderRadius: 10, padding: "12px 16px", marginBottom: 18, display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ fontSize: 22 }}>🎯</div>
              <div>
                <div style={{ fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em" }}>KPT target — area average hit rate</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: C.accent, fontFamily: "'DM Mono', monospace" }}>{pct(areaAvgHR)} <span style={{ fontSize: 13, color: C.sub, fontWeight: 400 }}>all groups converge toward this</span></div>
              </div>
            </div>
 
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14 }}>
              {results.map((r, i) => {
                const pal = GROUP_PALETTE[i % GROUP_PALETTE.length];
                const dispColor = r.disproportion == null ? C.muted : r.disproportion > 1.3 ? C.red : r.disproportion < 0.85 ? C.gold : C.green;
                return (
                  <div key={r.name} style={{ background: C.card, borderRadius: 12, padding: "16px", border: `1px solid ${C.border}`, borderTop: `3px solid ${pal.solid}` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                      <div style={{ width: 32, height: 32, borderRadius: 8, background: pal.glow, border: `1.5px solid ${pal.solid}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <span style={{ color: pal.solid, fontSize: 14, fontWeight: 800 }}>{r.name[0]}</span>
                      </div>
                      <div>
                        <div style={{ fontWeight: 800, fontSize: 15, color: C.text }}>{r.name}</div>
                        <div style={{ fontSize: 11, color: C.sub }}>pop. {results.reduce((s,x)=>s+(x.population||0),0) > 0 ? (r.population/results.reduce((s,x)=>s+(x.population||0),0)*100).toFixed(1)+'%' : r.population.toLocaleString()}</div>
                      </div>
                    </div>
 
                    <div style={{ background: "#0D1525", borderRadius: 8, padding: "14px", marginBottom: 10 }}>
                      <div style={{ fontSize: 10, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Monthly quota</div>
                      <div style={{ fontSize: 34, fontWeight: 800, color: pal.solid, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>{r.finalQuota.toLocaleString()}</div>
                    </div>
 
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#0D1525", borderRadius: 8, padding: "12px 14px" }}>
                      <div style={{ fontSize: 10, color: C.sub, textTransform: "uppercase", letterSpacing: "0.08em" }}>Disproportion</div>
                      <div style={{ fontSize: 24, fontWeight: 800, color: dispColor, fontFamily: "'DM Mono', monospace" }}>{r.disproportion == null ? "N/A" : (r.disproportion > 50 ? ">50×" : `${r.disproportion.toFixed(2)}×`)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
 
            {/* Three per-region analytic graphs (driven by the selected area's results) */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginTop: 18 }}>
              <HorizChart
                title="GRAPH 1 · DECISION RATE"
                titleColor={C.accent}
                subtitle="Pop share vs stop share"
                note="stop_share(g) vs pop_share(g)"
                rows={results.map((r, i) => {
                  const over = r.stopShare > r.popShare;
                  return { group: r.name, labelA: "Pop", valA: pct(r.popShare, 1), a: r.popShare, labelB: "Stops", valB: pct(r.stopShare, 1), b: r.stopShare, bColor: over ? C.red : GROUP_PALETTE[i % GROUP_PALETTE.length].solid, badge: `${(r.stopShare / (r.popShare || 1)).toFixed(2)}× current`, tag: over ? "over" : null };
                })}
              />
              <HorizChart
                title="GRAPH 2 · HIT RATE"
                titleColor={C.gold}
                subtitle="Hit rate vs area average"
                note={`Area avg: ${pct(areaAvgHR)}`}
                rows={results.map((r) => {
                  const below = r.hitRate < areaAvgHR;
                  return { group: r.name, labelA: "Avg", valA: pct(areaAvgHR, 1), a: areaAvgHR, labelB: "Group", valB: pct(r.hitRate, 1), b: r.hitRate, bColor: below ? C.red : C.green, badge: r.rotFlagged ? "⚑ flagged" : null, tag: r.rotFlagged ? "flag" : null };
                })}
              />
              <HorizChart
                title="GRAPH 3 · SEARCH REALLOCATION"
                titleColor={"#C77DFF"}
                subtitle="Current stops vs engine quota"
                note="Shows how searches move between groups"
                rows={results.filter(r => !r.displayOnly).map((r) => {
                  const before = Math.round(r.stopShare * totalBudget); // current stop share × budget period
                  const after  = r.finalQuota;     // engine allocation
                  const delta  = after - before;
                  const gained = delta > 0;
                  const color  = r.rotFlagged ? C.red : gained ? C.green : C.gold;
                  const badge  = delta === 0
                    ? "no change"
                    : `${delta > 0 ? "+" : ""}${Math.round(delta).toLocaleString()} searches`;
                  return {
                    group: r.name,
                    labelA: "Current", valA: before.toLocaleString(), a: before,
                    labelB: "Engine",  valB: after.toLocaleString(),  b: after,
                    bColor: color,
                    badge,
                    tag: r.rotFlagged ? "flag" : null,
                  };
                })}
              />
              <HorizChart
                title="GRAPH 4 · DISPROPORTION BEFORE AND AFTER"
                titleColor={C.green}
                subtitle="Before vs after engine"
                note="Target = 1.00×"
                rows={results.map((r) => {
                  const before = Math.min(50, r.stopShare / (r.popShare || 1));
                  const after = r.disproportion;
                  if (after == null) return null;
                  const dispC = after > 1.3 ? C.red : after < 0.85 ? C.gold : C.green;
                  return { group: r.name, labelA: "Before", valA: (before > 50 ? ">50×" : `${before.toFixed(2)}×`), a: before, labelB: "After", valB: (after > 50 ? ">50×" : `${after.toFixed(2)}×`), b: after, bColor: dispC, badge: (after > 50 ? ">50× engine" : `${after.toFixed(2)}× engine`), tag: after > 1.3 ? "over" : after < 0.85 ? "under" : null };
                }).filter(Boolean)}
              />
            </div>
 
            <div style={{ marginTop: 18, background: C.card, borderRadius: 10, padding: "12px 16px", border: `1px solid ${C.border}`, display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
              <span style={{ fontSize: 11, color: C.sub, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em" }}>Disproportion key:</span>
              {[
                { label: "< 0.85× under-searched", color: C.gold },
                { label: "0.85–1.3× proportional ✓", color: C.green },
                { label: "> 1.3× over-searched", color: C.red },
              ].map(d => (
                <div key={d.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: d.color }} />
                  <span style={{ fontSize: 11, color: C.sub }}>{d.label}</span>
                </div>
              ))}
            </div>
 
            <p style={{ fontSize: 11, color: C.muted, marginTop: 12, lineHeight: 1.6 }}>
              Annual rate (3-yr record): {annualRate.toLocaleString()}/yr. Budget period: {BUDGET_PERIOD_LABEL} → {rawBudget.toLocaleString()} raw{volumeScale < 1 ? <> × volume scale {volumeScale.toFixed(3)}</> : ""} = <strong style={{ color: C.text }}>{totalBudget.toLocaleString()}</strong> searches per {BUDGET_PERIOD_LABEL}. Disproportion = (quota share) ÷ (population share). Target = 1.00×.
            </p>
          </div>
        )}
 
        {/* ─────────── TECHNICAL · VOLUME SCALE ─────────── */}
        {layer === "technical" && techTab === "volume" && (
          <Card accent={C.accent}>
            <div style={{ fontWeight: 800, color: C.text, marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>Stage 3 — Outcome-Based Volume Scaling</div>
            <p style={{ margin: "0 0 12px", fontSize: 13, color: C.sub, lineHeight: 1.6 }}>
              The raw budget is derived from the rolling window, then scaled by <code>min(1, area&nbsp;HR&nbsp;/&nbsp;national&nbsp;HR)</code>.
              Both rates are measured over the same window (excluding Unknown). Areas at or above the national benchmark are unscaled;
              underperforming areas are reduced proportionally. The scale recovers automatically as productivity improves.
            </p>
            <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "12px 16px", fontFamily: "'DM Mono', monospace", fontSize: 12, lineHeight: 2, marginBottom: 12 }}>
              <div style={{ marginBottom: 4, color: C.accent, fontWeight: 700 }}>STAGE 3 — BUDGET &amp; VOLUME SCALING</div>
              <div style={{ color: C.sub }}>
                annual_rate = window_stops / {effWindow}mo × 12 = {annualRate.toLocaleString()}/yr<br />
                raw_budget  = annual_rate × ({budgetPeriod}/12) = {rawBudget.toLocaleString()}<br />
                scale       = min(1, area_hr / national_hr)<br />
                &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; = min(1, {(windowAreaHR*100).toFixed(1)}% / {(nationalHR*100).toFixed(1)}%) = <strong style={{ color: volumeScale < 1 ? C.gold : C.green }}>{volumeScale.toFixed(3)}</strong><br />
                budget      = round(raw_budget × scale) = <strong style={{ color: C.text }}>{totalBudget.toLocaleString()}</strong>
              </div>
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 160, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px" }}>
                <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, marginBottom: 4 }}>AREA HIT RATE ({effWindow}mo)</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: windowAreaHR < nationalHR ? C.gold : C.green }}>{(windowAreaHR*100).toFixed(2)}%</div>
              </div>
              <div style={{ flex: 1, minWidth: 160, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px" }}>
                <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, marginBottom: 4 }}>NATIONAL BENCHMARK ({effWindow}mo, excl. Unknown)</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: C.accent }}>{(nationalHR*100).toFixed(2)}%</div>
              </div>
              <div style={{ flex: 1, minWidth: 160, background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 14px" }}>
                <div style={{ fontSize: 11, color: C.muted, fontWeight: 600, marginBottom: 4 }}>VOLUME SCALE FACTOR</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: volumeScale < 1 ? C.gold : C.green }}>{volumeScale.toFixed(3)}</div>
              </div>
            </div>
          </Card>
        )}
 
                {/* ─────────── TECHNICAL · ROT ─────────── */}
        {layer === "technical" && techTab === "rot" && (
          <Card accent={C.accent}>
            <div style={{ fontWeight: 800, color: C.text, marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>Stage 1 — Robust Outcome Test (ROT)</div>
            <p style={{ margin: "0 0 10px", fontSize: 13, color: C.sub, lineHeight: 1.6 }}>Flags a group when both signals fire simultaneously. The dual-signal requirement prevents false positives — a group with a low hit rate but low stop share is under-policed, not over-policed; the ROT correctly ignores it. Note: ROT flags are computed from the rolling window, not the budget horizon. Every individual stop still requires reasonable grounds under PACE Section 1.</p>
            <div style={{ background: "#0D1525", borderRadius: 8, padding: "10px 12px", border: `1px solid ${C.accent}33`, fontFamily: "monospace", fontSize: 12, color: C.text, lineHeight: 2, marginBottom: 12 }}>
              flag(g) = 1 if stop_share(g) {">"} pop_share(g) <span style={{ color: C.muted }}>[Signal A]</span><br />
              &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; AND hit_rate(g) {"<"} area_avg_hr <span style={{ color: C.muted }}>[Signal B]</span><br />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
              <div style={{ background: "#0D1525", borderRadius: 8, padding: "10px 12px", border: `1px solid ${C.red}33` }}>
                <div style={{ fontSize: 10, color: C.red, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Signal A — Decision rate</div>
                <div style={{ fontFamily: "monospace", fontSize: 12, color: C.text }}>stop_share(g) {">"} pop_share(g)</div>
                <div style={{ fontSize: 11, color: C.sub, marginTop: 6, lineHeight: 1.6 }}>Group is searched at a higher rate than its population share. Necessary but insufficient on its own.</div>
              </div>
              <div style={{ background: "#0D1525", borderRadius: 8, padding: "10px 12px", border: `1px solid ${C.red}33` }}>
                <div style={{ fontSize: 10, color: C.red, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>Signal B — Outcome rate</div>
                <div style={{ fontFamily: "monospace", fontSize: 12, color: C.text }}>hit_rate(g) {"<"} area_avg_hr</div>
                <div style={{ fontSize: 11, color: C.sub, marginTop: 6, lineHeight: 1.6 }}>KPT (2001): absent discrimination, hit rates equalise at equilibrium.</div>
              </div>
            </div>
            {!budgetEmpty && <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden" }}><ROTTable results={results} /></div>}
          </Card>
        )}
 
        {/* ─────────── TECHNICAL · KPT ─────────── */}
        {layer === "technical" && techTab === "kpt" && (
          <Card accent={C.gold}>
            <div style={{ fontWeight: 800, color: C.text, marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>Stage 2 — KPT Reallocation</div>
            <p style={{ margin: "0 0 10px", fontSize: 13, color: C.sub, lineHeight: 1.6 }}>Reallocation runs in observed-stop space (window counts, not budget units). For each flagged group the fair stop count is hits / area_avg_hr; a floor prevents cutting below 80% of population-proportional. Freed stops are redistributed to unflagged groups by population share. The prediction factor (horizon / window) and volume scale are applied after reallocation, so the within-area redistribution is independent of the chosen horizon.</p>
            <div style={{ background: "#0D1525", borderRadius: 8, padding: "10px 12px", border: `1px solid ${C.gold}33`, fontFamily: "monospace", fontSize: 12, color: C.text, lineHeight: 1.9, marginBottom: 12 }}>
              <span style={{ color: C.muted }}>// observed-stop space (window counts)</span><br />
              fair(g)     = hits(g) / area_avg_hr <span style={{ color: C.muted }}>[if flagged]</span><br />
              floor(g)    = {pct(floorFrac, 0)} × pop_share(g) × total_obs_stops<br />
              adj(g)      = max(fair(g), floor(g)) <span style={{ color: C.muted }}>[if flagged]</span><br />
              adj(g)      = obs_stops(g) + pop_share(g)/unflagged_pop × freed <span style={{ color: C.muted }}>[if unflagged]</span><br />
              <span style={{ color: C.muted }}>// project to budget horizon &amp; apply volume cap</span><br />
              pred_factor = {budgetPeriod}/{effWindow} = {(budgetPeriod/effWindow).toFixed(4)}<br />
              final(g)    = round(adj(g) × pred_factor × scale)
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
              <StatBox label="Pool freed (budget period)" value={fmt1(Math.round(totalPool * budgetPeriod / effWindow * volumeScale))} color={C.gold} small />
              <StatBox label="Area avg hit rate" value={pct(areaAvgHR)} color={C.accent} small />
              <StatBox label="Floor fraction" value={pct(floorFrac, 0)} color={C.green} small />
            </div>
            {!budgetEmpty && <div style={{ background: C.card, borderRadius: 10, border: `1px solid ${C.border}`, overflow: "hidden" }}><KPTTable results={results} /></div>}
            <div style={{ marginTop: 10, fontSize: 11, color: C.muted }}>▲ Floor enforced — group hit_rate / area_avg &lt; floor fraction. Disp = (quota share) ÷ (pop share). Target: 1.00×. Scaling cap applied uniformly after KPT.</div>
          </Card>
        )}
 
      </div>
    </div>
  );
}
 