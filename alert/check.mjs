// 환원율 단계 알림 체커 — GitHub Actions 크론에서 실행
// 가챠별로 90/95/100%를 "처음 넘는 순간" 1회씩 텔레그램 알림. 다시 떨어지면(히스테리시스) 리셋.
import fs from "node:fs";

const API = process.env.GACHA_API || "https://dopaking-web.vercel.app/api/gachas";
const SITE = "https://dopaking-web.vercel.app";
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const THRESHOLDS = (process.env.THRESHOLDS || "90,95,100").split(",").map(Number).sort((a, b) => a - b);
const HYST = Number(process.env.HYSTERESIS || 2); // 재알림 방지 여유(%)
const STATE_FILE = new URL("./state.json", import.meta.url);

const fmt = (n) => Number(n).toLocaleString("ko-KR");
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } };
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");

async function tg(text) {
  if (!TOKEN || !CHAT) { console.log("[DRY-RUN no token]\n" + text + "\n"); return; }
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: false }),
  });
  if (!r.ok) console.error("Telegram 발송 실패:", r.status, await r.text());
}

async function main() {
  const res = await fetch(API);
  if (!res.ok) throw new Error("API HTTP " + res.status);
  const { gachas = [] } = await res.json();
  const state = loadState();
  let changed = false;
  const alerts = [];
  const activeIds = new Set();

  for (const g of gachas) {
    if (g.evNote || g.returnRate == null) continue;       // 티켓/번들/계산불가 제외
    const rate = g.returnRate * 100;
    activeIds.add(g.id);
    const st = state[g.id] || (state[g.id] = { title: g.title, alerted: [] });
    st.title = g.title;
    for (const t of THRESHOLDS) {
      const has = st.alerted.includes(t);
      if (rate >= t && !has) { st.alerted.push(t); changed = true; alerts.push({ g, t, rate }); }
      else if (rate < t - HYST && has) { st.alerted = st.alerted.filter((x) => x !== t); changed = true; } // 떨어지면 리셋
    }
  }
  // 비활성(종료/매진)된 가챠는 상태에서 제거
  for (const id of Object.keys(state)) if (!activeIds.has(id)) { delete state[id]; changed = true; }

  alerts.sort((a, b) => b.t - a.t); // 높은 임곗값 먼저
  for (const { g, t, rate } of alerts) {
    const emoji = t >= 100 ? "🚨🔥" : (t >= 95 ? "🚨" : "⚠️");
    const profit = g.evCoins - g.priceOrTicket;
    const text =
      `${emoji} <b>환원율 ${t}% 돌파!</b>\n` +
      `<b>${g.title}</b>\n` +
      `· 현재 환원율 <b>${rate.toFixed(1)}%</b>\n` +
      `· 1회 ${fmt(g.priceOrTicket)}원 → 기대 ${fmt(g.evCoins)}코인 (손익 ${profit >= 0 ? "+" : ""}${fmt(profit)})\n` +
      `· 전체 잔여 ${fmt(g.rem)} / ${fmt(g.tot)}\n` +
      `👉 ${SITE}`;
    await tg(text);
    console.log(`alert: ${g.title} ${t}% (현재 ${rate.toFixed(1)}%)`);
  }

  if (changed) saveState(state);
  console.log(`체크 ${gachas.length}개 · 알림 ${alerts.length}건 · stateChanged=${changed}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
