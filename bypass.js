// Vercel serverless function — Node.js runtime
// Node 18+ trên Vercel có fetch global + Buffer. Không cần dependency ngoài.

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
  Referer: "https://link4m.co/",
};

const RE_WINDOW_LOC = /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i;
const RE_VAR_URL =
  /(?:var|let|const)\s+(?:url|link|target|dest|_url)\s*=\s*["']([^"']+)["']/i;
const RE_META_REFRESH =
  /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^;]+;\s*url=([^"']+)["']/i;
const RE_B64 = /(?:atob|decodeURIComponent)\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/;
const RE_RAW_URL = /https?:\/\/[^\s"'<>\\]+/g;

const BAD_DOMAINS = [
  "link4m.", "link4m.co", "google.", "gstatic.", "doubleclick.",
  "facebook.", "cloudflare.", "googleapis.", "ads", "banner",
];

function clean(url) {
  return url.trim().replace(/&amp;/g, "&");
}

function isGood(url) {
  if (!url || !url.startsWith("http")) return false;
  const low = url.toLowerCase();
  return !BAD_DOMAINS.some((b) => low.includes(b));
}

function extractFromHtml(html) {
  let m = html.match(RE_WINDOW_LOC);
  if (m && isGood(clean(m[1]))) return clean(m[1]);

  m = html.match(RE_VAR_URL);
  if (m && isGood(clean(m[1]))) return clean(m[1]);

  m = html.match(RE_META_REFRESH);
  if (m && isGood(clean(m[1]))) return clean(m[1]);

  m = html.match(RE_B64);
  if (m) {
    try {
      const decoded = Buffer.from(m[1], "base64").toString("utf-8");
      if (isGood(decoded)) return decoded;
    } catch { /* ignore */ }
  }

  const raws = html.match(RE_RAW_URL) || [];
  for (const raw of raws) {
    if (isGood(clean(raw))) return clean(raw);
  }
  return null;
}

function extractToken(html) {
  const data = { _method: "POST", adType: "", adUrl: "" };

  // quét <input name="..." value="...">
  const inputRe = /<input\b[^>]*>/gi;
  const inputs = html.match(inputRe) || [];
  for (const tag of inputs) {
    const nameM = tag.match(/\bname\s*=\s*["']([^"']+)["']/i);
    const valM = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i);
    if (!nameM) continue;
    const name = nameM[1];
    const val = valM ? valM[1] : "";
    if (name === "_token" || name === "token" || name === "hash") {
      data["_token"] = val;
    } else if (name === "adType") {
      data["adType"] = val;
    } else if (name === "adUrl") {
      data["adUrl"] = val;
    }
  }

  // dò trong script nếu form không có
  const tm = html.match(/_token\s*[:=]\s*["']([^"']+)["']/);
  if (tm && !data["_token"]) data["_token"] = tm[1];

  return data;
}

async function timedFetch(input, init, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function bypass(url) {
  if (!url.includes("link4m.")) {
    throw new Error("URL không phải link4m.");
  }

  let r;
  try {
    r = await timedFetch(url, {
      method: "GET",
      headers: DEFAULT_HEADERS,
      redirect: "follow",
    });
  } catch (e) {
    throw new Error(`Không request được: ${e.message}`);
  }

  const html1 = await r.text();
  const hit1 = extractFromHtml(html1);
  if (hit1) return { original: hit1, method: "html-parse", final_url: r.url };

  const tokenData = extractToken(html1);
  if (tokenData["_token"]) {
    const goUrl = "https://link4m.co/links/go";
    const body = new URLSearchParams(tokenData).toString();
    try {
      const r2 = await timedFetch(goUrl, {
        method: "POST",
        headers: {
          ...DEFAULT_HEADERS,
          "X-Requested-With": "XMLHttpRequest",
          Origin: "https://link4m.co",
          Referer: r.url,
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body,
        redirect: "follow",
      });

      const text2 = await r2.text();
      try {
        const j = JSON.parse(text2);
        const target = j.url || j.link || j.target;
        if (target && isGood(target)) {
          return { original: target, method: "links-go-api", final_url: r2.url };
        }
      } catch { /* not json */ }

      const hit2 = extractFromHtml(text2);
      if (hit2) {
        return { original: hit2, method: "links-go-html", final_url: r2.url };
      }
    } catch { /* fallthrough */ }
  }

  for (const param of ["?get=true", "?go=1", "?short=1"]) {
    try {
      const r3 = await timedFetch(r.url + param, {
        method: "GET",
        headers: DEFAULT_HEADERS,
        redirect: "follow",
      });
      const html3 = await r3.text();
      const hit3 = extractFromHtml(html3);
      if (hit3) {
        return { original: hit3, method: `get${param}`, final_url: r3.url };
      }
    } catch { /* continue */ }
  }

  if (isGood(r.url) && !r.url.includes("link4m.")) {
    return { original: r.url, method: "final-redirect", final_url: r.url };
  }

  throw new Error("Không trích được link gốc. link4m có thể đã đổi cấu trúc.");
}

// ---- Vercel handler ----
module.exports = async function handler(req, res) {
  // CORS cho phép gọi từ domain khác nếu muốn
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method === "GET") {
    res.status(200).json({ ok: true, endpoint: "/api/bypass", method: "POST" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ detail: "Chỉ hỗ trợ POST." });
    return;
  }

  // Vercel tự parse body JSON nếu Content-Type: application/json
  const body = req.body || {};
  const url = (body.url || "").toString().trim();

  if (!url) {
    res.status(400).json({ detail: "Thiếu trường 'url'." });
    return;
  }

  try {
    const result = await bypass(url);
    res.status(200).json(result);
  } catch (e) {
    res.status(400).json({ detail: e.message || "Lỗi không xác định." });
  }
};
