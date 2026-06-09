// GET /api/gachas        -> 활성 가챠 목록(등급별 잔여)
// GET /api/gachas?all=1   -> 숨김/종료 포함 전체
import { getAll, isActive, summary } from "./_lib.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=20");
  try {
    const all = await getAll();
    const list = (req.query.all ? all : all.filter(isActive)).map(summary)
      .filter(g => req.query.all || g.rem > 0)                                // 전부 매진(잔여0) 가챠 제외
      .sort((a, b) => new Date(b.startDate || 0) - new Date(a.startDate || 0)); // 최신 출시 순
    res.status(200).json({ count: list.length, total: all.length, gachas: list, time: Date.now() });
  } catch (e) {
    res.status(502).json({ error: "API_ERROR", message: String(e?.message || e) });
  }
}
