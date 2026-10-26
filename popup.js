/* 视频号发布助手 - 弹窗逻辑
 * 界面只保留「粘贴 JSON → 导入 → 显示已加载数量」。
 * 素材根目录不显示在界面上，但导入时仍会从 JSON 的 root 字段自动读取并保存。
 */
const KEY = "wxch_tasks";
const IDX = "wxch_index";
const ROOT = "wxch_root";

const $ = (id) => document.getElementById(id);

function info(msg, cls) {
  const el = $("info");
  if (!el) return;
  el.textContent = msg;
  el.className = cls || "";
}

function showRootTip(root) {
  const el = $("roottip");
  if (!el) return;
  el.textContent = root ? "素材根目录：" + root : "素材根目录：未设置";
  el.className = root ? "tip" : "tip warn";
}

function refresh() {
  chrome.storage.local.get([KEY, ROOT], (r) => {
    const t = r[KEY] || [];
    showRootTip(r[ROOT] || "");
    if (!t.length) {
      info("未导入任务");
      return;
    }
    info(`已加载 ${t.length} 条任务`, "ok");
  });
}

function notifyContent() {
  // 通知已开的视频号页面刷新面板。
  // ★ 这一步只是「锦上添花」，任何异常都不能影响导入结果提示：
  //   旧写法 chrome.tabs.sendMessage(...).catch() 在不支持 Promise 的浏览器里
  //   （sendMessage 返回 undefined）会抛 TypeError，把「已加载 N 条任务」直接顶掉。
  try {
    if (typeof chrome === "undefined" || !chrome.tabs || !chrome.tabs.query) return;
    chrome.tabs.query({ url: "https://channels.weixin.qq.com/*" }, (tabs) => {
      void (chrome.runtime && chrome.runtime.lastError);
      (tabs || []).forEach((t) => {
        try {
          chrome.tabs.sendMessage(t.id, { type: "refresh" }, () => {
            void (chrome.runtime && chrome.runtime.lastError); // 页面没注入脚本也不报错
          });
        } catch (e) { /* ignore */ }
      });
    });
  } catch (e) { /* ignore */ }
}

/** 宽松解析 JSON：容忍 BOM、中文引号、尾逗号、Windows 路径里的单个反斜杠 */
function parseJSONLoose(text) {
  const raw = String(text == null ? "" : text).replace(/^\uFEFF/, "").trim();
  const tries = [];
  tries.push(raw);
  const cleaned = raw
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
  if (cleaned !== raw) tries.push(cleaned);
  // "D:\素材" 里的 \素 不是合法转义 → 补成 \\（合法转义 \" \\ \/ \b \f \n \r \t \uXXXX 保留）
  const fixed = (s) => s.replace(/\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/g, "\\\\");
  tries.push(fixed(raw));
  if (cleaned !== raw) tries.push(fixed(cleaned));

  let firstErr = null;
  for (const t of tries) {
    try { return JSON.parse(t); } catch (e) { if (!firstErr) firstErr = e; }
  }
  throw firstErr || new Error("JSON 格式不正确");
}

/** 把各种导出格式统一成任务数组（不重复解析文本，避免重复报错） */
function normalize(data) {
  const norm = (x) => ({
    title: x.title || "",
    tags: Array.isArray(x.tags) ? x.tags : [],
    time: x.time || "",
    acc: x.acc || x.acc_name || "",
    video: x.video || "",
    cover: x.cover || "",
  });
  // 新版导出：{ root, tasks: [...] }
  if (data && Array.isArray(data.tasks)) return data.tasks.map(norm);
  // 兼容旧版 config.json：自动抽取 schedules
  if (data && Array.isArray(data.schedules)) return data.schedules.map(norm);
  if (!Array.isArray(data)) throw new Error("JSON 顶层必须是数组，或含 tasks / schedules 的对象");
  return data.map(norm);
}

