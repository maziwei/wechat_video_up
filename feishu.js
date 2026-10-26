/* 视频号发布助手 · 飞书多维表格同步（v2.9.0：只同步当前账号 + 粉丝表自动补行）
 *
 * 为什么放在 background：
 *   content script 里的 fetch 受「当前网页」的跨域限制，飞书 API 不返回 CORS 头，
 *   直接调必被浏览器拦掉。background（service worker）有 host_permissions，
 *   相当于扩展自己的网络层，不受页面跨域限制。
 *
 * 同步口径（用户确认，v2.9.0 起按「一个号一次」）：
 *   实际用法：登录A → 读取最新数据 → 同步飞书 → 退出 → 登录B → 读取 → 同步 …
 *   所以每次只写「当前登录的这个账号」（opts.account），不再把本机存过的所有账号
 *   一起重写一遍——那会把别的账号的正确数据用旧快照覆盖掉。
 *
 *  ① 浏览量及留资信息表（列：发布日期 / 视频名称 / 帐户名 / 新增浏览量 /
 *     累计浏览量 / 视频关注量 / 当日客资量 / 当日新增客资信息 / 备注）
 *     · 用「帐户名」+「视频名称」定位那一行；
 *     · 昨天或今天发布的视频 → 播放量写入「新增浏览量」；
 *     · 更早发布的视频       → 播放量写入「累计浏览量」；
 *     · 关注量始终写入该行的「视频关注量」列；
 *     · 数值直接覆盖（页面给的播放量本身就是累计值，再累加会翻倍）；
 *     · 表里找不到对应行 → 不新建，跳过并在结果里列出来；
 *     · 客资三列（当日客资量 / 当日新增客资信息 / 备注）没有数据源，不写。
 *
 *  ② 粉丝数据表（列：日期 / 帐号名 / 当日新增 / 当日净增 / 粉丝总数）
 *     · 关注者数据页上的新增 / 净增是「昨日」口径 → 行日期 = 读取当天 - 1 天；
 *     · 用「帐号名」+「日期」定位那一行；
 *     · 当日新增 ← 新增关注，当日净增 ← 净增关注，粉丝总数 ← 关注者总数；
 *     · 没有这一行 → **自动新建一行**（日期 + 帐号名 + 三个数值一次写全）；
 *     · 粉丝数据不是今天/昨天读的 → 跳过，避免把旧快照写到错误的日期上。
 */

