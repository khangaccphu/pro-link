// Vercel serverless function
// Bypass link4m.net (flow: get-advertise → check-captcha)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

const CAPSOLVER_KEY = process.env.CAPSOLVER_KEY || ""; // set trong Vercel env

function parseAttrs(html) {
  const aliasM = html.match(/data-alias\s*=\s*["']([^"']+)["']/);
  const codeM = html.match(/data-code\s*=\s*["']([^"']+)["']/);
  const apiM = html.match(/api_domain\s*=\s*['"]([^'"]+)['"]/);
  const sitekeyM = html.match(/recaptcha_key\s*=\s*['"]([^'"]+)['"]/);
  return {
    alias: aliasM?.[1] || null,
    code: codeM?.[1] || null,
    apiDomain: apiM?.[1] || "https://s1.link4m.app",
    sitekey: sitekeyM?.[1] || "6LcQsTQgAAAAADNQ_pCfukfvS0i9lk4oJTVSs5bZ",
  };
}

async function getAdvertise(apiDomain, alias, code, cookies) {
  const r = await fetch(`${apiDomain}/api/campaign/get-advertise`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Origin: "https://link4m.net",
      Referer: "https://link4m.net/",
      Cookie: cookies || "",
    },
    body: new URLSearchParams({ alias, codes: code }).toString(),
  });
  if (!r.ok) throw new Error(`get-advertise HTTP ${r.status}`);
  return r.json();
}

async function solveRecaptcha(sitekey, pageUrl, proxy) {
  if (!CAPSOLVER_KEY) throw new Error("Chưa set CAPSOLVER_KEY");

  const task = {
    type: proxy ? "ReCaptchaV2Task" : "ReCaptchaV2TaskProxyLess",
    websiteURL: pageUrl,
    websiteKey: sitekey,
  };
  if (proxy) task.proxy = proxy;

  const create = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: CAPSOLVER_KEY, task }),
  }).then((r) => r.json());

  if (!create.taskId) throw new Error(`CapSolver tạo task fail: ${JSON.stringify(create)}`);

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId: create.taskId }),
    }).then((r) => r.json());

    if (res.status === "ready") {
      return res.solution.gRecaptchaResponse || res.solution.token;
    }
    if (res.errorId) throw new Error(`CapSolver error: ${JSON.stringify(res)}`);
  }
  throw new Error("CapSolver timeout");
}

async function checkCaptcha(apiDomain, alias, code, token, cookies) {
  const r = await fetch(`${apiDomain}/links/check-captcha`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Origin: "https://link4m.net",
      Referer: `https://link4m.net/go/${alias}`,
      Cookie: cookies || "",
    },
    body: new URLSearchParams({
      alias,
      code,
      "g-recaptcha-response": token,
    }).toString(),
  });
  if (!r.ok) throw new Error(`check-captcha HTTP ${r.status}`);
  return r.json();
}

function setCookiesFromResponse(r) {
  // gom set-cookie thành 1 string
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  return sc.map((c) => c.split(";")[0]).join("; ");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET")
    return res.json({ ok: true, endpoint: "POST /api/bypass", body: { url: "..." } });
  if (req.method !== "POST") return res.status(405).json({ detail: "Chỉ POST." });

  const body = req.body || {};
  const url = (body.url || "").toString().trim();
  const proxy = (body.proxy || "").toString().trim(); // tuỳ chọn

  if (!/^https?:\/\/link4m\.(net|com|co)\//.test(url)) {
    return res.status(400).json({ detail: "Chỉ hỗ trợ link4m.net/.com/.co" });
  }

  try {
    // 1. GET page gốc
    const r1 = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });
    if (!r1.ok) throw new Error(`GET page HTTP ${r1.status}`);
    const html1 = await r1.text();
    const cookies = setCookiesFromResponse(r1);
    const { alias, code, apiDomain, sitekey } = parseAttrs(html1);

    if (!alias || !code) {
      // có thể link đã trả luôn
      const direct = html1.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/);
      if (direct && !direct[1].includes("link4m.")) {
        return res.json({ original: direct[1], method: "direct-html", final_url: url });
      }
      throw new Error("Không tìm thấy alias/code trong HTML.");
    }

    // 2. get-advertise
    const adv = await getAdvertise(apiDomain, alias, code, cookies);

    // nếu có window_url → đó là link gốc luôn
    if (adv.window_url && !/link4m\./.test(adv.window_url)) {
      return res.json({
        original: adv.window_url,
        method: "get-advertise-window-url",
        final_url: url,
      });
    }

    // nếu adv.html chứa link gốc (không cần captcha)
    if (adv.html) {
      const m = adv.html.match(/href\s*=\s*["'](https?:\/\/[^"']+)["']/);
      if (m && !/link4m\./.test(m[1])) {
        return res.json({ original: m[1], method: "advertise-html", final_url: url });
      }
    }

    // 3. cần captcha → solve
    if (!CAPSOLVER_KEY) {
      throw new Error(
        "Server yêu cầu captcha. Cần set CAPSOLVER_KEY trên Vercel để bypass tự động."
      );
    }

    const token = await solveRecaptcha(
      sitekey,
      `https://link4m.net/go/${alias}`,
      proxy || null
    );

    // 4. check-captcha
    const check = await checkCaptcha(apiDomain, alias, code, token, cookies);

    if (check.success && check.url && !/link4m\./.test(check.url)) {
      return res.json({
        original: check.url,
        method: "captcha-solved",
        final_url: url,
      });
    }

    if (check.html) {
      const m = check.html.match(/href\s*=\s*["'](https?:\/\/[^"']+)["']/);
      if (m && !/link4m\./.test(m[1])) {
        return res.json({ original: m[1], method: "captcha-html", final_url: url });
      }
    }

    throw new Error(`Không trích được link. Response: ${JSON.stringify(check).slice(0, 300)}`);
  } catch (e) {
    res.status(400).json({ detail: e.message || "Lỗi không xác định" });
  }
}