/** 从 JSON 里读取素材根目录（顶层 root 或每条 root 字段） */
function pickRoot(data) {
  try {
    if (data && typeof data === "object" && !Array.isArray(data) && data.root) {
      return normPath(data.root);
    }
    if (Array.isArray(data)) {
      for (const x of data) {
        if (x && typeof x === "object" && x.root) return normPath(x.root);
      }
    }
  } catch (e) { /* ignore */ }
  return "";
}

/** 路径规范化：/ → \，并把连续反斜杠折叠成一个（UNC 的 \\ 前缀保留） */
function normPath(p) {
  let s = String(p || "").trim().replace(/\//g, "\\");
  const unc = /^\\\\/.test(s);
  s = s.replace(/\\+/g, "\\");
  if (unc) s = "\\" + s;
  // 去掉末尾多余分隔符（盘符根 C:\ 与 UNC 根 \\x 除外）
  if (s.length > 3) s = s.replace(/\\+$/, "");
  return s;
}

/** 判断是否为绝对路径（盘符 D:\ 或 UNC \\ 开头） */
function isAbsPath(p) {
  const s = normPath(p);
  return /^[A-Za-z]:\\/.test(s) || /^\\\\/.test(s);
}

/**
 * 兜底推导：从所有 video / cover 的绝对路径取公共父目录。
 * 素材结构通常是  root\账号名\xx.mp4，
 * 若公共目录的最后一级正好等于某条任务的 acc（账号名），说明它就是账号文件夹，再上一级才是 root。
 */
function deriveRootFromTasks(tasks) {
  const dirs = [];
  for (const t of tasks) {
    for (const p of [t.video, t.cover]) {
      if (!p || !isAbsPath(p)) continue;
      const s = normPath(p);
      const i = s.lastIndexOf("\\");
      if (i > 0) dirs.push(s.slice(0, i));
    }
  }
  if (!dirs.length) return "";

  // 逐段求公共前缀
  let common = dirs[0].split("\\");
  for (const d of dirs) {
    const seg = d.split("\\");
    let k = 0;
    while (k < common.length && k < seg.length &&
           common[k].toLowerCase() === seg[k].toLowerCase()) k++;
    common = common.slice(0, k);
  }
  if (!common.length) return "";

  let out = common.join("\\");
  // 若最后一级就是某个账号文件夹，再上一层
  const base = (common[common.length - 1] || "").toLowerCase();
  if (base && tasks.some((t) => (t.acc || "").toLowerCase() === base)) {
    const i = out.lastIndexOf("\\");
    if (i > 0) out = out.slice(0, i);
  }
  return out;
}

function importJson(text) {
  const data = parseJSONLoose(text);
  const tasks = normalize(data);
  if (!tasks.length) throw new Error("没有解析到任何任务（tasks 是空数组？）");

  // 根目录：优先 JSON 的 root 字段 → 否则从绝对路径推导 → 都没有则保留原来的
  let root = pickRoot(data);
  let how = "root 字段";
  if (!root) {
    root = deriveRootFromTasks(tasks);
    how = "路径推导";
  }

  const payload = { [KEY]: tasks, [IDX]: 0 };

  const write = (finalRoot, note) => {
    if (finalRoot) payload[ROOT] = finalRoot;
    // ★ 先把结果提示出来，再去做「通知页面」这种可能失败的事
    const done = () => {
      showRootTip(finalRoot || "");
      if (finalRoot) {
        info(`已加载 ${tasks.length} 条任务`, "ok");
      } else {
        info(`已加载 ${tasks.length} 条任务（未能确定素材根目录）`, "err");
      }
      notifyContent();
      if (note) console.log("[视频号助手] 素材根目录（" + note + "）：", finalRoot || "(无)");
    };
    try {
      chrome.storage.local.set(payload, () => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) {
          info("写入失败：" + (err.message || err), "err");
          return;
        }
        try { done(); } catch (e) { info(`已加载 ${tasks.length} 条任务（界面刷新异常：${e.message}）`, "ok"); }
      });
    } catch (e) {
      // storage 都不可用时至少把条数告诉用户
      info(`已加载 ${tasks.length} 条任务（保存失败：${e.message}）`, "err");
    }
  };

  if (root) return write(root, how);
  // 都没有 → 沿用上次已保存的根目录
  chrome.storage.local.get([ROOT], (r) => write((r && r[ROOT]) || "", "沿用上次"));
}