/* eslint-disable no-unused-vars */
const FEISHU = (() => {
  const BASE = "https://open.feishu.cn/open-apis";
  const CFG_KEY = "wxch_feishu";
  const STATS_KEY = "wxch_stats_v2";
  const PAGE = 500;

  /* ---------------- 基础工具 ---------------- */

  function storeGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (r) => resolve(r || {}));
      } catch (e) {
        resolve({});
      }
    });
  }

  class FeishuError extends Error {}

  function apiError(where, payload) {
    const code = payload && payload.code;
    const msg = (payload && (payload.msg || payload.message)) || "";
    let hint = "";
    if (/tenant_access_token/.test(String(where))) hint = "（App ID 或 App Secret 不对）";
    else if (code === 99991663 || code === 99991661 || code === 99991664) hint = "（应用凭证或权限不足）";
    else if (code === 91402) hint = "（找不到多维表格：App Token / Table ID 不对，或应用没被加进这张表）";
    else if (code === 91403) hint = "（没有这张表的编辑权限：在表格「···」→ 添加文档应用）";
    else if (code === 10003 || code === 1254005) hint = "（字段名或字段类型不匹配）";
    const err = new FeishuError(`${where}失败：${code} ${msg}${hint}`);
    err.code = code;
    return err;
  }

  async function request(path, opts) {
    const o = opts || {};
    const headers = Object.assign(
      { "Content-Type": "application/json; charset=utf-8" },
      o.token ? { Authorization: "Bearer " + o.token } : {},
      o.headers || {}
    );
    let res;
    try {
      res = await fetch(BASE + path, {
        method: o.method || "GET",
        headers,
        body: o.body == null ? undefined : JSON.stringify(o.body),
      });
    } catch (e) {
      throw new FeishuError("网络请求失败：" + (e && e.message ? e.message : e) + "（检查网络/代理）");
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      throw new FeishuError("飞书返回的不是 JSON（HTTP " + res.status + "）");
    }
    if (data && data.code !== 0) throw apiError(o.where || path, data);
    return data;
  }

  /* ---------------- 凭证 & 配置 ---------------- */

  let tokenCache = { key: "", token: "", exp: 0 };

  async function getToken(appId, appSecret, force) {
    const key = appId + "|" + appSecret;
    if (!force && tokenCache.key === key && tokenCache.token && Date.now() < tokenCache.exp) {
      return tokenCache.token;
    }
    const data = await request("/auth/v3/tenant_access_token/internal", {
      method: "POST",
      body: { app_id: appId, app_secret: appSecret },
      where: "获取 tenant_access_token",
    });
    if (!data.tenant_access_token) throw new FeishuError("凭证无效：飞书没有返回 access token");
    tokenCache = {
      key,
      token: data.tenant_access_token,
      exp: Date.now() + Math.max(60, (data.expire || 7200) - 120) * 1000,
    };
    return tokenCache.token;
  }

  /** 从多维表格链接里解析 appToken / tableId
   *  https://xxx.feishu.cn/base/你的baseToken?table=tbl你的表ID
   */
  function parseUrl(url) {
    const s = String(url || "").trim();
    const out = { appToken: "", tableId: "", domain: "feishu.cn" };
    const mApp = s.match(/\/base\/([A-Za-z0-9]+)/);
    if (mApp) out.appToken = mApp[1];
    const mTbl = s.match(/[?&]table=([A-Za-z0-9]+)/);
    if (mTbl) out.tableId = mTbl[1];
    if (/larksuite\.com|feishu\.sg/i.test(s)) out.domain = "larksuite";
    return out;
  }

  async function loadCfg() {
    const r = await storeGet([CFG_KEY]);
    const cfg = r[CFG_KEY] || {};
    const u1 = parseUrl(cfg.url || "");
    const u2 = parseUrl(cfg.fanUrl || "");
    const appToken = String(cfg.appToken || u1.appToken || "").trim();
    return {
      appId: String(cfg.appId || "").trim(),
      appSecret: String(cfg.appSecret || "").trim(),
      url: cfg.url || "",
      appToken,
      tableId: String(cfg.tableId || u1.tableId || "").trim(),
      fanUrl: cfg.fanUrl || "",
      // 粉丝表通常和浏览量表在同一个多维表格里，appToken 可直接沿用
      fanAppToken: String(cfg.fanAppToken || u2.appToken || appToken || "").trim(),
      fanTableId: String(cfg.fanTableId || u2.tableId || "").trim(),
    };
  }

  function cfgProblem(cfg) {
    if (!cfg.appId) return "还没填飞书 App ID";
    if (!cfg.appSecret) return "还没填飞书 App Secret";
    if (!cfg.appToken) return "还没填多维表格链接（或 App Token）";
    if (!cfg.tableId) return "链接里没有 table=xxx，请复制带 table 参数的地址";
    return "";
  }

  /* ---------------- 表结构读取 ---------------- */

  async function listFields(token, appToken, tableId) {
    const out = [];
    let pageToken = "";
    for (let i = 0; i < 20; i++) {
      const q = `?page_size=100${pageToken ? "&page_token=" + encodeURIComponent(pageToken) : ""}`;
      const data = await request(
        `/bitable/v1/apps/${appToken}/tables/${tableId}/fields${q}`,
        { token, where: "读取字段列表" }
      );
      const items = (data && data.data && data.data.items) || [];
      out.push.apply(out, items);
      if (!data.data || !data.data.has_more || !data.data.page_token) break;
      pageToken = data.data.page_token;
    }
    return out;
  }

  async function listRecords(token, appToken, tableId) {
    const out = [];
    let pageToken = "";
    for (let i = 0; i < 200; i++) {
      const q = `?page_size=${PAGE}${pageToken ? "&page_token=" + encodeURIComponent(pageToken) : ""}`;
      const data = await request(
        `/bitable/v1/apps/${appToken}/tables/${tableId}/records${q}`,
        { token, where: "读取表格记录" }
      );
      const items = (data && data.data && data.data.items) || [];
      out.push.apply(out, items);
      if (!data.data || !data.data.has_more || !data.data.page_token) break;
      pageToken = data.data.page_token;
    }
    return out;
  }

  /* ---------------- 字段识别 ---------------- */

  function pickField(fields, patterns, bad) {
    for (const re of patterns) {
      const hit = fields.find((f) => re.test(String(f.field_name || "")) && !(bad && bad.test(String(f.field_name || ""))));
      if (hit) return hit;
    }
    return null;
  }

  /* 「帐户名 / 帐号名 / 账号名」三种写法都常见，统一认 */
  const ACC_STRICT = /^(账号|帐号|账户|帐户|账号名|帐号名|账户名|帐户名|账号名称|帐号名称|账户名称|帐户名称|视频号|视频号名称)$/;
  const ACC_LOOSE = /账号|帐号|账户|帐户|视频号/;
  const ACC_BAD = /视频名称|视频标题|作品|浏览|播放|关注|粉丝|日期|时间/;

  /** 浏览量及留资信息表：发布日期 / 视频名称 / 帐户名 / 新增浏览量 / 累计浏览量 / 视频关注量 */
  function mapVideoFields(fields) {
    const fAcc = pickField(fields, [ACC_STRICT, ACC_LOOSE], ACC_BAD);
    const fVideo = pickField(
      fields,
      [
        /^(视频名称|视频标题|作品名称|作品标题|视频|标题)$/,
        /视频名称|视频标题|作品名称|作品标题/,
        /标题/,
        /名称/,
      ],
      /账号|帐号|账户|帐户|浏览|播放|关注|粉丝|日期|时间/
    );
    const fDate = pickField(
      fields,
      [/^(发布日期|发布日|发布时间|日期)$/, /发布日期|发布日/],
      /新增|累计|浏览|播放|关注|客资/
    );
    const fNew = pickField(
      fields,
      [
        /新增.*(浏览量?|播放量?|观看)/,
        /(浏览量?|播放量?|观看).*新增/,
        /(当日|今日|当天|昨日|昨天).*(浏览|播放|观看)/,
      ],
      /累计|总量|总浏览|总播放|率/
    );
    const fTotal = pickField(
      fields,
      [
        /累计.*(浏览量?|播放量?|观看)/,
        /(浏览量?|播放量?|观看).*累计/,
        /总(浏览量?|播放量?|观看量?)/,
        /历史.*(浏览|播放|观看)/,
      ],
      /率/
    );
    const fFollow = pickField(
      fields,
      [
        /^(视频关注量|关注量?|关注数|新增关注|涨粉|涨粉数|涨粉量)$/,
        /视频关注/,
        /关注|涨粉|粉丝/,
      ],
      /率|取消|取关|总关注|粉丝总数/
    );
    // 兜底：表里只有一个笼统的「浏览量 / 播放量」列时，新增和累计都写它
    const fView = pickField(
      fields,
      [/^(浏览量?|播放量?|观看量?|浏览数|播放数|观看数)$/, /^(浏览|播放|观看)/],
      /率|时长|均|累计|新增|总|昨日|今日/
    );
    return { fAcc, fVideo, fDate, fNew, fTotal, fFollow, fView };
  }

  /** 粉丝数据表：日期 / 帐号名 / 当日新增 / 当日净增 / 粉丝总数 */
  function mapFanFields(fields) {
    const fDate = pickField(
      fields,
      [/^(日期|数据日期|统计日期|日)$/, /^(日期|时间)$/, /日期/],
      /新增|净增|粉丝|关注|帐号|账号|帐户|账户/
    );
    const fAcc = pickField(fields, [ACC_STRICT, ACC_LOOSE], ACC_BAD);
    const fNewAdd = pickField(
      fields,
      [/^(当日新增|今日新增|新增关注|新增粉丝|新增关注数|新增粉丝数|新增)$/, /新增(关注|粉丝)/, /新增/],
      /净增|总数|累计|客资|率/
    );
    const fNetAdd = pickField(
      fields,
      [/^(当日净增|今日净增|净增关注|净增粉丝|净增关注数|净增)$/, /净增/],
      /总数|累计|率/
    );
    const fFans = pickField(
      fields,
      [/^(粉丝总数|关注者总数|总粉丝数|粉丝数|总关注数|总关注者|关注人数)$/, /粉丝总数|关注者总数|总粉丝/],
      /新增|净增|率/
    );
    return { fDate, fAcc, fNewAdd, fNetAdd, fFans };
  }

  /** 字段能不能写（公式 / 查找引用 / 创建时间这类是只读的） */
  function writable(field) {
    if (!field) return false;
    const t = Number(field.type);
    return ![19, 20, 1001, 1002, 1003, 1004, 1005].includes(t);
  }

  /** 按字段类型装箱：数字字段必须是 number，文本字段必须是 string */
  function pack(field, num) {
    const t = Number(field.type);
    if (t === 2 || t === 1005) return Number(num);
    if (t === 5) return Number(num); // 日期按毫秒时间戳
    return String(num);
  }

  /** 日期字段装箱：日期类型给毫秒时间戳，文本/单选给 2026-10-17 */
  function packDate(field, ts) {
    const t = Number(field && field.type);
    if (t === 5 || t === 2 || t === 1005) return Number(ts);
    return ymd(ts);
  }

  /** 文本字段装箱：多选要给数组 */
  function packText(field, s) {
    const v = String(s == null ? "" : s);
    return Number(field && field.type) === 4 ? [v] : v;
  }

  /* ---------------- 文本 / 数值 / 日期 ---------------- */

  function textOf(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return v.map(textOf).join("");
    if (typeof v === "object") {
      const cand = [v.text, v.name, v.link, v.en_name, v.value];
      for (const c of cand) {
        const s = textOf(c);
        if (s) return s;
      }
      return "";
    }
    return String(v);
  }

  /** 视频标题规范化：去空白 / 去话题 / 去标点，用于跨页比对
   *  统计页的标题被截断成 40 字，评论页带话题，飞书里可能只写了正文
   */
  function normTitle(s) {
    return String(s || "")
      .replace(/[\u200b-\u200f\uFEFF]/g, "")
      .replace(/#[^#\s]+/g, "")
      .replace(/#+/g, "")
      .replace(/\s+/g, "")
      .replace(/[·•\-—_|,，。.、:：;；!！?？'"“”‘’()（）\[\]【】<>《》]/g, "")
      .toLowerCase();
  }

  function normAcc(s) {
    return String(s || "").replace(/\s+/g, "").toLowerCase();
  }

  /** 数值解析：支持 1,234 / 1.2万 / +7 / 全角负号 / "3.5w"
   *  时长（00:15、15秒）一律返回 null——统计页取错列时别把时长当播放量写进去
   */
  function numOf(v) {
    if (typeof v === "number") return isFinite(v) ? Math.round(v) : null;
    let s = String(v == null ? "" : v).replace(/[\s,]/g, "").replace(/[−－]/g, "-");
    if (!s || s === "-" || s === "--") return null;
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return null;          // 00:15
    if (/^\d+(\.\d+)?(秒|s|min|分)$/i.test(s)) return null;        // 15秒 / 1.5分
    const m = s.match(/^([+-]?\d+(?:\.\d+)?)(万|w|W|k|K)?$/);
    if (!m) {
      const m2 = s.match(/([+-]?\d+(?:\.\d+)?)(万|w|W)?/);
      if (!m2) return null;
      let n2 = parseFloat(m2[1]);
      if (m2[2]) n2 *= 10000;
      return Math.round(n2);
    }
    let n = parseFloat(m[1]);
    const u = m[2] || "";
    if (u === "万" || u === "w" || u === "W") n *= 10000;
    else if (u === "k" || u === "K") n *= 1000;
    return Math.round(n);
  }

  function startOfDay(ts) {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  /** 统计页的发布日期 → 当天 0 点的时间戳（认不出返回 null） */
  function dateOf(s, nowTs) {
    const now = nowTs || Date.now();
    const t = String(s || "").replace(/\s+/g, "");
    if (!t) return null;
    if (/^(今天|今日)/.test(t)) return startOfDay(now);
    if (/^(昨天|昨日)/.test(t)) return startOfDay(now) - 864e5;
    if (/^前天/.test(t)) return startOfDay(now) - 2 * 864e5;
    let m = t.match(/(\d{4})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/);
    if (m) {
      const y = +m[1], mo = +m[2] - 1, d = +m[3];
      if (mo >= 0 && mo <= 11 && d >= 1 && d <= 31) return new Date(y, mo, d).getTime();
    }
    m = t.match(/^(\d{1,2})[-\/月.](\d{1,2})/);
    if (m) {
      const mo = +m[1] - 1, d = +m[2];
      if (mo >= 0 && mo <= 11 && d >= 1 && d <= 31) {
        let dt = new Date(new Date(now).getFullYear(), mo, d);
        // 列表里没有年份：算出来明显在未来 → 一定是去年的
        if (dt.getTime() - startOfDay(now) > 864e5) {
          dt = new Date(new Date(now).getFullYear() - 1, mo, d);
        }
        return dt.getTime();
      }
    }
    return null;
  }

  /** 表里「日期」字段 → 当天 0 点时间戳（兼容日期字段的毫秒时间戳与各种文本写法） */
  function dayTsOf(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return isFinite(v) ? startOfDay(v < 1e12 ? v * 1000 : v) : null;
    const s = textOf(v).trim();
    if (!s) return null;
    if (/^\d{10,13}$/.test(s)) {
      const n = Number(s);
      return startOfDay(n < 1e12 ? n * 1000 : n);
    }
    const m = s.match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    const m2 = s.match(/(\d{1,2})[-\/月.](\d{1,2})/);
    if (m2) {
      const now = new Date();
      return new Date(now.getFullYear(), +m2[1] - 1, +m2[2]).getTime();
    }
    return null;
  }

  function ymd(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  /* ---------------- 匹配 ---------------- */

  function buildIndex(records, m) {
    const byTitle = new Map();   // normTitle -> [rec]
    const list = [];
    for (const rec of records) {
      const f = rec.fields || {};
      const acc = m.fAcc ? normAcc(textOf(f[m.fAcc.field_name])) : "";
      const title = m.fVideo ? normTitle(textOf(f[m.fVideo.field_name])) : "";
      const item = { rec, acc, title, id: rec.record_id, fields: f };
      list.push(item);
      if (title) {
        if (!byTitle.has(title)) byTitle.set(title, []);
        byTitle.get(title).push(item);
      }
    }
    return { list, byTitle };
  }

  /** 在一个账号范围内找视频行：先精确、再前缀（统计页标题被截断到 40 字）
   *  账号列写法不一致（如"金老师通关助手(视频号)"）时，退回全表按标题唯一匹配，
   *  避免因为一个后缀就整批匹配不上。
   */
  function findRow(idx, acc, title) {
    const nt = normTitle(title);
    if (!nt) return { row: null, why: "标题为空" };
    let scope = acc ? idx.list.filter((x) => x.acc === acc) : idx.list;
    let loose = "";
    if (acc && !scope.length) {
      scope = idx.list;
      loose = "账号列写法不同，按标题全表匹配";
    }
    if (!scope.length) return { row: null, why: "表里没有记录" };

    const exact = scope.filter((x) => x.title === nt);
    if (exact.length === 1) return { row: exact[0], how: loose || "精确" };
    if (exact.length > 1) return { row: exact[0], how: "精确(多条取第一条)" };

    // 页面标题最长 40 字，表里可能是完整标题 → 前缀匹配
    if (nt.length >= 6) {
      const pre = scope.filter((x) => x.title && (x.title.startsWith(nt) || nt.startsWith(x.title)));
      if (pre.length === 1) return { row: pre[0], how: loose || "前缀" };
      if (pre.length > 1) {
        // 多个候选取长度最接近的
        pre.sort((a, b) => Math.abs(a.title.length - nt.length) - Math.abs(b.title.length - nt.length));
        return { row: pre[0], how: "前缀(多条取最接近)" };
      }
    }
    return { row: null, why: acc ? "该账号下没有这个视频名称" : "没有这个视频名称" };
  }

  /** 粉丝表：按「帐号名 + 日期」找行 */
  function findFanRow(records, m, acc, dayTs) {
    const cands = records.filter((rec) => {
      const f = rec.fields || {};
      const a = m.fAcc ? normAcc(textOf(f[m.fAcc.field_name])) : "";
      if (a !== acc) return false;
      return dayTsOf((f[m.fDate.field_name])) === dayTs;
    });
    return cands[0] || null;
  }

  /* ---------------- 主流程 ---------------- */

  /** token 过期（99991663）时清缓存重跑一次，别让用户看到一句看不懂的报错 */
  async function withTokenRetry(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e && (e.code === 99991663 || e.code === 99991661)) {
        tokenCache = { key: "", token: "", exp: 0 };
        return await fn();
      }
      throw e;
    }
  }

  async function sync(opts) {
    return withTokenRetry(() => syncBody(opts));
  }

  async function syncBody(opts) {
    const t0 = Date.now();
    const cfg = await loadCfg();
    const bad = cfgProblem(cfg);
    if (bad) return { ok: false, message: bad, needSetup: true };

    const token = await getToken(cfg.appId, cfg.appSecret);

    const store = await storeGet([STATS_KEY]);
    const all = store[STATS_KEY] || {};
    // ★ v2.9.0：默认只同步「当前登录的这个账号」。
    //   使用流程是 登录A→查询→同步→退出→登录B→查询→同步，
    //   以前不带账号会把本机所有历史账号的旧快照一起重写一遍，把正确数据冲掉。
    const want = String((opts && opts.account) || "").trim();
    let only;
    if (want) {
      const hitKey = all[want]
        ? want
        : Object.keys(all).find((k) => normAcc(k) === normAcc(want)) || "";
      if (!hitKey) {
        return {
          ok: false,
          accounts: [],
          message: `本机还没有「${want}」的数据，先点「读取最新数据」再同步`,
        };
      }
      only = [hitKey];
    } else {
      // 没传账号（例如老版本页面还开着）才退回全部，并过滤掉没识别到账号名的
      only = Object.keys(all).filter((k) => k && k !== "未知账号");
    }

    const now = Date.now();
    const out = {
      ok: true,
      video: null,
      fans: null,
      accounts: only.map((n) => {
        const s = all[n] || {};
        return {
          name: n,
          videos: Array.isArray(s.videos) ? s.videos.length : 0,
          hasFans: s.fansTotal != null || s.newAdd != null || s.netAdd != null,
          readAt: (s.readAt && s.readAt.post) || s.updatedAt || 0,
        };
      }),
      costMs: 0,
    };
    const errs = [];

    try {
      out.video = await syncVideoTable(cfg, token, all, only, now);
    } catch (e) {
      out.video = { ok: false, message: e.message || String(e), updated: 0, total: 0, skipped: [], skippedCount: 0 };
      errs.push("浏览量表：" + (e.message || e));
    }

    if (cfg.fanTableId) {
      try {
        out.fans = await syncFanTable(cfg, token, all, only, now);
      } catch (e) {
        out.fans = { ok: false, message: e.message || String(e), updated: 0, total: 0, skipped: [], skippedCount: 0 };
        errs.push("粉丝表：" + (e.message || e));
      }
    }

    const v = out.video || { updated: 0, total: 0, skipped: [], skippedCount: 0 };
    const f = out.fans || { updated: 0, total: 0, skipped: [], skippedCount: 0 };
    const skipped = [].concat(v.skipped || [], f.skipped || []);

    out.updated = (v.updated || 0) + (f.updated || 0) + (f.created || 0);
    out.total = (v.total || 0) + (f.total || 0);
    out.skipped = skipped.slice(0, 30);
    out.skippedCount = (v.skippedCount || 0) + (f.skippedCount || 0);
    out.fields = (v.fields || null);
    out.fanFields = (f.fields || null);
    out.perAcc = Object.assign({}, v.perAcc || {}, f.perAcc || {});
    out.samples = (v.samples || []).concat(f.samples || []).slice(0, 8);
    out.costMs = Date.now() - t0;
    out.message = errs.join("；") ||
      (out.updated ? "" : "没有可同步的数据");
    out.ok = errs.length === 0 && out.updated > 0;
    return out;
  }

  /* ---------- ① 浏览量及留资信息表 ---------- */

  async function syncVideoTable(cfg, token, all, only, now) {
    const fields = await listFields(token, cfg.appToken, cfg.tableId);
    if (!fields.length) throw new FeishuError("这张表没有任何字段，检查 Table ID 是否正确");
    const m = mapVideoFields(fields);
    if (!m.fVideo) {
      throw new FeishuError("没认出「视频名称」列。表里的字段是：" + fields.map((f) => f.field_name).join(" / "));
    }

    const records = await listRecords(token, cfg.appToken, cfg.tableId);
    const idx = buildIndex(records, m);

    const yesterday = startOfDay(now) - 864e5; // 昨天 00:00
    const updates = [];
    const skipped = [];
    const perAcc = {};

    for (const accName of only) {
      const s = all[accName] || {};
      const vids = Array.isArray(s.videos) ? s.videos : [];
      if (!vids.length) continue;

      const acc = normAcc(accName);
      for (const v of vids) {
        const play = numOf(v.play);
        const follow = numOf(v.follow);
        if (play == null && follow == null) {
          skipped.push({ table: "浏览量", acc: accName, title: v.title, date: v.date, reason: "播放量和关注量都没有数字" });
          continue;
        }
        const dts = dateOf(v.date, now);
        const isNew = dts != null && dts >= yesterday;
        // 优先用分列的新增/累计；表里只有一个笼统「浏览量」列时两边都写它
        const target = isNew ? (m.fNew || m.fView) : (m.fTotal || m.fView);

        const hit = findRow(idx, acc, v.title);
        if (!hit.row) {
          skipped.push({ table: "浏览量", acc: accName, title: v.title, date: v.date, reason: hit.why });
          continue;
        }

        const f = {};
        if (play != null && target && writable(target)) f[target.field_name] = pack(target, play);
        if (follow != null && m.fFollow && writable(m.fFollow)) f[m.fFollow.field_name] = pack(m.fFollow, follow);
        if (!Object.keys(f).length) {
          let why;
          if (play != null && !target) why = isNew ? "表里没有「新增浏览量」列" : "表里没有「累计浏览量」列";
          else why = "目标列是公式/查找引用，写不进去";
          skipped.push({ table: "浏览量", acc: accName, title: v.title, date: v.date, reason: why });
          continue;
        }

        updates.push({
          record_id: hit.row.id,
          fields: f,
          _info: {
            table: "浏览量", acc: accName, title: v.title, date: v.date, play, follow,
            col: isNew ? "新增浏览量" : "累计浏览量", how: hit.how,
          },
        });
        perAcc[accName] = (perAcc[accName] || 0) + 1;
      }
    }

    if (!updates.length) {
      return {
        ok: false, updated: 0, total: 0,
        fields: fieldNames(m), perAcc,
        skipped: skipped.slice(0, 30), skippedCount: skipped.length,
        message: "没有可同步的视频数据",
      };
    }

    // 同一行被多条视频命中时，后写的覆盖前面的（保留最后一条，避免同批重复写）
    const seen = new Map();
    updates.forEach((u) => {
      const old = seen.get(u.record_id);
      if (old) Object.assign(old.fields, u.fields);
      else seen.set(u.record_id, u);
    });
    const finalUpdates = [...seen.values()];
    const done = await batchUpdate(cfg.appToken, cfg.tableId, token, finalUpdates);

    return {
      ok: done.errors.length === 0,
      updated: done.count,
      total: finalUpdates.length,
      fields: fieldNames(m),
      perAcc,
      skipped: skipped.slice(0, 30),
      skippedCount: skipped.length,
      samples: finalUpdates.slice(0, 5).map((u) => u._info),
      message: done.errors.join("；"),
    };
  }

  /* ---------- ② 粉丝数据表 ---------- */

  async function syncFanTable(cfg, token, all, only, now) {
    const appToken = cfg.fanAppToken || cfg.appToken;
    const fields = await listFields(token, appToken, cfg.fanTableId);
    if (!fields.length) throw new FeishuError("粉丝表没有任何字段，检查 Table ID 是否正确");
    const m = mapFanFields(fields);
    if (!m.fFans) {
      throw new FeishuError("没认出粉丝表的「粉丝总数」列。表里的字段是：" + fields.map((f) => f.field_name).join(" / "));
    }
    if (!m.fDate) {
      throw new FeishuError("没认出粉丝表的「日期」列。表里的字段是：" + fields.map((f) => f.field_name).join(" / "));
    }

    const records = await listRecords(token, appToken, cfg.fanTableId);

    const updates = [];
    const creates = [];
    const skipped = [];
    const perAcc = {};
    let rowMiss = 0;

    for (const accName of only) {
      const s = all[accName] || {};
      const nNew = numOf(s.newAdd);
      const nNet = numOf(s.netAdd);
      const nAll = numOf(s.fansTotal);
      if (nNew == null && nNet == null && nAll == null) continue;  // 没读过关注者页

      // ★ 数据日期以「这一页是什么时候读的」为准：页面上的新增/净增就是读取时的「昨日」。
      //   以前用同步当天的昨天，隔一天再同步就会把旧快照写到错误的日期上。
      const readAtF = (s.readAt && s.readAt.follower) || 0;
      if (readAtF && readAtF < startOfDay(now) - 864e5) {
        skipped.push({
          table: "粉丝", acc: accName,
          reason: `粉丝数据是 ${ymd(readAtF)} 读的（不是今天/昨天的），请重新读取后再同步`,
        });
        continue;
      }
      const dayTs = startOfDay(readAtF || now) - 864e5;
      const dayStr = ymd(dayTs);

      const acc = normAcc(accName);
      const rec = findFanRow(records, m, acc, dayTs);

      const f = {};
      if (nNew != null && m.fNewAdd && writable(m.fNewAdd)) f[m.fNewAdd.field_name] = pack(m.fNewAdd, nNew);
      if (nNet != null && m.fNetAdd && writable(m.fNetAdd)) f[m.fNetAdd.field_name] = pack(m.fNetAdd, nNet);
      if (nAll != null && m.fFans && writable(m.fFans)) f[m.fFans.field_name] = pack(m.fFans, nAll);
      if (!Object.keys(f).length) {
        skipped.push({ table: "粉丝", acc: accName, date: dayStr, reason: "目标列是公式/查找引用，写不进去" });
        continue;
      }

      const info = { table: "粉丝", acc: accName, date: dayStr, newAdd: nNew, netAdd: nNet, fansTotal: nAll };

      if (rec) {
        updates.push({ record_id: rec.record_id, fields: f, _info: Object.assign({ action: "更新" }, info) });
        perAcc[accName] = (perAcc[accName] || 0) + 1;
        continue;
      }

      // ★ 没有「帐号名 + 昨天」这一行 → 自动新建（日期 + 帐号名 + 三个数值一次写全）
      if (!writable(m.fDate)) {
        rowMiss++;
        skipped.push({ table: "粉丝", acc: accName, date: dayStr, reason: `缺 ${dayStr} 这一行，但「日期」列是公式/查找引用，建不了行` });
        continue;
      }
      const nf = Object.assign({}, f);
      nf[m.fDate.field_name] = packDate(m.fDate, dayTs);
      if (m.fAcc && writable(m.fAcc)) nf[m.fAcc.field_name] = packText(m.fAcc, accName);
      else if (m.fAcc) {
        rowMiss++;
        skipped.push({ table: "粉丝", acc: accName, date: dayStr, reason: "「帐号名」列是公式/查找引用，建不了行" });
        continue;
      }
      creates.push({ fields: nf, _info: Object.assign({ action: "新建" }, info) });
      perAcc[accName] = (perAcc[accName] || 0) + 1;
    }

    if (!updates.length && !creates.length) {
      return {
        ok: false, updated: 0, created: 0, total: 0,
        fields: fanFieldNames(m), perAcc,
        skipped: skipped.slice(0, 30), skippedCount: skipped.length,
        message: rowMiss ? "粉丝表缺行且建不了，明细见控制台" : "没有可同步的粉丝数据",
      };
    }

    const seen = new Map();
    updates.forEach((u) => {
      const old = seen.get(u.record_id);
      if (old) Object.assign(old.fields, u.fields);
      else seen.set(u.record_id, u);
    });
    const finalUpdates = [...seen.values()];

    const done = await batchUpdate(appToken, cfg.fanTableId, token, finalUpdates);
    const made = creates.length
      ? await batchCreate(appToken, cfg.fanTableId, token, creates)
      : { count: 0, errors: [] };

    return {
      ok: done.errors.length === 0 && made.errors.length === 0,
      updated: done.count,
      created: made.count,
      total: finalUpdates.length + creates.length,
      fields: fanFieldNames(m),
      perAcc,
      skipped: skipped.slice(0, 30),
      skippedCount: skipped.length,
      samples: finalUpdates.concat(creates).slice(0, 5).map((u) => u._info),
      message: done.errors.concat(made.errors).join("；"),
    };
  }

  /** 分批写回（每批 500 条） */
  async function batchUpdate(appToken, tableId, token, finalUpdates) {
    let count = 0;
    const errors = [];
    for (let i = 0; i < finalUpdates.length; i += PAGE) {
      const chunk = finalUpdates.slice(i, i + PAGE);
      const payload = {
        records: chunk.map((u) => ({ record_id: u.record_id, fields: u.fields })),
      };
      try {
        await request(
          `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_update`,
          { method: "POST", token, body: payload, where: "写入记录" }
        );
        count += chunk.length;
      } catch (e) {
        errors.push(e.message || String(e));
      }
    }
    return { count, errors };
  }

  /** 新建记录（每批 500 条）：粉丝表缺「帐号名 + 昨天」那一行时自动补 */
  async function batchCreate(appToken, tableId, token, rows) {
    let count = 0;
    const errors = [];
    for (let i = 0; i < rows.length; i += PAGE) {
      const chunk = rows.slice(i, i + PAGE);
      try {
        await request(
          `/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
          {
            method: "POST",
            token,
            body: { records: chunk.map((r) => ({ fields: r.fields })) },
            where: "新建记录",
          }
        );
        count += chunk.length;
      } catch (e) {
        errors.push(e.message || String(e));
      }
    }
    return { count, errors };
  }

  function fieldNames(m) {
    return {
      acc: m.fAcc ? m.fAcc.field_name : "",
      video: m.fVideo ? m.fVideo.field_name : "",
      date: m.fDate ? m.fDate.field_name : "",
      newView: m.fNew ? m.fNew.field_name : "",
      totalView: m.fTotal ? m.fTotal.field_name : "",
      follow: m.fFollow ? m.fFollow.field_name : "",
      view: m.fView ? m.fView.field_name : "",
    };
  }

  function fanFieldNames(m) {
    return {
      date: m.fDate ? m.fDate.field_name : "",
      acc: m.fAcc ? m.fAcc.field_name : "",
      newAdd: m.fNewAdd ? m.fNewAdd.field_name : "",
      netAdd: m.fNetAdd ? m.fNetAdd.field_name : "",
      fans: m.fFans ? m.fFans.field_name : "",
    };
  }

  /** 只验证凭证 + 两张表的结构，用来在弹窗里点「测试连接」 */
  async function test() {
    const cfg = await loadCfg();
    const bad = cfgProblem(cfg);
    if (bad) return { ok: false, message: bad };
    const token = await getToken(cfg.appId, cfg.appSecret, true);

    const out = { ok: true, message: "", fields: null, fanFields: null, allFields: [], fanAllFields: [] };
    const parts = [];

    const fields = await listFields(token, cfg.appToken, cfg.tableId);
    const m = mapVideoFields(fields);
    const records = await listRecords(token, cfg.appToken, cfg.tableId);
    out.fields = fieldNames(m);
    out.allFields = fields.map((f) => f.field_name);
    parts.push(`浏览量表 ${records.length} 条记录`);

    if (!m.fVideo) parts.push("⚠ 没认出「视频名称」列");
    if (!m.fAcc) parts.push("⚠ 没认出「帐户名」列");
    if (!m.fNew && !m.fView) parts.push("⚠ 没认出「新增浏览量」列");
    if (!m.fTotal && !m.fView) parts.push("⚠ 没认出「累计浏览量」列");
    if (!m.fFollow) parts.push("⚠ 没认出「视频关注量」列");

    if (cfg.fanTableId) {
      const ff = await listFields(token, cfg.fanAppToken || cfg.appToken, cfg.fanTableId);
      const fm = mapFanFields(ff);
      const fr = await listRecords(token, cfg.fanAppToken || cfg.appToken, cfg.fanTableId);
      out.fanFields = fanFieldNames(fm);
      out.fanAllFields = ff.map((f) => f.field_name);
      parts.push(`粉丝表 ${fr.length} 条记录`);
      if (!fm.fDate) parts.push("⚠ 粉丝表没认出「日期」列");
      if (!fm.fAcc) parts.push("⚠ 粉丝表没认出「帐号名」列");
      if (!fm.fNewAdd) parts.push("⚠ 没认出「当日新增」列");
      if (!fm.fNetAdd) parts.push("⚠ 没认出「当日净增」列");
      if (!fm.fFans) parts.push("⚠ 没认出「粉丝总数」列");
    } else {
      parts.push("（未填粉丝表链接，只同步浏览量表）");
    }

    out.message = "连接成功：" + parts.join("；");
    return out;
  }

  return { sync, test, parseUrl };
})();
