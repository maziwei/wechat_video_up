/* 视频号发布助手 · 后台脚本（v2.5.3）
 *
 * 为什么需要它：
 *   关注者/视频/评论/私信这四个数字只有各自页面渲染完成后才存在，
 *   content script 只能读「当前这个页面」的 DOM，不能凭空去查别的页。
 *   所以点「读取最新数据」时，这里依次打开四个数据页，
 *   让页面里的 content script 抓取并回传，读完自动关掉这个临时标签。
 *
 * v2.5.3 关键修正：
 *   「视频数据」页在**隐藏标签**里不会渲染表格（浏览器会暂停不可见标签的
 *   动画帧与懒加载），所以后台偷偷开一个后台标签去读，永远是空的；
 *   必须是你自己把那页打开、点读取才有数据。
 *   现在视频页会临时把临时标签切到前台，读完立刻把焦点还给原来的标签；
 *   其余页面若在后台也读不出来，会同样自动切前台重试一次。
 */

// 飞书多维表格同步模块（v2.6.0）
// 放在后台是因为 content script 的 fetch 受页面跨域限制，飞书 API 没有 CORS 头。
try {
  importScripts("feishu.js");
} catch (e) {
  console.error("[视频号助手] 飞书模块加载失败：", e);
}

const PAGES = [
  {
    key: "follower",
    name: "关注者",
    path: "/platform/statistic/follower",
    url: "https://channels.weixin.qq.com/platform/statistic/follower",
    active: false,
  },
  {
    key: "post",
    name: "视频数据",
    path: "/platform/statistic/post",
    url: "https://channels.weixin.qq.com/platform/statistic/post",
    active: true, // ★ 这页必须在可见标签里才渲染表格
  },
  {
    key: "comment",
    name: "评论",
    path: "/platform/interaction/comment",
    url: "https://channels.weixin.qq.com/platform/interaction/comment",
    active: false,
  },
  {
    key: "msg",
    name: "私信",
    path: "/platform/private_msg",
    url: "https://channels.weixin.qq.com/platform/private_msg",
    active: false,
  },
];

const PAGE_TIMEOUT = 18000;  // 后台标签单页最多等这么久
const ACTIVE_TIMEOUT = 30000; // 切到前台的单页（要等渲染 + 点「单篇视频」标签，给足时间）
const HARD_TIMEOUT = 180000;  // 整个任务兜底

let job = null;
let feishuBusy = false;

function broadcast(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch (e) {
    /* 没有接收者时忽略 */
  }
}

function progress(text) {
  if (!job) return;
  broadcast({ type: "wxchCollectProgress", jobId: job.id, text });
}

function resultsList() {
  if (!job) return [];
  return Object.keys(job.results).map((k) => job.results[k]);
}

function finish(ok, message) {
  const j = job;
  if (!j) return;
  job = null;
  clearTimeout(j.timer);
  clearTimeout(j.hardTimer);
  // 视频页可能把临时标签切到了前台：先把焦点还给用户原来的标签
  if (j.activated && j.originTabId != null) {
    try {
      chrome.tabs.update(j.originTabId, { active: true }, () => void chrome.runtime.lastError);
    } catch (e) { /* ignore */ }
  }
  if (j.tabId != null) {
    try {
      chrome.tabs.remove(j.tabId, () => void chrome.runtime.lastError);
    } catch (e) { /* ignore */ }
  }
  broadcast({
    type: "wxchCollectDone",
    jobId: j.id,
    ok: !!ok,
    message: message || "",
    results: Object.keys(j.results).map((k) => j.results[k]),
  });
}

function armTimeout(step, ms) {
  if (!job) return;
  clearTimeout(job.timer);
  job.timer = setTimeout(() => {
    if (!job || job.step !== step) return;
    record(step, false, "超时");
  }, ms || PAGE_TIMEOUT);
}

/** 记录一页的结果，并决定下一站 */
function record(step, ok, reason) {
  if (!job || job.step !== step) return;
  const item = job.current;
  if (!item) return;
  const key = item.page.key;
  job.results[key] = {
    key,
    name: item.page.name,
    ok: !!ok,
    reason: reason || "",
  };
  // 后台标签读不出来（隐藏标签不渲染）：同一页立刻切到前台重试一次
  if (!ok && !item.retried && !item.active) {
    job.queue.splice(job.index + 1, 0, { page: item.page, active: true, retried: true });
  }
  enter(job.index + 1);
}

function enter(i) {
  if (!job) return;
  if (i >= job.queue.length) {
    const okCount = resultsList().filter((r) => r && r.ok).length;
    finish(okCount > 0, okCount ? "" : "四个页面都没读到数据");
    return;
  }
  job.index = i;
  const step = ++job.step;
  job.started = false;
  const item = job.queue[i];
  job.current = item;
  progress(`打开「${item.page.name}」${i + 1}/${job.queue.length}`);

  if (i === 0) {
    armTimeout(step, item.active ? ACTIVE_TIMEOUT : PAGE_TIMEOUT); // 标签页已由 start() 打开
    return;
  }
  chrome.tabs.update(job.tabId, { url: item.page.url, active: !!item.active }, () => {
    if (!job || job.step !== step) return;
    if (chrome.runtime.lastError) {
      record(step, false, "导航失败");
      return;
    }
    if (item.active) job.activated = true;
    armTimeout(step, item.active ? ACTIVE_TIMEOUT : PAGE_TIMEOUT);
  });
}