$("btnImport").onclick = () => {
  const txt = $("txt").value.trim();
  if (!txt) return info("请先粘贴 JSON 内容", "err");
  try {
    importJson(txt);
  } catch (e) {
    const msg = String(e && e.message || e);
    info((/JSON|token|position|escape|Unexpected/i.test(msg) ? "解析失败：" : "导入失败：") + msg, "err");
    console.error("[视频号助手] 导入失败：", e);
  }
};

refresh();
showVersion();

/* ---------------- 飞书多维表格配置 ---------------- */
const FS_KEY = "wxch_feishu";
const FS_DEFAULT_URL = ""; // 不内置任何默认表格：在弹窗里填你自己的多维表格链接

function fsInfo(msg, cls) {
  const el = $("fsInfo");
  if (!el) return;
  el.textContent = msg;
  el.className = cls || "";
}

/** 多维表格链接 → { appToken, tableId } */
function parseBaseUrl(url) {
  const s = String(url || "").trim();
  const mApp = s.match(/\/base\/([A-Za-z0-9]+)/);
  const mTbl = s.match(/[?&]table=([A-Za-z0-9]+)/);
  return { appToken: mApp ? mApp[1] : "", tableId: mTbl ? mTbl[1] : "" };
}

function fsLoad() {
  try {
    chrome.storage.local.get([FS_KEY], (r) => {
      const c = (r && r[FS_KEY]) || {};
      if ($("fsUrl")) $("fsUrl").value = c.url || FS_DEFAULT_URL;
      if ($("fsFanUrl")) $("fsFanUrl").value = c.fanUrl || "";
      if ($("fsAppId")) $("fsAppId").value = c.appId || "";
      if ($("fsSecret")) $("fsSecret").value = c.appSecret || "";
      if (!c.appId || !c.appSecret) {
        fsInfo("未配置：填好两张表链接 + App ID / App Secret 后点「保存配置」", "");
      } else {
        const p = parseBaseUrl(c.url || FS_DEFAULT_URL);
        const p2 = parseBaseUrl(c.fanUrl || "");
        fsInfo(`已配置：浏览量表 ${p.tableId || "?"}${p2.tableId ? " · 粉丝表 " + p2.tableId : "（未填粉丝表）"}`, "ok");
      }
    });
  } catch (e) { /* ignore */ }
}

