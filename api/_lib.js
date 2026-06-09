// 공용: 도파킹 Firebase 로그인 + Firestore gacha_entries 조회
const KEY = process.env.FIREBASE_API_KEY || "AIzaSyDZ6qtSv9BQg7TPDWZx7NZLyvjlKrIPqT4";
const PROJ = "dopaking-eed9a";
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJ}/databases/(default)/documents`;
export const GRADES = ["s", "a", "b", "c", "d", "e", "last"];

// 따뜻한 람다에서 idToken 캐시 (50분)
let _tok = null, _at = 0;
export async function getToken() {
  if (_tok && Date.now() - _at < 50 * 60 * 1000) return _tok;
  const email = process.env.DOPAKING_EMAIL, password = process.env.DOPAKING_PASSWORD;
  if (!email || !password) throw new Error("서버에 DOPAKING_EMAIL/PASSWORD 환경변수가 없습니다.");
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const d = await r.json();
  if (d.error) throw new Error("로그인 실패: " + d.error.message);
  _tok = d.idToken; _at = Date.now();
  return _tok;
}

export function uv(v) {
  if (!v) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("nullValue" in v) return null;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(uv);
  if ("mapValue" in v) { const o = {}; const f = v.mapValue.fields || {}; for (const k in f) o[k] = uv(f[k]); return o; }
  return undefined;
}
export function flat(doc) { const o = { _id: doc.name.split("/").pop() }; const f = doc.fields || {}; for (const k in f) o[k] = uv(f[k]); return o; }

// cards 컬렉션 batchGet (이미지/등급 등 메타) — id 청크로 일괄조회
export async function getCards(ids) {
  const tok = await getToken();
  const map = {};
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const names = chunk.map(id => `projects/${PROJ}/databases/(default)/documents/cards/${id}`);
    const r = await fetch(`${FS_BASE}:batchGet`, {
      method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify({ documents: names }),
    });
    const arr = await r.json();
    if (Array.isArray(arr)) for (const e of arr) {
      if (!e.found) continue;
      const id = e.found.name.split("/").pop();
      const f = e.found.fields || {};
      map[id] = {
        cardImage: uv(f.cardImage), cardRating: uv(f.cardRating), cardGrading: uv(f.cardGrading),
        cardName: uv(f.cardName), coinPrice: uv(f.coinPrice),
      };
    }
  }
  return map;
}

// 등급 → 카드(이름)별 잔여 상세 (라인 순서 유지)
export async function buildDetail(g) {
  const base = summary(g);
  const allIds = [];
  const stats = {};
  for (const gr of GRADES) {
    if (!base.grades[gr]) continue;
    const st = gradeStat(g, gr);
    stats[gr] = st;
    for (const c of st.cards) if (c.id) allIds.push(c.id);
    base.grades[gr].cards = st.cards;
  }
  // 등급별 기대 기여도(어느 등급이 EV를 끌어올리나) 부착
  const ev = expectedValue(stats, g.priceOrTicket, g.category);
  base.ev = ev;
  for (const gr of GRADES) {
    if (base.grades[gr] && ev.byGradeShare[gr] != null) {
      base.grades[gr].evShare = ev.byGradeShare[gr];          // 0~1, 이 등급이 1회 기대코인에서 차지하는 비중
      base.grades[gr].evPerDraw = base.rem ? Math.round(ev.byGradeCoins[gr] / base.rem) : 0; // 1회당 이 등급 기여 코인
    }
  }
  // 이미지/등급 메타 부착 (cards 컬렉션)
  const meta = await getCards([...new Set(allIds)]);
  for (const gr of GRADES) {
    if (!base.grades[gr]?.cards) continue;
    for (const c of base.grades[gr].cards) {
      const m = meta[c.id]; if (m) { c.cardImage = m.cardImage; c.cardRating = m.cardRating; c.cardGrading = m.cardGrading; }
    }
  }
  base.detailDescription = g.detailDescription;
  base.totalCardCount = g.totalCardCount;
  return base;
}

export async function getDoc(id) {
  const tok = await getToken();
  const r = await fetch(`${FS_BASE}/gacha_entries/${encodeURIComponent(id)}`, { headers: { Authorization: "Bearer " + tok } });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return flat(d);
}

export async function getAll() {
  const tok = await getToken();
  let docs = [], page = "";
  do {
    const r = await fetch(`${FS_BASE}/gacha_entries?pageSize=300${page ? "&pageToken=" + page : ""}`, { headers: { Authorization: "Bearer " + tok } });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    docs.push(...(d.documents || []).map(flat));
    page = d.nextPageToken || "";
  } while (page);
  return docs;
}

export function isActive(g) {
  const now = Date.now();
  if (g.isHidden) return false;
  if (g.endDate && new Date(g.endDate).getTime() < now) return false;
  if (g.startDate && new Date(g.startDate).getTime() > now) return false;
  return true;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// 한 등급의 통계. 등급 잔여=Count−Sold, 총량=Count.
// 모델: Line의 각 항목 = 카드 1장(복사본, 복사본마다 별도 id). 같은 카드는 같은 이름으로 여러 항목 존재.
//   항목 id의 LineDistribution[id] > 0 = 그 장 남음, 0 = 그 장 뽑힘.
//   → 카드명으로 묶어서 총량=장수, 남음=dist>0 인 장수 (예 프리즈매틱 12/15).
//   단일 항목 벌크 등급(A~E·LAST, line=1·Count多)은 그 1종 = Count−Sold / Count.
export function gradeStat(g, gr) {
  const line = Array.isArray(g[gr + "Line"]) ? g[gr + "Line"] : [];
  const dist = g[gr + "LineDistribution"] || {};
  const cnt = g[gr + "Count"] || 0, sold = g[gr + "Sold"] || 0;
  const entries = line.filter(c => c && c.id);
  if (!entries.length && !cnt) return null;
  const gradeRem = cnt - sold, gradeTot = cnt;
  let cards = [];
  if (cnt > 0 && entries.length === cnt) {
    // 각 항목 = 1장. 같은 카드명끼리 묶어 장수 집계.
    const groups = new Map();
    for (const c of entries) {
      const key = (c.name || c.id || "").trim();
      if (!groups.has(key)) groups.set(key, { id: c.id, name: c.name, number: c.number, coinPrice: c.coinPrice, total: 0, remaining: 0 });
      const grp = groups.get(key);
      grp.total++;
      if (Number(dist[c.id] ?? 0) > 0) grp.remaining++;
    }
    cards = [...groups.values()].map(grp => ({ ...grp, soldOut: grp.remaining <= 0 }));
  } else if (entries.length <= 1) {
    // 1종 대량(벌크)
    const c = entries[0] || {};
    cards = [{ id: c.id, name: c.name, number: c.number, coinPrice: c.coinPrice, remaining: gradeRem, total: gradeTot, soldOut: gradeRem <= 0 }];
  } else {
    // 다종 벌크(희귀): 장수 미상 → 이름만
    const seen = new Set();
    for (const c of entries) { if (seen.has(c.id)) continue; seen.add(c.id); cards.push({ id: c.id, name: c.name, number: c.number, coinPrice: c.coinPrice, remaining: null, total: null, soldOut: false }); }
  }
  return { remaining: gradeRem, total: gradeTot, isHit: !!g["isHit" + cap(gr)], cards };
}

// 한 등급의 기대 코인합(잔여 카드 × coinPrice). 잔여/가격 미상 카드는 같은 등급 평균가로 보정.
export function gradeCoins(st) {
  let coins = 0, remCounted = 0;
  const priced = (st.cards || []).filter(c => c && c.coinPrice != null);
  for (const c of st.cards || []) {
    if (c.remaining != null && c.coinPrice != null) { coins += c.remaining * c.coinPrice; remCounted += c.remaining; }
  }
  // 등급 잔여 중 (장수 미상 희귀 등) 집계 안 된 몫은 등급 평균가로 추정
  if (st.remaining > remCounted && priced.length) {
    const avg = priced.reduce((s, c) => s + c.coinPrice, 0) / priced.length;
    coins += (st.remaining - remCounted) * avg;
  }
  return coins;
}

// 1회 기대값. 박스형 = 잔여 전체에서 균등 1장. 기대코인 = Σ(등급 기대코인) / 총잔여.
// 코인≈원(검증된 카드팩 기준). TICKET류·비현실 환원율(>300%)은 원화 환산 보류 플래그.
export function expectedValue(stats, priceOrTicket, category) {
  let coins = 0, rem = 0; const byGrade = {};
  for (const gr of GRADES) {
    const st = stats[gr]; if (!st) continue;
    const c = gradeCoins(st);
    byGrade[gr] = c; coins += c; rem += st.remaining;
  }
  const evCoins = rem ? coins / rem : 0;
  const isTicket = /TICKET/i.test(category || "");
  let rate = (!isTicket && priceOrTicket > 0) ? evCoins / priceOrTicket : null;
  let note = null;                                  // null=정상, 'ticket'=티켓가챠, 'special'=단위확인필요(번들 등)
  if (isTicket) note = "ticket";
  else if (rate != null && rate > 3) note = "special";
  // 라스트원 제외 환원율 (1장짜리 초고가 보너스를 빼고 본 현실 환원율)
  const lastCoins = byGrade.last || 0;
  const lastRem = stats.last ? stats.last.remaining : 0;
  const remNL = rem - lastRem;
  const evCoinsNL = remNL > 0 ? (coins - lastCoins) / remNL : 0;
  const rateNL = (!isTicket && priceOrTicket > 0) ? evCoinsNL / priceOrTicket : null;
  const share = {};
  for (const gr in byGrade) share[gr] = coins ? byGrade[gr] / coins : 0;
  return { evCoins: Math.round(evCoins), priceUnit: isTicket ? "ticket" : "won", returnRate: rate, evNote: note,
    evCoinsNoLast: Math.round(evCoinsNL), returnRateNoLast: rateNL, hasLast: lastRem > 0,
    byGradeCoins: byGrade, byGradeShare: share };
}

// 카드 목록 화면용 요약(등급별 잔여 + 강력추천 + 기대값)
export function summary(g) {
  const grades = {}, stats = {};
  let rem = 0, tot = 0;
  for (const gr of GRADES) {
    const st = gradeStat(g, gr); if (!st) continue;
    stats[gr] = st;
    grades[gr] = { remaining: st.remaining, total: st.total, isHit: st.isHit };
    rem += st.remaining; tot += st.total;
  }
  const ev = expectedValue(stats, g.priceOrTicket, g.category);
  // (강력추천): 개봉률>=90% AND HIT등급(라스트 제외) 상위 5경품 중 '남음'이 1개 이상
  const top5 = [];
  for (const gr of GRADES) {
    if (gr === "last" || !stats[gr] || !stats[gr].isHit) continue;
    for (const c of stats[gr].cards) { top5.push(!c.soldOut); if (top5.length >= 5) break; }
    if (top5.length >= 5) break;
  }
  const openRate = tot ? (tot - rem) / tot : 0;
  const recommend = openRate >= 0.9 && top5.some(a => a);

  return {
    id: g._id, title: g.title, category: g.category, isEventGacha: !!g.isEventGacha,
    priceOrTicket: g.priceOrTicket, purchaseLimitCount: g.purchaseLimitCount,
    startDate: g.startDate, endDate: g.endDate, mainImage: g.mainImage,
    shortDescription: g.shortDescription, grades, rem, tot,
    openRate, recommend,
    evCoins: ev.evCoins, returnRate: ev.returnRate, priceUnit: ev.priceUnit, evNote: ev.evNote,
    returnRateNoLast: ev.returnRateNoLast, evCoinsNoLast: ev.evCoinsNoLast, hasLast: ev.hasLast,
  };
}