function start(originTabId, skipKeys) {
  if (job) return false;
  const skip = Array.isArray(skipKeys) ? skipKeys : [];
  // 当前页已经就地读过的，不再跑一遍（视频页会把你当下看的标签切走）
  const list = PAGES.filter((p) => skip.indexOf(p.key) < 0);
  if (!list.length) return false;
  job = {
    id: Date.now(),
    tabId: null,
    originTabId: originTabId == null ? null : originTabId,
    queue: list.map((p) => ({ page: p, active: !!p.active, retried: false })),
    index: -1,
    step: 0,
    started: false,
    activated: false,
    current: null,
    results: {},
    timer: 0,
    hardTimer: 0,
  };
  // 整体兜底：万一 service worker 被回收或某页卡住，别让面板永远停在「读取中」
  job.hardTimer = setTimeout(() => {
    if (job) finish(false, "读取超时，请重试");
  }, HARD_TIMEOUT);
  progress("准备读取…");
  // 第一站直接用队列首页（可能是「视频数据」——它要求可见标签）
  const first = list[0];
  const firstActive = !!first.active;
  chrome.tabs.create({ url: first.url, active: firstActive }, (tab) => {
    if (!job) return;
    if (chrome.runtime.lastError || !tab) {
      finish(false, "无法打开数据页");
      return;
    }
    job.tabId = tab.id;
    if (firstActive) job.activated = true;
    enter(0);
  });
  return true;
}

/** 页面加载好之后，content script 会报 ready，这时才发抓取指令 */
function onReady(path, tabId) {
  if (!job || tabId !== job.tabId || job.started) return;
  const item = job.current;
  if (!item) return;
  const step = job.step;
  if (path && /login/i.test(path)) {
    finish(false, "未登录视频号助手");
    return;
  }
  if (path && path !== item.page.path) return; // 还在上一个页面，等目标页的 ready

  job.started = true;
  clearTimeout(job.timer);
  progress(`读取「${item.page.name}」${job.index + 1}/${job.queue.length}`);

  // 先只问顶层 frame（多数页面数据在顶层）；顶层没读到，再广播给所有 frame 兜底
  chrome.tabs.sendMessage(job.tabId, { type: "wxchCollect", pageKey: item.page.key }, { frameId: 0 }, (res) => {
    if (!job || job.step !== step) return;
    const err = chrome.runtime.lastError;
    if (!err && res && res.ok) {
      record(step, true);
      return;
    }
    chrome.tabs.sendMessage(job.tabId, { type: "wxchCollect", pageKey: item.page.key }, (res2) => {
      if (!job || job.step !== step) return;
      const err2 = chrome.runtime.lastError;
      record(step, !err2 && !!(res2 && res2.ok), err2 ? "页面未响应" : (res2 && res2.reason));
    });
  });
  armTimeout(step, item.active ? ACTIVE_TIMEOUT : PAGE_TIMEOUT);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "wxchCollectAll") {
    if (job) {
      sendResponse({ ok: true, busy: true });
      return;
    }
    const origin = sender.tab && sender.tab.id;
    const started = start(origin, msg.skip);
    sendResponse({ ok: started });
    return;
  }

  if (msg.type === "wxchContentReady") {
    if (!job) return;
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    if (sender.frameId != null && sender.frameId !== 0) return; // 只认顶层 frame
    onReady(msg.path || "", tabId);
    return;
  }

  if (msg.type === "wxchJobState") {
    sendResponse(job ? { ok: true, busy: true, index: job.index } : { ok: true, busy: false });
    return;
  }

  /* ---------- 飞书同步 ---------- */
  if (msg.type === "wxchFeishuSync" || msg.type === "wxchFeishuTest") {
    if (typeof FEISHU === "undefined") {
      sendResponse({ ok: false, message: "飞书模块没加载起来，请到 chrome://extensions 重新加载插件" });
      return;
    }
    if (feishuBusy) {
      sendResponse({ ok: false, message: "上一次同步还没结束，请稍候" });
      return;
    }
    feishuBusy = true;
    const run = msg.type === "wxchFeishuTest"
      ? FEISHU.test()
      : FEISHU.sync({ account: msg.account || "" });
    run
      .then((r) => sendResponse(r || { ok: false, message: "飞书没有返回结果" }))
      .catch((e) => sendResponse({ ok: false, message: (e && e.message) || String(e) }))
      .then(() => { feishuBusy = false; });
    return true; // 异步 sendResponse
  }
});

// 扩展更新/重载时，别把临时标签留在那儿
chrome.runtime.onInstalled.addListener(() => {
  if (job && job.tabId != null) {
    try { chrome.tabs.remove(job.tabId, () => void chrome.runtime.lastError); } catch (e) {}
  }
  job = null;
});