function fsSave(silent) {
  const url = ($("fsUrl") ? $("fsUrl").value : "").trim();
  const fanUrl = ($("fsFanUrl") ? $("fsFanUrl").value : "").trim();
  const appId = ($("fsAppId") ? $("fsAppId").value : "").trim();
  const appSecret = ($("fsSecret") ? $("fsSecret").value : "").trim();
  const p = parseBaseUrl(url);
  const p2 = parseBaseUrl(fanUrl);

  if (!url) { if (!silent) fsInfo("请填「浏览量及留资信息表」的链接", "err"); return false; }
  if (!p.appToken) { if (!silent) fsInfo("链接里没找到 /base/xxx，请复制浏览器地址栏的完整地址", "err"); return false; }
  if (!p.tableId) { if (!silent) fsInfo("浏览量表的链接里没有 table=tblxxx，请在表格里点一下该子表再复制地址", "err"); return false; }
  if (fanUrl) {
    if (!p2.appToken) { if (!silent) fsInfo("粉丝表链接里没找到 /base/xxx", "err"); return false; }
    if (!p2.tableId) { if (!silent) fsInfo("粉丝表链接里没有 table=tblxxx，请点一下该子表再复制地址", "err"); return false; }
    if (p2.appToken !== p.appToken) {
      if (!silent) fsInfo("两张表不在同一个多维表格里（/base/xxx 不同），目前只支持同一个 base 下的子表", "err");
      return false;
    }
  }
  if (!appId) { if (!silent) fsInfo("请填 App ID", "err"); return false; }
  if (!appSecret) { if (!silent) fsInfo("请填 App Secret", "err"); return false; }

  const cfg = {
    url, appToken: p.appToken, tableId: p.tableId,
    fanUrl, fanAppToken: p2.appToken || p.appToken, fanTableId: p2.tableId || "",
    appId, appSecret, savedAt: Date.now(),
  };
  try {
    chrome.storage.local.set({ [FS_KEY]: cfg }, () => {
      if (!silent) {
        fsInfo("已保存。" + (p2.tableId ? "两张表都会同步。" : "未填粉丝表，只同步浏览量表。") +
          "到视频号页面，当前登录哪个号就点面板上的「同步飞书」，只写这个号。", "ok");
      }
    });
  } catch (e) {
    if (!silent) fsInfo("保存失败：" + (e.message || e), "err");
    return false;
  }
  return true;
}

function fsTest() {
  if (!fsSave(true)) {
    fsInfo("先把两张表链接 / App ID / App Secret 填全", "err");
    return;
  }
  fsInfo("正在连接飞书…", "");
  try {
    chrome.runtime.sendMessage({ type: "wxchFeishuTest" }, (r) => {
      const err = chrome.runtime && chrome.runtime.lastError;
      if (err) { fsInfo("后台未响应，请到 chrome://extensions 重新加载插件", "err"); return; }
      if (!r) { fsInfo("没有返回结果", "err"); return; }
      if (!r.ok) { fsInfo("连接失败：" + (r.message || "未知错误"), "err"); return; }

      const f = r.fields || {};
      const ff = r.fanFields || {};
      const v = [];
      if (f.acc) v.push("帐户名=" + f.acc);
      if (f.video) v.push("视频名称=" + f.video);
      if (f.newView) v.push("新增=" + f.newView);
      if (f.totalView) v.push("累计=" + f.totalView);
      if (f.follow) v.push("关注=" + f.follow);

      const x = [];
      if (ff.date) x.push("日期=" + ff.date);
      if (ff.acc) x.push("帐号名=" + ff.acc);
      if (ff.newAdd) x.push("当日新增=" + ff.newAdd);
      if (ff.netAdd) x.push("当日净增=" + ff.netAdd);
      if (ff.fans) x.push("粉丝总数=" + ff.fans);

      const warn = /⚠/.test(r.message || "");
      fsInfo(
        (r.message || "") + "\n① " + (v.join("，") || "没有可用列") +
        "\n② " + (x.join("，") || "（未配置粉丝表）") +
        (warn ? "\n字段没认全：①" + (r.allFields || []).join("/") + " ②" + (r.fanAllFields || []).join("/") : ""),
        warn ? "err" : "ok"
      );
    });
  } catch (e) {
    fsInfo("调用失败：" + (e.message || e), "err");
  }
}

if ($("btnFsSave")) $("btnFsSave").onclick = () => fsSave(false);
if ($("btnFsTest")) $("btnFsTest").onclick = fsTest;


/** 显示插件版本号：改完插件是否真的重新加载过，看一眼这里就知道 */
function showVersion() {
  try {
    const el = $("ver");
    if (!el) return;
    const v = chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest().version : "";
    el.textContent = v ? "v" + v : "";
  } catch (e) { /* ignore */ }
}

// 放在最后：fsLoad 里引用了 const FS_KEY，提前调用会撞上暂时性死区
fsLoad();

