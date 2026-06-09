// GET /api/gacha?id=<docId>  -> 가챠 상세 (등급 → 개별 카드별 잔여)
import { getDoc, buildDetail } from "./_lib.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=20");
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "id required" });
  try {
    const g = await getDoc(id);
    const detail = await buildDetail(g);
    res.status(200).json({ gacha: detail, time: Date.now() });
  } catch (e) {
    res.status(502).json({ error: "API_ERROR", message: String(e?.message || e) });
  }
}
