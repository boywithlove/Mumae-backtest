// 무한매수법 백테스트 엔진 — 브라우저/Node 공용
//
//  V4.0 : 실운영 코드(MMV4/Local/Moving/Mumae_V4_Local_Moving.py의 generate_v4_orders_local)를 그대로 옮긴 것.
//         매일 종가 확정 후 "다음 날 주문표(매수/매도 리스트)"를 만들고, 다음 날 OHLC로 체결을 판정한다.
//  V2.2 : 라오어 무한매수법 V2.2 원문 규칙 (T = 누적매입금 ÷ 1회매수금, 소진 시 쿼터손절).
//
//  체결 판정 (MMV4/Local/Mumae_V4_Backtest.py의 simulate_fills와 동일)
//   - LOC 매수 : 종가 <= 주문가 → 종가 체결
//   - LOC 매도 : 종가 >= 주문가 → 종가 체결
//   - 지정가 매도 : 장중 고가 >= 주문가 → 주문가 체결
//   - MOC : 무조건 종가 체결
//  bars: [{d, o, h, l, c}] 날짜 오름차순
(function (root) {
  'use strict';

  // Python round(x, n)와 동일: double의 정확한 십진값 기준, 정확히 반이면 짝수 쪽 (실운영 코드와 결과를 맞추기 위함)
  function rnd(x, n) {
    if (!isFinite(x) || x === 0) return x;
    const neg = x < 0, s = Math.abs(x).toFixed(Math.min(100, n + 40));
    const dot = s.indexOf('.'), ip = s.slice(0, dot), fp = s.slice(dot + 1);
    const digits = ip + fp.slice(0, n), rest = fp.slice(n);
    let up = rest[0] > '5' || (rest[0] === '5' && (/[1-9]/.test(rest.slice(1)) || (+digits[digits.length - 1]) % 2 === 1));
    let v = (BigInt(digits) + (up ? 1n : 0n)).toString();
    if (n > 0) { v = v.padStart(n + 1, '0'); v = v.slice(0, -n) + '.' + v.slice(-n); }
    const r = parseFloat(v);
    return neg ? -r : r;
  }
  const r2 = x => rnd(x, 2);
  const floor2 = x => Math.floor(x * 100) / 100;   // 실운영 math.floor(x*100)/100과 동일 (보정 없음)
  const ceil2 = x => Math.ceil(x * 100 - 1e-9) / 100;

  const DEFAULTS = {
    v4: {
      seed: 5000, splits: 20, targetPct: 15, starPct: 20, reverseExit: 0.80, bigPct: 12,
      ladderRows: 5, ladderQty: 1, compound: true, feePct: 0,
      reverseDoubleDecay: true   // 리버스 첫날: 주문 시점 T 감쇄 + 다음 날 MOC 체결 시 한 번 더 감쇄 (현재 실운영 코드 동작)
    },
    v22: {
      seed: 5000, splits: 40, targetPct: 12, starPct: 12, bigPct: 12,
      ladderRows: 5, ladderQty: 1, compound: true, feePct: 0
    }
  };

  // ── 공통: 체결 판정 ─────────────────────────────────────────
  // 주문: [가격 | 'MOC', 수량, 설명, 종류('LOC'|'LIMIT'|'MOC')]
  function simulateFills(buyList, sellList, bar) {
    const fills = [];
    for (const [px, q, why] of buyList) {
      if (q > 0 && typeof px === 'number' && bar.c <= px) fills.push({ side: '매수', q, px: r2(bar.c), why });
    }
    for (const [px, q, why, kind] of sellList) {
      if (!q) continue;
      if (kind === 'MOC') fills.push({ side: '매도', q, px: r2(bar.c), why });
      else if (kind === 'LOC') { if (bar.c >= px) fills.push({ side: '매도', q, px: r2(bar.c), why }); }
      else if (bar.h >= px) fills.push({ side: '매도', q, px: r2(px), why });
    }
    return fills;
  }

  // 체결 반영 (실운영 apply_fills_to_state와 동일: 매도 먼저 '어제 평단' 기준 손익 실현 → 매수로 평단 갱신, 평단 소수 4자리)
  function applyFills(st, fills, fee) {
    let realized = 0, sellQ = 0, buyQ = 0, feeSum = 0;
    const buyPrices = [];
    for (const f of fills) {
      if (f.side !== '매도') continue;
      const q = Math.min(f.q, st.hold);
      if (q <= 0) { f.q = 0; continue; }
      f.q = q;
      realized += (f.px - st.avg) * q;
      st.hold -= q; st.spent -= st.avg * q; sellQ += q; feeSum += f.px * q * fee;
    }
    for (const f of fills) {
      if (f.side !== '매수') continue;
      st.hold += f.q; st.spent += f.px * f.q; buyQ += f.q; buyPrices.push(f.px); feeSum += f.px * f.q * fee;
    }
    st.accum = r2(st.accum + realized - feeSum);
    st.fees += feeSum;
    if (st.hold > 0) { st.avg = rnd(st.spent / st.hold, 4); st.spent = rnd(st.avg * st.hold, 4); }
    else { st.hold = 0; st.spent = 0; st.avg = 0; }
    return { qtyChange: buyQ - sellQ, buyQ, sellQ, buyPrices };
  }

  const effCapital = (st, p) => p.compound ? p.seed + st.accum : Math.min(p.seed, p.seed + st.accum);

  // 사다리(하락 대비 추가 LOC): 예산 ÷ (기본수량 + k) 가격에 ladderQty주씩
  function addLadder(list, budget, baseQty, upper, p, checkUpper) {
    const LR = Math.max(0, p.ladderRows | 0), LQ = Math.max(1, p.ladderQty | 0);
    const maxLines = list.length + LR;
    let extra = 0;
    while (list.length < maxLines) {
      extra += LQ;
      const px = floor2(budget / (baseQty + extra));
      if (px <= 0) break;
      if (checkUpper && px >= upper) continue;
      list.push([px, LQ, '사다리 LOC', 'LOC']);
    }
  }

  const sma5At = (bars, i) => { const s = bars.slice(Math.max(0, i - 4), i + 1); return s.reduce((a, b) => a + b.c, 0) / s.length; };
  const sortBuys = l => l.sort((a, b) => b[0] - a[0]);
  const sortSells = l => l.sort((a, b) => (typeof a[0] === 'number' ? a[0] : 99999) - (typeof b[0] === 'number' ? b[0] : 99999));

  // ── V4.0 (실운영 generate_v4_orders_local 포팅) ─────────────────────
  function v4Day(st, p, bars, i, info) {
    const close = bars[i].c, N = p.splits;
    const tr = 1 + p.targetPct / 100, bigMult = 1 + p.bigPct / 100;
    const prevT = st.t, avg = st.avg, hold = st.hold;
    const cash = effCapital(st, p) - st.spent;
    const sma5 = sma5At(bars, i);
    const decay = N === 40 ? 0.95 : 0.9;

    let newTN = prevT;
    if (info.qtyChange < 0) newTN = r2(prevT * 0.75);
    else if (info.qtyChange > 0) {
      if (prevT < N / 2 && avg > 0 && info.anyFill) {
        let hit = info.buyPrices.some(x => x <= avg);
        if (st.avgTierSkipped) hit = true;
        newTN = r2(prevT + (hit ? 1 : 0.5));
      } else newTN = r2(prevT + (info.buyQ <= 1 ? 0.5 : 1));
    }

    let mode = st.mode, next = mode, justExited = false;
    if (mode === '리버스' && close > avg * p.reverseExit) { next = '일반'; justExited = true; st.events.push('리버스 복귀'); }
    if (next === '일반' && mode !== '리버스' && newTN > N - 1) next = '리버스1';

    let buy = [], sell = [], newT = prevT, star = 0, limit = 0, disp;
    const isNew = next === '일반' && hold === 0 && avg === 0;

    if (isNew) {
      newT = 0;
      const budget = effCapital(st, p) / N;
      star = r2(close * (1 + p.starPct / 100));
      const bigPx = r2(close * bigMult);
      const q = Math.max(1, Math.floor(budget / bigPx));
      buy.push([bigPx, q, '큰수 LOC (새 사이클)', 'LOC']);
      addLadder(buy, budget, q, bigPx, p, true);
      st.cycleSeed = effCapital(st, p);
      st.avgTierSkipped = false;
      limit = budget; next = '일반'; disp = '뉴 사이클';
    } else if (next === '일반') {
      st.avgTierSkipped = false;
      newT = justExited ? prevT : newTN;
      const denom = N - newT > 0 ? N - newT : 1;
      const daily = cash / denom;
      const starPct = p.starPct - (p.starPct / (N / 2)) * newT;
      star = r2(avg * (1 + starPct / 100));
      if (avg > 0) {
        let total = 0, upper = avg;
        if (newT < N / 2) {
          let sb = r2(star - 0.01);
          const tp = r2(avg * tr);
          if (sb >= tp) sb = r2(tp - 0.01);
          let qS = sb > 0 ? Math.max(0, Math.floor(daily / 2 / sb)) : 0;
          if (qS === 0 && sb > 0 && daily >= sb) {
            const affordAvg = Math.floor(daily / avg);
            if (affordAvg >= 1) { qS = 1; if (affordAvg <= 1) st.avgTierSkipped = true; }
          }
          const qA = Math.max(0, Math.floor(daily / avg) - qS);
          if (qS > 0) buy.push([r2(sb), qS, '별지점 LOC', 'LOC']);
          if (qA > 0) buy.push([r2(avg), qA, '평단 LOC', 'LOC']);
          total = qS + qA; upper = avg;
        } else {
          const sb = r2(star - 0.01);
          let qS = sb > 0 ? Math.max(0, Math.floor(daily / sb)) : 0;
          if (qS === 0 && daily >= sb) qS = 1;
          if (qS > 0) buy.push([sb, qS, '별지점 LOC (후반전)', 'LOC']);
          total = qS; upper = sb;
        }
        addLadder(buy, daily, total, upper, p, true);
      }
      const q4 = Math.floor(hold * 0.25);
      sell = sortSells([[r2(star), q4, '쿼터매도'], [r2(avg * tr), hold - q4, '목표가 매도']]);
      // 실운영과 동일: 가격이 가장 낮은 첫 줄 = LOC, 나머지 = 지정가
      sell.forEach((s, k) => { s[3] = k === 0 ? 'LOC' : 'LIMIT'; s[2] += k === 0 ? ' (LOC)' : ' (지정가)'; });
      limit = daily;
      disp = newT < N / 2 ? '전반전' : '후반전';
    } else if (next === '리버스1') {
      st.avgTierSkipped = false;
      newT = p.reverseDoubleDecay ? rnd(prevT * decay, 4) : prevT;
      sell = [['MOC', Math.floor(hold / (N / 2)), '리버스 첫날 MOC', 'MOC']];
      star = r2(sma5);
      st.reverseCount++; st.revStart = i; st.events.push('리버스 진입');
      next = '리버스'; disp = '리버스1일차';
    } else {
      st.avgTierSkipped = false;
      if (info.qtyChange < 0) newT = rnd(prevT * decay, 4);
      else if (info.qtyChange > 0) newT = rnd(prevT + (N - prevT) * 0.25, 4);
      else newT = prevT;
      star = r2(sma5);
      const budget = cash / 4, bp = r2(star - 0.01), sq = Math.floor(hold / (N / 2));
      if (!(bp > 0 && budget >= bp)) {
        sell = [['MOC', sq, '리버스 MOC (잔금 부족)', 'MOC']];
      } else {
        const base = Math.floor(budget / bp);
        buy.push([bp, base, '리버스 쿼터매수 LOC', 'LOC']);
        addLadder(buy, budget, base, 0, p, false);
        sell = [[r2(star), sq, '리버스 매도 LOC', 'LOC']];
      }
      limit = budget;
      disp = `리버스${i - st.revStart + 1}일차`;
    }

    st.t = newT; st.mode = next; st.buy = sortBuys(buy); st.sell = sell;
    st.star = star; st.limit = limit; st.disp = disp;
  }

  // ── V2.2 (라오어 원문) ──────────────────────────────────────
  //  1회매수금 = 사이클 시작 자금 ÷ 분할수 (사이클 동안 고정)
  //  T = 누적매입금(보유 원가) ÷ 1회매수금, 소수 둘째 자리 올림
  //  별% = 목표% × (1 − 2T/분할수)   예) 40분할 SOXL: 12 − 0.6T, TQQQ: 10 − 0.5T
  //  전반전(T < N/2): 절반 별지점−0.01 LOC + 절반 평단 LOC / 후반전: 전액 별지점−0.01 LOC
  //  매도: 1/4 별지점 LOC + 3/4 평단×(1+목표%) 지정가
  //  소진(T > N−1): 쿼터손절 — 보유 1/4 MOC 매도 후 일반 규칙으로 계속
  function v22Day(st, p, bars, i) {
    const close = bars[i].c, N = p.splits, tr = 1 + p.targetPct / 100;
    const avg = st.avg, hold = st.hold;
    let buy = [], sell = [], star = 0, limit = 0, disp;

    if (hold === 0) {
      st.unit = effCapital(st, p) / N; st.t = 0;
      star = r2(close * (1 + p.starPct / 100));
      const bigPx = r2(close * (1 + p.bigPct / 100));
      const q = Math.max(1, Math.floor(st.unit / bigPx));
      buy.push([bigPx, q, '큰수 LOC (새 사이클)', 'LOC']);
      addLadder(buy, st.unit, q, bigPx, p, true);
      st.cycleSeed = effCapital(st, p);
      limit = st.unit; disp = '뉴 사이클'; st.mode = '일반';
    } else {
      const T = ceil2(st.spent / st.unit);
      st.t = T;
      const cash = Math.max(0, effCapital(st, p) - st.spent);
      const budget = Math.min(st.unit, cash / (1 + (p.feePct || 0) / 100));
      const starPct = p.starPct * (1 - 2 * T / N);
      star = r2(avg * (1 + starPct / 100));
      const tp = r2(avg * tr);
      if (T > N - 1) {
        sell = [['MOC', Math.floor(hold / 4), '쿼터손절 MOC', 'MOC']];
        st.reverseCount++; st.events.push('쿼터손절');
        disp = '쿼터손절'; st.mode = '쿼터손절';
      } else {
        let sb = r2(star - 0.01);
        if (sb >= tp) sb = r2(tp - 0.01);
        let total = 0, upper = sb;
        if (T < N / 2) {
          const qS = sb > 0 ? Math.max(0, Math.floor(budget / 2 / sb)) : 0;
          const qA = Math.max(0, Math.floor(budget / avg) - qS);
          if (qS > 0) buy.push([sb, qS, '별지점 LOC', 'LOC']);
          if (qA > 0) buy.push([r2(avg), qA, '평단 LOC', 'LOC']);
          total = qS + qA; upper = Math.min(r2(avg), sb);
        } else {
          const qS = sb > 0 ? Math.floor(budget / sb) : 0;
          if (qS > 0) buy.push([sb, qS, '별지점 LOC (후반전)', 'LOC']);
          total = qS;
        }
        if (budget > 0) addLadder(buy, budget, total, upper, p, true);
        const q4 = Math.floor(hold / 4);
        sell = [[r2(star), q4, '쿼터매도 (LOC)', 'LOC'], [tp, hold - q4, '목표가 매도 (지정가)', 'LIMIT']];
        limit = budget;
        disp = T < N / 2 ? '전반전' : '후반전'; st.mode = '일반';
      }
    }
    st.buy = sortBuys(buy); st.sell = sell; st.star = star; st.limit = limit; st.disp = disp;
  }

  // ── 실행 ────────────────────────────────────────────────
  function run(bars, opt) {
    const strategy = (opt && opt.strategy) || 'v4';
    const p = Object.assign({ strategy, from: '', to: '' }, DEFAULTS[strategy], opt || {});
    const fee = (p.feePct || 0) / 100;
    const dayFn = strategy === 'v22' ? v22Day : v4Day;

    let i0 = bars.findIndex(b => !p.from || b.d >= p.from), i1 = bars.length - 1;
    while (p.to && i1 > 0 && bars[i1].d > p.to) i1--;
    if (i0 < 0 || i1 - i0 < 1) throw new Error('기간 안에 데이터가 없어요.');

    const st = { t: 0, mode: '일반', hold: 0, avg: 0, spent: 0, accum: 0, fees: 0, buy: [], sell: [],
      avgTierSkipped: false, unit: 0, cycleSeed: p.seed, reverseCount: 0, revStart: 0, events: [],
      star: 0, limit: 0, disp: '' };
    const equity = [], trades = [], cycles = [], log = [];
    let cycle = null, peak = p.seed, mdd = 0;

    for (let i = i0; i <= i1; i++) {
      const b = bars[i];
      const fills = i > i0 ? simulateFills(st.buy, st.sell, b) : [];
      const holdBefore = st.hold, tBefore = st.t;
      const info = applyFills(st, fills, fee);
      info.anyFill = fills.length > 0;

      if (holdBefore === 0 && st.hold > 0) {
        cycle = { start: b.d, i0: i, seed: st.cycleSeed, accum0: st.accum - 0, reverses: 0, quarters: 0, buys: 0 };
        // 첫 매수 수수료는 이미 accum에 반영됐으므로 기준점을 체결 전으로 보정
        cycle.accum0 = st.accum + fills.filter(f => f.side === '매수').reduce((s, f) => s + f.px * f.q * fee, 0);
      }
      if (cycle) {
        cycle.buys += fills.filter(f => f.side === '매수').length ? 1 : 0;
        if (fills.some(f => f.why && f.why.startsWith('쿼터매도'))) cycle.quarters++;
      }

      st.events = [];
      dayFn(st, p, bars, i, info);
      if (cycle && st.events.some(e => e === '리버스 진입' || e === '쿼터손절')) cycle.reverses++;

      for (const f of fills) if (f.q > 0) trades.push({ d: b.d, side: f.side, px: f.px, q: f.q, why: f.why, T: st.t });

      if (cycle && holdBefore > 0 && st.hold === 0) {
        const pnl = st.accum - cycle.accum0;
        cycles.push(Object.assign(cycle, { end: b.d, days: i - cycle.i0, pnl, ret: pnl / cycle.seed * 100 }));
        cycle = null;
      }

      const eq = p.seed + st.accum - st.spent + st.hold * b.c;
      peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1);
      equity.push({ d: b.d, v: eq, t: st.t, m: st.mode, inv: st.hold * b.c / eq });
      log.push({
        d: b.d, c: b.c, fills: fills.filter(f => f.q > 0).map(f => `${f.side} ${f.q}주@${f.px.toFixed(2)}`).join(', '),
        disp: st.disp, t: st.t, avg: st.avg, hold: st.hold, cash: effCapital(st, p) - st.spent, accum: st.accum,
        star: st.star, limit: st.limit, buy: st.buy.map(x => x.slice()), sell: st.sell.map(x => x.slice()),
        tPrev: tBefore, events: st.events.slice()
      });
    }
    if (cycle) cycles.push(Object.assign(cycle, { end: '진행 중', days: i1 - cycle.i0, pnl: st.accum - cycle.accum0, ret: null }));

    const span = bars.slice(i0, i1 + 1);
    const last = span[span.length - 1];
    const state = { mode: st.disp, T: st.t, shares: st.hold, avg: st.avg, cash: effCapital(st, p) - st.spent,
      star: st.star, limit: st.limit, buy: st.buy, sell: st.sell, close: last.c, date: last.d };
    return { params: p, equity, trades, cycles, log, state,
      stats: stats(span, equity, p.seed, mdd, cycles, st), bh: buyHold(span, p.seed, fee) };
  }

  function years(bars) { return Math.max((new Date(bars[bars.length - 1].d) - new Date(bars[0].d)) / 3.15576e10, 1 / 365); }
  function stats(bars, equity, seed, mdd, cycles, st) {
    const end = equity.length ? equity[equity.length - 1].v : seed, y = years(bars);
    const done = cycles.filter(c => c.ret != null), wins = done.filter(c => c.pnl > 0);
    return {
      final: end, years: y, ret: (end / seed - 1) * 100, cagr: (Math.pow(Math.max(end, 0) / seed, 1 / y) - 1) * 100, mdd: mdd * 100,
      cycles: done.length, wins: wins.length, winRate: done.length ? wins.length / done.length * 100 : 0,
      avgDays: done.length ? done.reduce((s, c) => s + c.days, 0) / done.length : 0,
      reverses: st.reverseCount, fees: st.fees,
      invested: equity.reduce((s, e) => s + e.inv, 0) / Math.max(1, equity.length) * 100
    };
  }
  function buyHold(bars, seed, fee) {
    const q = Math.floor(seed / (bars[0].c * (1 + fee))), left = seed - q * bars[0].c * (1 + fee);
    let peak = seed, mdd = 0;
    const equity = bars.map(b => { const v = left + q * b.c; peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); return { d: b.d, v }; });
    const end = equity[equity.length - 1].v, y = years(bars);
    return { equity, final: end, ret: (end / seed - 1) * 100, cagr: (Math.pow(end / seed, 1 / y) - 1) * 100, mdd: mdd * 100 };
  }

  const api = { run, DEFAULTS, simulateFills };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MumaeBT = api;
})(this);
