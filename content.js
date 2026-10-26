/* 视频号发布助手 - 内容脚本
 * 作用：在视频号助手「发表视频」页面注入一个悬浮面板，
 *       一键把队列里的标题和话题填进发布表单，由人工确认后手动点发表。
 * 说明：本插件不做任何自动点击「发表」的操作，只负责填写，降低风控风险。
 */
(function () {
  "use strict";

  const STORE_KEY = "wxch_tasks";
  const STORE_IDX = "wxch_index";

  /* ---------- 工具 ---------- */
  const log = (...a) => console.log("[视频号助手]", ...a);

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /* 记录上一次成功命中的元素，后续优先复用（页面结构稳定时最快） */
  let lastEditor = null;

  /* ---------- Shadow DOM 穿透（视频号用无界 Wujie 微前端） ---------- */
  /* 视频号发布页整体跑在 <WUJIE-APP> 的 Shadow DOM 里，
     普通 document.querySelectorAll 查不到内部元素，必须递归进 shadowRoot。 */

  /** 收集所有影子根（含嵌套） */
  function collectRoots() {
    const roots = [document];
    (function walk(root, depth) {
      if (depth > 8) return;
      let all = [];
      try { all = root.querySelectorAll("*"); } catch (e) { return; }
      for (const el of all) {
        if (el.shadowRoot) {
          roots.push(el.shadowRoot);
          walk(el.shadowRoot, depth + 1);
        }
      }
    })(document, 0);
    return roots;
  }

  /** 跨所有影子根查询，返回匹配元素数组 */
  function queryAllDeep(selector) {
    const out = [];
    for (const root of collectRoots()) {
      try {
        root.querySelectorAll(selector).forEach((el) => out.push(el));
      } catch (e) { /* 忽略非法选择器 */ }
    }
    return out;
  }

  /** 判断元素是否真实挂在文档上（穿透 shadow 时 document.contains 不可靠） */
  function isConnected(el) {
    if (!el) return false;
    if (document.contains(el)) return true;
    // 在 shadowRoot 内：逐级向上找 host
    let node = el;
    while (node) {
      if (node.parentNode) { node = node.parentNode; continue; }
      if (node.host) { node = node.host; continue; }
      break;
    }
    return node === document || (node && node.nodeType === 9);
  }

  /** 是否是可编辑的文本宿主 */
  function isEditable(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    const t = el.getAttribute && el.getAttribute("type");
    if (el.tagName === "INPUT") {
      if (t && ["button", "checkbox", "radio", "file", "submit", "hidden", "image", "range", "color"].includes(t)) return false;
      return true;
    }
    if (el.isContentEditable) return true;
    const cls = (el.className && String(el.className)) || "";
    if (/editor|prosemirror|ql-editor|w-e-text|draft|rich/i.test(cls)) return true;
    return false;
  }

  /** 元素是否处在可视表单区（避免命中隐藏弹层/旧缓存节点） */
  function usable(el) {
    if (!el || !visible(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 16) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    return true;
  }

  function findEditor() {
    // 0) 上次命中的还能用，直接复用
    if (lastEditor && isConnected(lastEditor) && usable(lastEditor)) return lastEditor;

    // 1) 明确的选择器（穿透 Shadow DOM）
    const sels = [
      "div.input-editor",
      ".input-editor",
      ".post-title .input-editor",
      '[class*="editor"][contenteditable="true"]',
      '[class*="input"][contenteditable="true"]',
      'div[contenteditable="true"]',
      '[contenteditable="true"]',
      '[contenteditable="plaintext-only"]',
      'textarea[placeholder*="标题"]',
      'textarea[placeholder*="描述"]',
      'textarea[placeholder*="填写"]',
      'input[placeholder*="标题"]',
      'textarea',
      'input[type="text"]',
    ];
    for (const s of sels) {
      for (const el of queryAllDeep(s)) {
        if (usable(el) && isEditable(el)) {
          lastEditor = el;
          return el;
        }
      }
    }

    // 2) 兜底：跨影子根扫全部可编辑元素，取「在视口内、面积最大的那个」
    const cands = [];
    queryAllDeep('input, textarea, [contenteditable="true"], [contenteditable=""]').forEach((el) => {
      if (!usable(el) || !isEditable(el)) return;
      const r = el.getBoundingClientRect();
      const inView = r.top >= 0 && r.top < innerHeight;
      cands.push({ el, score: r.width * r.height + (inView ? 1e6 : 0) });
    });
    if (cands.length) {
      cands.sort((a, b) => b.score - a.score);
      lastEditor = cands[0].el;
      return lastEditor;
    }
    return null;
  }

  /** 找「短标题」输入框（视频号：placeholder="填写短标题有机会获得更多流量"） */
  function findShortTitle() {
    const sels = [
      'input[placeholder*="短标题"]',
      'input[placeholder*="标题"]',
      'textarea[placeholder*="短标题"]',
      'textarea[placeholder*="标题"]',
      'input[placeholder*="流量"]',
    ];
    for (const s of sels) {
      for (const el of queryAllDeep(s)) {
        if (usable(el) && isEditable(el)) return el;
      }
    }
    return null;
  }

  /** 找「视频描述」编辑器（placeholder="添加描述"，话题写这里） */
  function findDescEditor() {
    const sels = [
      'div.input-editor[contenteditable]',
      '.input-editor[contenteditable]',
      'div[contenteditable][data-placeholder*="描述"]',
      '[contenteditable][data-placeholder*="描述"]',
      '[contenteditable][placeholder*="描述"]',
      'div.input-editor',
      '.input-editor',
    ];
    for (const s of sels) {
      for (const el of queryAllDeep(s)) {
        if (usable(el) && isEditable(el)) return el;
      }
    }
    return findEditor();
  }

  /** 往输入框里填「短标题」（React 受控 input，需原生 setter） */
  function fillInputValue(el, text) {
    if (!el) return false;
    try {
      el.focus();
      const proto =
        el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) {
        desc.set.call(el, text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    } catch (e) {
      log("fillInputValue 失败", e);
    }
    return false;
  }

  /** 在当前焦点元素中插入文本（contenteditable 用 execCommand，输入框直接改值） */
  function insertText(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + text.length;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    // contenteditable
    try {
      document.execCommand("insertText", false, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    } catch (e) {
      log("insertText 失败", e);
      return false;
    }
  }

  /** 模拟一次按键（用于让编辑器把 #话题 转成标签 chip） */
  function pressKey(el, key) {
    el.focus();
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key: key,
          code: key === " " ? "Space" : key,
          keyCode: key === " " ? 32 : 13,
          which: key === " " ? 32 : 13,
          bubbles: true,
          cancelable: true,
        })
      );
    }
  }

  function clearEditor(el) {
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    try {
      document.execCommand("selectAll");
      document.execCommand("delete");
    } catch (e) {
      log("清空失败", e);
    }
  }

  /* ---------- 定时发布（针对视频号真实 DOM 结构） ----------
   * 真实结构（已确认）：
   *   定时选项：<input type="radio" class="weui-desktop-form__radio" value="0|1">
   *             <span class="weui-desktop-form__check-content">不定时|定时</span>
   *   时间框：  <input type="text" readonly placeholder="请选择发表时间" class="weui-desktop-form__input">
   *   面板：    <dd class="weui-desktop-picker__dd">
   *              日期：table.weui-desktop-picker__table 内 <a> 文本为日
   *              小时：ol.weui-desktop-picker__time__hour > li
   *              分钟：ol.weui-desktop-picker__time__minute > li
   */

  /** 元素是否可见且尺寸合理（可用作点击目标） */
  function clickableSize(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return null;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none") return null;
    return r;
  }

  /** 找所有含指定关键词的可见叶子元素 */
  function findByText(re) {
    const out = [];
    queryAllDeep("div,span,label,p,button,li,a").forEach((el) => {
      if (el.children.length > 1) return;
      const t = (el.textContent || "").trim();
      if (!t || t.length > 14) return;
      if (!re.test(t)) return;
      const r = clickableSize(el);
      if (r) out.push({ el, text: t, rect: r });
    });
    const seen = new Set();
    return out.filter((it) => {
      const k = it.text + "|" + Math.round(it.rect.top) + "|" + Math.round(it.rect.left);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /** 拿到「定时」radio（value=1）。找不到返回 null */
  function getTimingRadio() {
    // 1) 按 class + value 精确找
    let radios = queryAllDeep('input.weui-desktop-form__radio');
    if (!radios.length) radios = queryAllDeep('input[type="radio"]');
    if (!radios.length) return null;

    // 优先 value="1"；否则按旁边的文字判断「定时」
    let target = radios.find((r) => r.value === "1");
    if (!target) {
      for (const r of radios) {
        const label = r.closest ? r.closest("label") : null;
        const txt = label ? (label.textContent || "") : "";
        if (/^定时$|定时(发表|发布)/.test(txt.trim())) { target = r; break; }
      }
    }
    return target || null;
  }

  /** 「定时」是否已选中 */
  function isScheduleSelected() {
    const r = getTimingRadio();
    if (r) return !!r.checked;
    // 兜底：时间框已出现也算已切到定时
    return findTimeInput().length > 0;
  }

  /** 点选「定时」radio */
  function clickScheduleOption() {
    const radio = getTimingRadio();
    if (!radio) return { ok: false, reason: "页面上没有「定时」单选按钮" };
    if (radio.checked) return { ok: true, text: "定时", already: true };

    // 优先点 label（点 radio 本身有时不触发 React onChange）
    const label = radio.closest ? radio.closest("label") : null;
    const clickTarget = label || radio;

    // radio 的原生 click 会触发 checked + change
    try {
      radio.click();
    } catch (e) { /* 忽略 */ }
    if (!radio.checked) realClick(clickTarget);
    if (!radio.checked) {
      // 最后手段：直接设 checked 并派发事件
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
      radio.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return { ok: true, text: "定时", el: radio };
  }

  /** 向后兼容旧接口 */
  function findScheduleToggle() {
    const r = getTimingRadio();
    return r ? { hit: r, text: "定时", clickable: r.closest ? r.closest("label") : r } : null;
  }
  function isScheduleOn() { return isScheduleSelected(); }

  /**
   * 模拟真实点击（含 Pointer + Mouse 事件序列，兼容 React / Ant Design / 无界微前端）
   * v2.2.6：补上 pointerdown / pointerup —— 只发 MouseEvent 时，
   *        部分组件（尤其弹层里的按钮）监听的是 pointer 事件，会「点了没反应」。
   */
  function realClick(el, cx, cy) {
    if (!el) return false;
    let x = cx, y = cy;
    if (x === undefined || y === undefined) {
      const r = el.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + r.height / 2;
    }
    const base = {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, view: window,
      button: 0, buttons: 1, detail: 1,
    };
    // 1) Pointer 序列
    try {
      if (typeof PointerEvent === "function") {
        el.dispatchEvent(new PointerEvent("pointerover", Object.assign({}, base, { pointerId: 1, pointerType: "mouse", isPrimary: true })));
        el.dispatchEvent(new PointerEvent("pointerenter", Object.assign({}, base, { pointerId: 1, pointerType: "mouse", isPrimary: true })));
        el.dispatchEvent(new PointerEvent("pointerdown", Object.assign({}, base, { pointerId: 1, pointerType: "mouse", isPrimary: true })));
      }
    } catch (e) { /* 忽略 */ }
    // 2) Mouse 序列
    el.dispatchEvent(new MouseEvent("mousedown", base));
    try {
      if (typeof PointerEvent === "function") {
        el.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true })));
      }
    } catch (e) { /* 忽略 */ }
    el.dispatchEvent(new MouseEvent("mouseup", Object.assign({}, base, { buttons: 0 })));
    el.dispatchEvent(new MouseEvent("click", Object.assign({}, base, { buttons: 0 })));
    return true;
  }

  /** 把 "2026-10-16 12:35" 解析成 {y,m,d,h,mi} */
  function parseTime(s) {
    if (!s) return null;
    const m = String(s).match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
    if (!m) return null;
    return { y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
  }

  /** 找时间输入框（视频号：readonly input, placeholder="请选择发表时间"） */
  function findTimeInput() {
    const cands = [];
    // 优先精确匹配视频号的选择器
    queryAllDeep('input[placeholder*="发表时间"], input[placeholder*="选择时间"], input[placeholder*="时间"]')
      .forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 10) return;
        cands.push({ el, ph: el.getAttribute("placeholder") || "", cls: String(el.className || ""), rect: r });
      });
    if (cands.length) return rankTimeInputs(cands);

    // 兜底：按 class / placeholder 关键词
    queryAllDeep("input").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 10) return;
      const ph = (el.getAttribute("placeholder") || "") + "";
      const cls = String(el.className || "");
      if (/时间|日期|time|date|picker/i.test(ph) || /picker|time|date/i.test(cls)) {
        cands.push({ el, ph, cls, rect: r });
      }
    });
    return rankTimeInputs(cands);
  }

  /** 时间框排序：placeholder 越像「发表时间」越靠前，避免点到别的时间控件 */
  function rankTimeInputs(cands) {
    return cands.slice().sort((a, b) => {
      const s = (it) => /发表时间/.test(it.ph) ? 0 : (/时间/.test(it.ph) ? 1 : 2);
      return s(a) - s(b);
    });
  }

  /**
   * 在时间输入框里填值。
   * v2.2.6：readonly 也照样写 —— React 受控组件靠 input 事件回写 state，
   *         写完后若 300ms 仍保持目标值，就说明组件真的认了（比开面板稳）。
   */
  function fillTimeInput(el, t) {
    if (!el) return false;
    const pad = (n) => String(n).padStart(2, "0");
    const val = `${t.y}-${pad(t.m)}-${pad(t.d)} ${pad(t.h)}:${pad(t.mi)}`;
    el.focus();
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      try {
        const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) {
          desc.set.call(el, val);
        } else {
          el.value = val;
        }
      } catch (e) {
        log("时间框赋值异常", e);
        try { el.value = val; } catch (e2) {}
      }
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      log("直接写时间框（readonly=" + el.readOnly + "）→", el.value);
      return el.value === val;
    }
    return false;
  }

  /* ---------- 弹层（对话框 / 遮罩）通用处理 ---------- */
  // ★「上传成功但没设置成功」「定时窗口开了却没设上」多半是弹层没关：
  //   封面弹层/遮罩还挂在页面上，后面的点击全被它吃掉，看起来就是「点了没反应」。

  /** 找当前可见的弹层容器（Ant Design modal / 自绘 dialog / 抽屉） */
  function findModal() {
    const sels = [
      ".ant-modal-wrap", ".ant-modal", ".ant-drawer",
      "[class*='modal']", "[class*='Modal']",
      "[class*='dialog']", "[class*='Dialog']",
      "[class*='drawer']", "[class*='popup-wrapper']",
    ];
    let best = null, bestArea = 0;
    for (const s of sels) {
      for (const el of queryAllDeep(s)) {
        if (!shown(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 220 || r.height < 120) continue;
        const cls = String(el.className || "");
        // 时间/日期面板不是「要关掉的弹层」，别误伤
        if (/picker|calendar|date|time/i.test(cls)) continue;
        // 别把自己面板当成弹层
        try { if (panel && (panel === el || panel.contains(el) || el.contains(panel))) continue; } catch (e) {}
        const area = r.width * r.height;
        if (area > bestArea) { bestArea = area; best = el; }
      }
    }
    return best;
  }

  /** 元素是否处在某个浮层容器里（弹层/下拉/浮出面板），用于兜底找确认按钮 */
  function inOverlay(el) {
    let p = el;
    for (let i = 0; i < 10 && p && p !== document.body; i++, p = p.parentElement) {
      const cls = String(p.className || "");
      if (/overlay|popover|popup|modal|dialog|dropdown|drawer|float|picker|layer|panel/i.test(cls)) return true;
      const tag = p.tagName;
      if (tag === "DL" || tag === "DD") return true;
    }
    return false;
  }

  /** 弹层里/页面上找「确定类」确认按钮（不会误点到发表/取消） */
  function findConfirmButton(scope) {
    const OK = /^(确定|完成|保存|应用|使用|提交|确认|下一步|OK|ok|Done)$/;
    const BAD = /取消|关闭|返回|重选|重新|删除/;
    const pools = [];
    if (scope) pools.push(scope);
    const m = findModal();
    if (m) pools.push(m);
    pools.push(document.body); // 兜底：浮层没被识别成 modal 时也能找到

    for (const pool of pools) {
      const hit = [...pool.querySelectorAll("button,a,div[role='button'],span")].filter((el) => {
        if (el.children.length > 1) return false;
        const t = (el.textContent || "").trim();
        if (!t || t.length > 8) return false;
        if (!OK.test(t) || BAD.test(t)) return false;
        if (!shown(el)) return false;
        if (el.disabled) return false;
        const cls = String(el.className || "") + " " + String(el.parentElement ? el.parentElement.className || "" : "");
        if (/disabled|is-disabled/i.test(cls)) return false;
        if (insideNav(el)) return false;
        try { if (panel && panel.contains(el)) return false; } catch (e) {}
        // 全页兜底时，只允许浮层内的按钮，避免点到页面主操作
        if (pool === document.body && !inOverlay(el)) return false;
        return true;
      });
      if (hit.length) {
        // 有多个时取最靠下/最靠右的（弹层按钮通常在底部右侧）
        hit.sort((a, b) => (b.getBoundingClientRect().top - a.getBoundingClientRect().top));
        return hit[0];
      }
    }
    return null;
  }

  /** 按 Esc（对当前焦点/文档），不产生点击 */
  function pressEsc() {
    const t = document.activeElement && document.activeElement.dispatchEvent
      ? document.activeElement : document.body;
    for (const type of ["keydown", "keyup"]) {
      try {
        t.dispatchEvent(new KeyboardEvent(type, {
          key: "Escape", code: "Escape", keyCode: 27, which: 27,
          bubbles: true, cancelable: true, composed: true,
        }));
      } catch (e) {}
    }
  }

  /** 关掉挡路的弹层（Esc → 关闭 X）。返回是否已无弹层 */
  async function dismissOverlays(rounds) {
    rounds = rounds || 3;
    for (let i = 0; i < rounds; i++) {
      const m = findModal();
      if (!m) return true;
      log("发现遮挡弹层，尝试关闭：", String(m.className || "").slice(0, 60));
      pressEsc();
      await new Promise((r) => setTimeout(r, 300));
      if (!findModal()) return true;
      const closeBtn = [...m.querySelectorAll("button,span,a,i,div")].find((el) => {
        if (el.children.length > 1) return false;
        if (!shown(el)) return false;
        const cls = String(el.className || "");
        const aria = el.getAttribute("aria-label") || "";
        return /close|关闭|×|✕|✖/.test(cls) || /关闭|close/i.test(aria);
      });
      if (closeBtn) {
        realClick(closeBtn);
        await new Promise((r) => setTimeout(r, 400));
        if (!findModal()) return true;
      }
    }
    return !findModal();
  }

  /** 上传/选择完成后，自动点掉弹层里的「确定」，让设置真正生效 */
  async function confirmDialog(what, maxMs) {
    maxMs = maxMs || 30000;
    const t0 = Date.now();
    let clicked = false;
    while (Date.now() - t0 < maxMs) {
      const btn = findConfirmButton();
      if (btn) {
        const txt = (btn.textContent || "").trim();
        realClick(btn);
        clicked = true;
        log(what + "：已点「" + txt + "」");
        await new Promise((r) => setTimeout(r, 800));
        if (!findModal()) {
          status(`${what}已确认（点了「${txt}」）`, true);
          return true;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    status(clicked
      ? `${what}：已点确认，但弹层仍在，请手动看一眼页面`
      : `${what}：没等到可点的确认按钮，请手动点「确定/完成」`, clicked);
    return false;
  }

  /* ---------- 日期/时间面板操作（视频号 weui-desktop-picker） ---------- */

  /**
   * 找到展开的日期/时间面板。
   * v2.2.6：不再只认 weui-desktop-picker 一种 class —— 页面改版/换组件时，
   *         老选择器全部落空 → 面板其实开着，脚本却当它不存在 →「开了但没设置」。
   *         现在按「谁更像时间面板」打分选最优：含日期表格 + 时/分列表 + picker 类名。
   */
  function findPickerPanel() {
    const sels = [
      ".weui-desktop-picker__dd",
      ".weui-desktop-picker__panel",
      ".weui-desktop-picker",
      "[class*='desktop-picker']",
      "[class*='date-picker']",
      "[class*='datepicker']",
      "[class*='time-picker']",
      "[class*='picker']",
      "[class*='calendar']",
      "[class*='dropdown']",
      "[class*='popover']",
      "[class*='popper']",
    ];
    const seen = new Set();
    const cands = [];
    for (const s of sels) {
      for (const el of queryAllDeep(s)) {
        if (seen.has(el)) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        if (r.width < 150 || r.height < 80) continue;
        const st = getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden") continue;

        let score = 0;
        const cls = String(el.className || "");
        if (/weui-desktop-picker/.test(cls)) score += 60;
        if (/date|calendar|time/.test(cls)) score += 20;
        if (el.querySelector("table")) score += 40;
        if (el.querySelector("[class*='time__hour'], [class*='time__minute'], [class*='hour'], [class*='minute']")) score += 30;
        // 纯数字日期格子越多越像日历
        const dayCells = [...el.querySelectorAll("a,td,li,span")].filter((n) => {
          if (n.children.length) return false;
          return /^\d{1,2}$/.test((n.textContent || "").trim());
        }).length;
        if (dayCells >= 20) score += 40;
        else if (dayCells >= 7) score += 15;
        if (score <= 0) continue;
        score += Math.min(20, r.width * r.height / 20000);
        cands.push({ el, score, rect: r });
      }
    }
    if (!cands.length) return null;
    cands.sort((a, b) => b.score - a.score);
    if (cands.length > 1) {
      log("时间面板候选：", cands.slice(0, 4).map((c) =>
        Math.round(c.score) + ":" + String(c.el.className || "").slice(0, 40)).join(" | "));
    }
    return cands[0].el;
  }

  /** 读面板当前显示的「年-月」（找不到返回 null） */
  function panelYearMonth(panel) {
    if (!panel) return null;
    const zones = [...panel.querySelectorAll("*")].filter((el) => {
      if (el.children.length > 2) return false;
      const cls = String(el.className || "");
      if (!/title|head|current|caption|label|switch|nav/i.test(cls)) return false;
      return shown(el);
    });
    const pool = zones.length ? zones : [panel];
    for (const el of pool) {
      const t = (el.textContent || "").trim();
      const m = t.match(/(20\d{2})\D{0,3}(\d{1,2})/);
      if (m) return { y: +m[1], m: +m[2] };
    }
    const all = (panel.textContent || "").trim();
    const m2 = all.match(/(20\d{2})\D{0,3}(\d{1,2})/);
    return m2 ? { y: +m2[1], m: +m2[2] } : null;
  }

  /** 点面板上的「上一月 / 下一月」。dir=-1 上一月，1 下一月 */
  function flipMonth(panel, dir) {
    const wantPrev = dir < 0;
    const cand = [...panel.querySelectorAll("a,button,span,div,i")].filter((el) => {
      if (el.children.length > 1) return false;
      if (!shown(el)) return false;
      const cls = String(el.className || "");
      const t = (el.textContent || "").trim();
      if (/disabled/.test(cls)) return false;
      if (new RegExp(wantPrev ? "prev|last|before|left|back" : "next|forward|right", "i").test(cls)) return true;
      if (wantPrev && /^[‹〈<《]$/.test(t)) return true;
      if (!wantPrev && /^[›〉>》]$/.test(t)) return true;
      return false;
    });
    if (!cand.length) { log("面板里找不到翻月按钮 dir=" + dir); return false; }
    realClick(cand[0]);
    return true;
  }

  /** 确保面板显示的是目标年月（最多翻 24 次） */
  async function ensureMonth(panel, t) {
    for (let i = 0; i < 24; i++) {
      const cur = panelYearMonth(panel);
      if (!cur) return true; // 读不出来就不折腾，直接按数字点
      const diff = (t.y - cur.y) * 12 + (t.m - cur.m);
      if (diff === 0) return true;
      if (!flipMonth(panel, diff > 0 ? 1 : -1)) return false;
      await new Promise((r) => setTimeout(r, 350));
    }
    return false;
  }

  /** 在日期面板里点选某一天（v2.2.6：支持 td/li/span 日历格 + 自动翻月） */
  async function clickDay(panel, t) {
    await ensureMonth(panel, t);

    const cells = [...panel.querySelectorAll("a,td,li,span,div")].filter((el) => {
      if (el.children.length) return false;                 // 只取叶子节点
      const txt = (el.textContent || "").trim();
      if (!/^\d{1,2}$/.test(txt)) return false;
      if (!shown(el)) return false;
      const cls = String(el.className || "");
      if (/disabled|is-disabled|not-current|other-month|prev-month|next-month|outside|gray/i.test(cls)) return false;
      if (el.getAttribute && el.getAttribute("aria-disabled") === "true") return false;
      return true;
    });

    const nums = cells.map((el) => (el.textContent || "").trim()).join(",");
    let target = cells.find((el) => parseInt((el.textContent || "").trim(), 10) === t.d);
    if (!target) {
      // 有些日历「今天」格子里不是纯数字，退一步按 title/aria-label 匹配
      target = [...panel.querySelectorAll("[title],[aria-label]")].find((el) => {
        const s = (el.getAttribute("title") || "") + " " + (el.getAttribute("aria-label") || "");
        return new RegExp(t.y + "[-\\D]*" + t.m + "[-\\D]*" + t.d).test(s);
      });
    }
    if (!target) {
      log("面板里找不到日期", t.d, "候选:", nums);
      return false;
    }
    const cls = String(target.className || "");
    log("点选日期", t.d, "| 元素", target.tagName + "." + cls.slice(0, 50));
    realClick(target);
    await new Promise((r) => setTimeout(r, 350));
    return true;
  }

  /** 可见性（含祖先 display/visibility 检查，比 visible() 严格） */
  function shown(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    let p = el;
    for (let i = 0; i < 8 && p && p !== document.body; i++, p = p.parentElement) {
      try {
        const st = getComputedStyle(p);
        if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
      } catch (e) { break; }
    }
    return true;
  }

  /** 找「时」或「分」的选项列表（跨 Shadow，取可见的那个） */
  function findTimeList(kind) {
    const lists = queryAllDeep(`.weui-desktop-picker__time__${kind}`);
    return lists.find(shown) || null;
  }

  /**
   * 时间选择器整体根节点（涵盖日期区 + 底部「时间」区）。
   * ★ v2.7.0 根因修复：真实结构里日期和时分是**两个不同的 dd**——
   *     <div class="weui-desktop-picker__panel-fd">
   *       <dl class="weui-desktop-picker__time">
   *         <dt>…<input placeholder="请选择时间">…</dt>
   *         <dd class="weui-desktop-picker__dd__time weui-desktop-picker__dd">
   *            <ul class="weui-desktop-picker__recode"><li>时</li><li>分</li></ul>
   *            <ol class="weui-desktop-picker__time__hour">…</ol>
   *            <ol class="weui-desktop-picker__time__minute">…</ol>
   *         </dd>
   *       </dl>
   *     </div>
   *   老代码把 findPickerPanel()（几乎必然命中的是「日期 dd」）当成整块面板，
   *   时分列表根本不在它里面 → 永远「日期能选、时间设不上」。
   */
  function pickerRoot() {
    const seeds = []
      .concat(queryAllDeep(".weui-desktop-picker__time__hour"))
      .concat(queryAllDeep(".weui-desktop-picker__time__minute"))
      .concat(queryAllDeep(".weui-desktop-picker__time"))
      .concat(queryAllDeep('input[placeholder*="请选择时间"]'));

    for (const seed of seeds) {
      let p = seed, best = null;
      for (let i = 0; i < 12 && p && p !== document.body; i++, p = p.parentElement) {
        if (/weui-desktop-picker/.test(String(p.className || ""))) best = p;
      }
      if (best && shown(best)) return best;
    }
    return findPickerPanel();
  }

  /** 读面板底部时间框当前值（只含 HH:MM，没有返回 ""） */
  function readPanelTime() {
    const root = pickerRoot();
    let el = null;
    try {
      if (root) el = root.querySelector('input[placeholder*="请选择时间"]') ||
                       root.querySelector(".weui-desktop-picker__time input");
    } catch (e) { /* 忽略 */ }
    if (!el) el = queryAllDeep('input[placeholder*="请选择时间"]').find(shown) || null;
    return el ? String(el.value || "").trim() : "";
  }

  /** 从「选中态」读回当前时 / 分（读不到返回 null） */
  function selectedVal(kind) {
    const lis = queryAllDeep(`.weui-desktop-picker__time__${kind} li`);
    const hit = lis.find((li) =>
      /selected|current|active|checked/i.test(String(li.className || "")) &&
      /^\d{1,2}$/.test((li.textContent || "").trim()));
    return hit ? parseInt((hit.textContent || "").trim(), 10) : null;
  }

  /** 面板底部「确定 / 完成」按钮（允许在 picker 内部，和页面的「发表」区分开） */
  function findPickerConfirm(root) {
    const scope = root || pickerRoot();
    if (!scope || !scope.querySelectorAll) return null;
    const OK = /^(确定|完成|保存|应用|使用|确认|OK|ok|Done)$/;
    const hit = [...scope.querySelectorAll("button,a,span,div[role='button']")].filter((el) => {
      if (el.children.length > 1) return false;
      const t = (el.textContent || "").trim();
      if (!OK.test(t)) return false;
      if (!shown(el)) return false;
      if (el.disabled) return false;
      return !/disabled/i.test(String(el.className || ""));
    });
    return hit[0] || null;
  }

  /** 选项是否已被标记为选中 */
  function isSelected(li) {
    return /selected|current|active|checked/i.test(String((li && li.className) || ""));
  }

  /** 点选一个 li 并确认它变成选中态；不成再换两种点法（视频号这层偶尔会吞 click） */
  async function clickOption(li, list) {
    if (!li) return false;
    try { li.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) { /* 忽略 */ }
    await new Promise((r) => setTimeout(r, 60));

    realClick(li);
    await new Promise((r) => setTimeout(r, 150));
    if (isSelected(li)) return true;

    try { li.click(); } catch (e) { /* 忽略 */ }
    await new Promise((r) => setTimeout(r, 150));
    if (isSelected(li)) return true;

    if (list) {
      const r = li.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) {
        realClick(list, r.left + r.width / 2, r.top + r.height / 2);
        await new Promise((r2) => setTimeout(r2, 150));
        if (isSelected(li)) return true;
      }
    }
    return false;
  }

  /**
   * 展开底部的时 / 分列表 —— 这层 dd 是收起的，必须先点时间框（或 dt / 图标）
   * 才会渲染出来。以前只在一个 dd 里找触发器，所以永远点不到。
   */
  async function expandTimeArea() {
    let list = findTimeList("hour");
    if (list) return list;

    const root = pickerRoot() || document.body;
    const pick = (sel) => {
      try { return [...root.querySelectorAll(sel)].filter(shown); } catch (e) { return []; }
    };
    const cands = []
      .concat(pick(".weui-desktop-picker__time .weui-desktop-picker__dt"))
      .concat(pick('.weui-desktop-picker__time input'))
      .concat(pick(".weui-desktop-picker__value_input"))
      .concat(pick(".weui-desktop-icon__time"))
      .concat(pick(".weui-desktop-picker__value"))
      .concat(pick(".weui-desktop-picker__time"));

    for (const el of cands) {
      // 合成事件不会像真鼠标那样自动聚焦，输入框要显式 focus 一下（部分实现靠 focus 展开）
      try { if (el.tagName === "INPUT" && el.focus) el.focus(); } catch (e) { /* 忽略 */ }
      realClick(el);
      await new Promise((r) => setTimeout(r, 320));
      list = findTimeList("hour");
      if (list) {
        log("已展开时/分列表：点", el.tagName + "." + String(el.className || "").slice(0, 40));
        return list;
      }
    }

    // root 里一个候选都没有（时间区可能在另一个浮层里）→ 全页找一遍「时间」区
    if (!cands.length) {
      const wide = queryAllDeep(".weui-desktop-picker__time, .weui-desktop-picker__time-value, .weui-desktop-icon__time")
        .filter(shown);
      for (const el of wide) {
        realClick(el);
        await new Promise((r) => setTimeout(r, 300));
        list = findTimeList("hour");
        if (list) {
          log("全页兜底展开时/分列表：点", el.tagName + "." + String(el.className || "").slice(0, 40));
          return list;
        }
      }
    }
    log("点时间框后时分列表仍未出现");
    return null;
  }

  /**
   * 从选项里挑值：精确优先；没有精确值就**向下**取最近档位。
   * ★ 视频号的分钟常是 5 分钟一档（00/05/10…），计划时间 12:03 没有「03」，
   *   旧版直接 return false → 分钟保持默认 → 用户看到「日期对、时间错」。
   */
  function chooseOption(list, want) {
    const items = [...list.querySelectorAll("li")].filter((li) => {
      const t = (li.textContent || "").trim();
      if (!/^\d{1,2}$/.test(t)) return false;
      if (/disabled/.test(String(li.className))) return false;
      if (li.getAttribute && li.getAttribute("aria-disabled") === "true") return false;
      return true;
    });
    if (!items.length) return null;
    const v = (li) => parseInt((li.textContent || "").trim(), 10);

    const exact = items.find((li) => v(li) === want);
    if (exact) return { el: exact, v: want, exact: true };

    // 没有精确档位：在本单位内取**最近**的一个（不跨小时/进位）
    // 例：分钟是 5 分钟一档时，03 → 05（差 2）比 00（差 3）更接近
    let lower = null, upper = null;
    for (const li of items) {
      const x = v(li);
      if (x <= want) { if (!lower || x > v(lower)) lower = li; }
      else if (!upper || x < v(upper)) upper = li;
    }
    let best = lower;
    if (upper && (!lower || (v(upper) - want) < (want - v(lower)))) best = upper;
    if (!best) best = upper || lower;
    return { el: best, v: v(best), exact: false };
  }

  /**
   * 确保「时」或「分」列表可见。
   * v2.7.0：先点「时 / 分」小标签切换列；再点时间框把收起的 dd 展开；
   *         最后才走老的多点几次兜底。
   */
  async function ensureTimeList(kind) {
    let list = findTimeList(kind);
    if (list) return list;

    const root = pickerRoot() || document.body;
    const tabText = kind === "hour" ? "时" : "分";

    // 1) 底部那排「时 / 分」标签：点了只切列，不会关面板
    let tabs = [];
    try { tabs = [...root.querySelectorAll(".weui-desktop-picker__recode li")]; } catch (e) { /* 忽略 */ }
    const tab = tabs.find((li) => (li.textContent || "").trim() === tabText && shown(li));
    if (tab) {
      realClick(tab);
      await new Promise((r) => setTimeout(r, 260));
      list = findTimeList(kind);
      if (list) {
        log(`已切到「${tabText}」列表`);
        return list;
      }
    }

    // 2) 整个时间区还没展开 → 点时间框 / dt / 图标
    list = await expandTimeArea();
    if (list && kind === "hour") return list;
    list = findTimeList(kind);
    if (list) return list;

    // 3) 兜底：面板里任何 class 沾边或文本是「时 / 分」的元素
    const panel = pickerRoot() || findPickerPanel();
    if (panel) {
      for (let i = 0; i < 3; i++) {
        const trig = [...panel.querySelectorAll("*")].find((el) => {
          if (el.tagName === "OL" || el.tagName === "UL") return false;
          const cls = String(el.className || "");
          const t = (el.textContent || "").trim();
          if (cls.includes("time__" + kind)) return shown(el);
          if (kind === "hour" && (t === "时" || t === "小时")) return shown(el);
          if (kind === "minute" && (t === "分" || t === "分钟")) return shown(el);
          return false;
        });
        if (trig) {
          realClick(trig);
          await new Promise((r) => setTimeout(r, 350));
          list = findTimeList(kind);
          if (list) return list;
        }
      }
    }

    log(`始终找不到可见的「${kind}」列表`);
    return null;
  }

  /** 依次点选 小时 / 分钟，并回报实际选中的值 */
  async function setHourMinute(t) {
    const out = { okH: false, okM: false, hv: null, mv: null, hSel: null, mSel: null };

    const hourList = await ensureTimeList("hour");
    if (hourList) {
      const c = chooseOption(hourList, t.h);
      if (c) {
        out.hv = c.v;
        out.hSel = await clickOption(c.el, hourList);
        out.okH = true;
        log(`小时：目标 ${t.h} → 点 ${c.v}${c.exact ? "" : "（无精确档位，取最近）"}` +
          (out.hSel ? " ✓已选中" : " △未看到选中态，最后看回读"));
      } else {
        log("小时列表里没有可选项", [...hourList.querySelectorAll("li")].map((x) => (x.textContent || "").trim()).join(","));
      }
      await new Promise((r) => setTimeout(r, 260));
    } else {
      log("小时列表拿不到（时间区没展开）");
    }

    // 点完小时面板可能重渲染 / 切走，必须重新找
    const minList = await ensureTimeList("minute");
    if (minList) {
      const c = chooseOption(minList, t.mi);
      if (c) {
        out.mv = c.v;
        out.mSel = await clickOption(c.el, minList);
        out.okM = true;
        log(`分钟：目标 ${t.mi} → 点 ${c.v}${c.exact ? "" : "（无精确档位，取最近）"}` +
          (out.mSel ? " ✓已选中" : " △未看到选中态，最后看回读"));
      } else {
        log("分钟列表里没有可选项", [...minList.querySelectorAll("li")].map((x) => (x.textContent || "").trim()).join(","));
      }
      await new Promise((r) => setTimeout(r, 300));
    } else {
      log("分钟列表拿不到（时间区没展开）");
    }
    return out;
  }

  /**
   * 读回时间框当前显示的值，用于校验。
   * ★ v2.7.0：面板里还有一个 placeholder="请选择时间" 的**只读回显框**（只有 HH:MM），
   *   老代码取 c[0] 有时会拿到它，于是「日期时间 2026-10-18 09:00」永远比不上「09:00」，
   *   校验失败 → 误报「时间没设上」。这里优先取带日期的那个（页面上「请选择发表时间」）。
   */
  function readTimeValue() {
    const c = findTimeInput();
    if (!c.length) return "";
    const withDate = c.find((it) =>
      /\d{4}\D{1,3}\d{1,2}\D{1,3}\d{1,2}/.test(String(it.el.value || "")));
    const pick = withDate || c.find((it) => /发表时间/.test(it.ph)) || c[0];
    return String(pick.el.value || "").trim();
  }

  /**
   * 通过面板设置时间：点时间框 → 展开面板 → 点日期 → 点时分。
   * 视频号的时间框是 readonly，必须走这条路。
   */
  async function setTimeByPanel(targetTime) {
    // 0) 先清掉可能挡住面板的弹层（封面弹层没关 → 后面所有点击都被它吃掉）
    await dismissOverlays(2);

    const inputs = findTimeInput();
    if (!inputs.length) {
      log("找不到时间输入框");
      return { ok: false, dayOk: false, hm: {}, shownVal: "" };
    }
    const box = inputs[0].el;

    // 1) 点开面板
    realClick(box);
    if (box.parentElement) realClick(box.parentElement);
    await new Promise((r) => setTimeout(r, 500));

    let panel = findPickerPanel();
    if (!panel) {
      log("点击后未展开面板，再试一次");
      if (box.closest) {
        const dl = box.closest("dl");
        if (dl) realClick(dl);
      }
      await new Promise((r) => setTimeout(r, 600));
      panel = findPickerPanel();
    }
    if (!panel) {
      log("始终无法展开日期面板");
      // 把页面上所有浮层列出来，方便定位
      log("当前可见浮层：", queryAllDeep("[class*='picker'],[class*='popover'],[class*='dropdown'],[class*='modal'],[class*='dialog']")
        .filter(shown).map((el) => String(el.className || "").slice(0, 50)).join(" | "));
      return { ok: false, dayOk: false, hm: {}, shownVal: "" };
    }
    log("已定位时间面板：", String(panel.className || "").slice(0, 60));

    // 2) 点选日期
    const dayOk = await clickDay(panel, targetTime);
    await new Promise((r) => setTimeout(r, 400));

    // 3) 点选时分（每次都重新找列表：点日期会重渲染，点小时会切换面板）
    let hm = await setHourMinute(targetTime);
    if (!hm.okH && !hm.okM) {
      // 时/分一次都没点上：多半是点日期时面板被重渲染收起了，重开一次再试
      log("时/分都没点上，重开面板再试一次");
      const again = findTimeInput();
      if (again.length) {
        try { again[0].el.focus(); } catch (e) { /* 忽略 */ }
        realClick(again[0].el);
        await new Promise((r) => setTimeout(r, 600));
        hm = await setHourMinute(targetTime);
      }
    }
    await new Promise((r) => setTimeout(r, 300));

    // 4) 提交：面板/页面上的「确定 / 完成 / 保存」。
    //    ★ 少了这一步，选的值不会写回时间框 —— 就是「窗口开了却没设置」。
    //    v2.7.0：面板底部自己的「确定」优先（老代码把 picker 内部的按钮排除了，等于永远点不到）。
    let confirmed = false;
    const root = pickerRoot();
    const okBtn = findPickerConfirm(root) || findPickerConfirm(panel) || findConfirmButton(panel);
    if (okBtn) {
      const txt = (okBtn.textContent || "").trim();
      realClick(okBtn);
      confirmed = true;
      log("已点时间面板的「" + txt + "」提交");
      await new Promise((r) => setTimeout(r, 500));
    }

    // 5) 收起时间弹层（v2.2.1：只点主内容区空白处，绝不碰左侧导航）
    if (!confirmed || findPickerPanel()) await closePickerByBlankClick();

    // 6) 读回校验：页面日期框 + 面板时间框 + 选中态，三者任一能对上就算对
    const pad = (n) => String(n).padStart(2, "0");
    const selH = selectedVal("hour");
    const selM = selectedVal("minute");
    const useH = selH != null ? selH : (hm.hv != null ? hm.hv : targetTime.h);
    const useM = selM != null ? selM : (hm.mv != null ? hm.mv : targetTime.mi);
    const wantHM = `${pad(useH)}:${pad(useM)}`;
    const shownVal = readTimeValue();
    const panelVal = readPanelTime();
    const dayStr = `${targetTime.y}-${pad(targetTime.m)}-${pad(targetTime.d)}`;
    const dayStr2 = `${targetTime.y}/${pad(targetTime.m)}/${pad(targetTime.d)}`;

    const fullVal = [shownVal, panelVal].filter(Boolean).join(" | ");
    const hmMatch = !!fullVal && (fullVal.includes(wantHM) ||
      fullVal.includes(`${useH}:${pad(useM)}`));
    const dayMatch = !!shownVal && (shownVal.includes(dayStr) || shownVal.includes(dayStr2) ||
      shownVal.includes(`${targetTime.m}月${targetTime.d}日`));
    // 时间框是空的（有的主题只存 state 不回显）→ 用选中态兜底判断
    const ok = (fullVal ? hmMatch : (selH != null && selM != null)) &&
      (dayOk || dayMatch);

    log("面板操作结果：日期", dayOk, "| 时分", hm, "| 选中态", selH + ":" + pad(selM == null ? 0 : selM),
      "| 页面框", shownVal, "| 面板时间框", panelVal,
      "| 目标", `${dayStr} ${pad(targetTime.h)}:${pad(targetTime.mi)}`);
    if (!ok) {
      log("⚠ 回读与预期不符：期望时分", wantHM, "，实际", fullVal || "(空)");
    }
    return { ok, dayOk, dayMatch, hm, shownVal: shownVal || panelVal, panelVal, selH, selM };
  }

  /** 元素是否位于导航 / 侧边栏区域（视频号左侧「草稿箱」就在这一片） */
  function insideNav(el) {
    let p = el;
    for (let i = 0; i < 8 && p && p !== document.body; i++, p = p.parentElement) {
      const cls = String(p.className || "");
      const role = (p.getAttribute && p.getAttribute("role")) || "";
      if (/^(NAV|ASIDE|HEADER|FOOTER)$/.test(p.tagName)) return true;
      if (/^(navigation|menu|menuitem)$/.test(role)) return true;
      if (/sidebar|sider|left-nav|nav-|menu|aside|drawer/i.test(cls)) return true;
    }
    return false;
  }

  /** 判断某元素是否「点了会跳走」，禁止当成空白区点击 */
  function isRiskyClickTarget(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    try {
      if (panel && panel.contains(el)) return true;
    } catch (e) {}
    if (insideNav(el)) return true;
    let p = el;
    for (let i = 0; i < 6 && p && p !== document.body; i++, p = p.parentElement) {
      const cls = String(p.className || "");
      const role = (p.getAttribute && p.getAttribute("role")) || "";
      if (p.tagName === "A" && (p.getAttribute("href") || "")) return true;
      if (/^(LI|UL|OL)$/.test(p.tagName)) return true;
      if (/^(tab|link|option)$/.test(role)) return true;
      if (/list-item|draft/i.test(cls)) return true;
    }
    try {
      if (getComputedStyle(el).cursor === "pointer") return true;
    } catch (e) {}
    return false;
  }

  /** 在主内容区找一块安全空白点：只在屏幕右侧取点，避开左侧导航与面板 */
  function pickSafeBlankPoint(panelRect) {
    const W = innerWidth, H = innerHeight;
    const xs = [0.66, 0.76, 0.86, 0.56].map((f) => Math.round(W * f));
    const ys = [0.78, 0.64, 0.5, 0.88].map((f) => Math.round(H * f));
    for (const y of ys) {
      for (const x of xs) {
        if (x < 0 || y < 0 || x >= W - 6 || y >= H - 6) continue;
        if (panelRect && x >= panelRect.left && x <= panelRect.right &&
            y >= panelRect.top && y <= panelRect.bottom) continue;
        const el = document.elementFromPoint(x, y);
        if (!el || isRiskyClickTarget(el)) continue;
        return { x, y };
      }
    }
    return null;
  }

  /** 收起时间弹层。
   *  ★ 视频号的左侧导航里有「草稿箱」，用坐标乱点会误跳过去，
   *    所以优先用 Esc / 失焦这类「不产生点击」的方式；
   *    最后才在主内容区空白处点，且点前必须通过安全校验。
   */
  async function closePickerByBlankClick() {
    const startUrl = location.href;

    // 1) 面板自带的「确定」按钮：不离开面板，绝对安全
    let panel = findPickerPanel();
    if (panel) {
      const okBtn = findPickerConfirm(pickerRoot()) || findConfirmButton(panel);
      if (okBtn) {
        realClick(okBtn);
        await new Promise((r) => setTimeout(r, 300));
        if (!findPickerPanel()) return true;
      }
    }

    // 2) 按 Esc（不点任何地方）
    const box = (findTimeInput()[0] || {}).el || document.activeElement;
    for (let i = 0; i < 2; i++) {
      try {
        const t = (box && box.dispatchEvent) ? box : document.body;
        ["keydown", "keyup"].forEach((type) =>
          t.dispatchEvent(new KeyboardEvent(type, {
            key: "Escape", code: "Escape", keyCode: 27, which: 27,
            bubbles: true, cancelable: true,
          }))
        );
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 220));
      if (!findPickerPanel()) { log("已用 Esc 收起时间弹层"); return true; }
    }

    // 3) 让时间框失焦（仍不点导航）
    try {
      if (box && box.blur) box.blur();
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 220));
    if (!findPickerPanel()) { log("已用失焦收起时间弹层"); return true; }

    // 4) 最后才用坐标点：只在主内容区空白处，且必须通过安全校验
    panel = findPickerPanel();
    const pt = pickSafeBlankPoint(panel ? panel.getBoundingClientRect() : null);
    if (pt) {
      const target = document.elementFromPoint(pt.x, pt.y);
      if (target && !isRiskyClickTarget(target)) {
        realClick(target, pt.x, pt.y);
        await new Promise((r) => setTimeout(r, 250));
        if (location.href !== startUrl) {
          log("⚠ 点空白后页面跳转了：", startUrl, "→", location.href);
          return false;
        }
        if (!findPickerPanel()) { log("已在主内容区空白处收起弹层", pt); return true; }
      }
    }

    log("时间弹层可能仍未收起；已停止尝试（避免误点左侧导航/草稿箱）");
    return !findPickerPanel();
  }

  /** 专门探测定时控件结构，结果复制到剪贴板 */
  function probeSchedule() {
    const out = { url: location.href, keywords: [], inputs: [], clicks: [], nearby: [] };

    // 1) 含定时相关字样的元素
    const kw = /定时|发表|发布|立即|prompt|schedule|time/i;
    queryAllDeep("div,span,label,p,button,li").forEach((el) => {
      if (el.children.length > 1) return;
      const t = (el.textContent || "").trim();
      if (!t || t.length > 16) return;
      if (kw.test(t)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          out.keywords.push({
            text: t,
            tag: el.tagName,
            cls: String(el.className || "").slice(0, 100),
            role: el.getAttribute("role") || "",
            at: Math.round(r.left) + "," + Math.round(r.top),
            size: Math.round(r.width) + "x" + Math.round(r.height),
            selfCls: String(el.className || "").slice(0, 60),
            parentTag: el.parentElement ? el.parentElement.tagName : "",
            parentCls: el.parentElement ? String(el.parentElement.className || "").slice(0, 80) : "",
          });
        }
      }
    });

    // 2) 时间/日期类输入框（详细属性）
    findTimeInput().forEach((it) => {
      const el = it.el;
      const r = el.getBoundingClientRect();
      out.inputs.push({
        tag: el.tagName,
        type: el.getAttribute("type") || "",
        cls: it.cls.slice(0, 120),
        ph: it.ph,
        value: el.value || "",
        readOnly: el.readOnly,
        disabled: el.disabled,
        ce: el.getAttribute("contenteditable") || "",
        at: Math.round(r.left) + "," + Math.round(r.top),
        size: Math.round(r.width) + "x" + Math.round(r.height),
        outer: (el.outerHTML || "").slice(0, 300),
        ancestors: (() => {
          const a = [];
          let cur = el.parentElement;
          for (let i = 0; i < 5 && cur; i++) {
            a.push(cur.tagName + "." + String(cur.className || "").slice(0, 60));
            cur = cur.parentElement;
          }
          return a;
        })(),
      });
    });

    // 3) switch / radio / checkbox 类元素
    queryAllDeep('[class*="switch"], [class*="Switch"], [role="switch"], input[type="checkbox"], [class*="radio"], [class*="Radio"], [role="radio"], [role="tab"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;
      out.clicks.push({
        tag: el.tagName,
        cls: String(el.className || "").slice(0, 100),
        role: el.getAttribute("role") || "",
        checked: el.checked !== undefined ? el.checked : null,
        ariaChecked: el.getAttribute("aria-checked") || "",
        text: (el.textContent || "").trim().slice(0, 20),
        at: Math.round(r.left) + "," + Math.round(r.top),
        size: Math.round(r.width) + "x" + Math.round(r.height),
      });
    });

    // 4) 视口下部的所有可见短文本（定时区通常在页面底部）
    queryAllDeep("div,span,label,p,button,li").forEach((el) => {
      if (el.children.length > 1) return;
      const t = (el.textContent || "").trim();
      if (!t || t.length > 16) return;
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return;
      if (r.top < innerHeight * 0.5) return; // 只看下半屏
      out.nearby.push({
        text: t,
        tag: el.tagName,
        cls: String(el.className || "").slice(0, 80),
        at: Math.round(r.left) + "," + Math.round(r.top),
        size: Math.round(r.width) + "x" + Math.round(r.height),
      });
    });
    out.nearby = out.nearby.slice(0, 60);

    const txt = JSON.stringify(out, null, 2);
    log("【定时控件探测】", out);
    console.log(txt);
    if (navigator.clipboard) {
      navigator.clipboard.writeText(txt).then(
        () => status(`已复制：关键词${out.keywords.length} 输入框${out.inputs.length} 开关${out.clicks.length}`, true),
        () => status(`结构见 Console（关键词${out.keywords.length} 输入框${out.inputs.length}）`, false)
      );
    } else {
      status(`结构见 Console（关键词${out.keywords.length} 输入框${out.inputs.length}）`, false);
    }
  }

  /** 主流程：设置定时发布（await 版，供一键流程串联）
   *  视频号默认「立即发表」，必须点选「定时发表」才会出现时间输入框。
   *  返回 {ok, text}
   */
  async function setSchedule() {
    // 0) 先关掉挡路的弹层（封面弹层没点「确定」就留着 → 后面点啥都没反应）
    await dismissOverlays(2);

    // 1) 处理「定时发表」不再出现的情况：若已有时间输入框，说明已在定时模式
    let inputs = findTimeInput();

    if (!inputs.length) {
      // 没找到时间框 → 需要点击「定时发表」选项切换
      const info = clickScheduleOption();
      if (!info.ok) {
        status("页面没有「定时发表」选项：" + info.reason + "，请点「探定时控件」发我", false);
        log("含「定/时/发表」的短文本：");
        queryAllDeep("div,span,label,p,button,li").forEach((el) => {
          if (el.children.length > 1) return;
          const t = (el.textContent || "").trim();
          if (t && t.length <= 14 && /定|时|立即|发表|发布/.test(t)) {
            const r = el.getBoundingClientRect();
            if (r.width > 0) log("  文本:", t, "| cls:", String(el.className || "").slice(0, 60));
          }
        });
        return { ok: false };
      }
      status(`已点选「${info.text}」，等待时间框出现…`);
      // 等输入框渲染（React 异步）
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 400));
        inputs = findTimeInput();
        if (inputs.length) break;
      }
      if (!inputs.length) {
        status(`已点选「${info.text}」但时间框没出现，请点「探定时控件」发我`, false);
        return { ok: false };
      }
    }

    // 2) 读任务时间并填入
    const { tasks, i } = await getTasksAsync();
    if (!tasks.length) { status("没有任务，请先导入", false); return { ok: false }; }
    const t = tasks[Math.min(i, tasks.length - 1)];
    const parsed = parseTime(t.time);
    if (!parsed) { status(`任务时间无法解析：${t.time || "(空)"}`, false); return { ok: false }; }
    const pad0 = (n) => String(n).padStart(2, "0");
    const wantStr = `${parsed.y}-${pad0(parsed.m)}-${pad0(parsed.d)} ${pad0(parsed.h)}:${pad0(parsed.mi)}`;

    // 3) 先试「直接写值」：React 受控组件会随 input 事件回写 state，
    //    写完 400ms 还在 → 说明真的设上了，比开面板稳得多（也最不容易被弹层干扰）
    //    ★ 面板里那个只读回显框（placeholder 恰为「请选择时间」）不能写完整日期时间，
    //      否则会把 HH:MM 冲成乱码，所以先排除掉。
    const fillables = inputs.filter((it) => !/^请选择时间/.test(it.ph));
    let ok = 0;
    fillables.forEach((it) => { if (fillTimeInput(it.el, parsed)) ok++; });
    log("尝试直接填时间:", t.time, "| 可写输入框", fillables.length, "成功", ok);
    if (ok) {
      await new Promise((r) => setTimeout(r, 500));
      const back = readTimeValue();
      if (back && back.replace(/\s+/g, " ").trim() === wantStr) {
        status(`已设为定时 ${back}，请核对后发表`, true);
        return { ok: true, text: back };
      }
      log("直接写值后回读不符：", back, "目标", wantStr, "→ 改走面板");
    }

    // 直接填值成功才收工；否则打开面板点选（视频号常规路径）
    {
      status("直接填值无效，打开日期面板点选…");
      const picked = await setTimeByPanel(parsed);
      // 收弹层有极小概率误跳页面（如左侧「草稿箱」），一发现就停手
      if (!isPostPage()) {
        log("⚠ 定时过程中页面被跳转：", location.href);
        status("页面被跳转了（多半是误点左侧导航），已停止。请回到发表视频页重试", false);
        return { ok: false, text: t.time };
      }
      const disp = picked && picked.shownVal ? picked.shownVal : t.time;
      if (picked && picked.ok) {
        status(`已设为定时 ${disp}，请核对后发表`, true);
        return { ok: true, text: disp };
      }
      if (picked && picked.dayOk) {
        // 日期进了、时分没对上：把实际情况讲清楚，别让人以为全设好了
        status(`日期已选，但时间可能没设对（框内现为「${disp || "空"}」，计划 ${t.time}），请手动核对`, false);
        return { ok: false, text: disp || t.time };
      }
      // 面板路子也没走通 → 最后一招：强制写值 + 派发事件再回读一次
      inputs.forEach((it) => fillTimeInput(it.el, parsed));
      await new Promise((r) => setTimeout(r, 600));
      const back2 = readTimeValue();
      if (back2 && back2.replace(/\s+/g, " ").trim() === wantStr) {
        status(`已设为定时 ${back2}（强制写入），请核对后发表`, true);
        return { ok: true, text: back2 };
      }

      status(`已切到定时，但面板设置失败（计划 ${t.time}），请手动选时间`, false);
      return { ok: false, text: t.time };
    }
  }

  /** ★ 一键流程（v2.1）：选视频 → 等上传完成 → 填内容 → 定时 → 发表 → 自动下一条 */
  async function oneClick() {
    const bad = checkPage();
    if (bad) { status(bad.msg, false); return; }

    const filled = await doFill();
    if (!filled) {
      status("内容未填入，请检查页面后重试", false);
      return;
    }

    const sched = await setSchedule();
    if (!sched.ok) {
      status(`内容已填入，但定时未成功（${sched.text || "—"}），请手动处理`, false);
      return;
    }
    status(`内容已填写，定时 ${sched.text} 已设置，请核对后发表`, true);
  }
  /** 找并点击页面上的「发表」按钮 */
  async function clickPublish() {
    // 视频号发布页底部按钮：文本为「发表」；也可能出现确认弹层
    let btn = findPublishButton();
    if (!btn) {
      log("未找到「发表」按钮，页面按钮文本候选：");
      queryAllDeep("button,div[role='button']").forEach((el) => {
        const t = (el.textContent || "").trim();
        if (t && t.length <= 8) {
          const r = el.getBoundingClientRect();
          if (r.width > 0) log("  按钮:", t, "| cls:", String(el.className || "").slice(0, 60));
        }
      });
      return { ok: false, reason: "没找到可点的发表按钮" };
    }

    realClick(btn);
    await new Promise((r) => setTimeout(r, 600));

    // 若弹出二次确认（如「确认发表」），再点一次
    const confirm = queryAllDeep("button,div[role='button']").find((el) => {
      const t = (el.textContent || "").trim();
      const r = el.getBoundingClientRect();
      return /^(确认发表|确认发布|确定|确认)$/.test(t) && r.width > 20 && r.height > 12;
    });
    if (confirm) {
      realClick(confirm);
      log("已点二次确认");
    }
    log("已点击「发表」");
    return { ok: true };
  }


  /* ---------- 队列数据 ---------- */
  const HAS_STORE = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

  function getTasks(cb) {
    if (!HAS_STORE) {
      cb([], 0);
      return;
    }
    chrome.storage.local.get([STORE_KEY, STORE_IDX], (r) => {
      cb(r[STORE_KEY] || [], r[STORE_IDX] || 0);
    });
  }

  function setIndex(i, cb) {
    if (!HAS_STORE) {
      cb && cb();
      return;
    }
    chrome.storage.local.set({ [STORE_IDX]: i }, () => cb && cb());
  }

  /* ---------- 面板 ---------- */
  let panel, elIdx, elTitle, elTime, elAcc, elStatus;

  function buildPanel() {
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "wxch-helper-panel";
    panel.innerHTML = `
      <div class="wxch-head">
        <span class="wxch-title">视频号发布助手</span>
        <span class="wxch-idx" id="wxch-idx">0/0</span>
        <button class="wxch-min" id="wxch-min" title="收起">—</button>
      </div>
      <div class="wxch-body" id="wxch-body">
        <div class="wxch-row"><label>账号</label><div class="wxch-val" id="wxch-acc" title="双击可手动填写账号名">当前账号</div></div>
        <div class="wxch-row"><label>标题</label><div class="wxch-val wxch-strong" id="wxch-title">-</div></div>
        <div class="wxch-row"><label>计划</label><div class="wxch-val" id="wxch-time">-</div></div>
        <div class="wxch-btns">
          <button id="wxch-prev" class="wxch-b" title="回到上一条">上一条</button>
          <button id="wxch-done" class="wxch-b wxch-ok" title="切到下一条　Alt+N">下一条</button>
          <button id="wxch-oneclick" class="wxch-b wxch-primary" title="填入内容并设置计划时间（Alt+Q）">一键填写</button>
        </div>
        <div class="wxch-status" id="wxch-status">就绪</div>
      </div>`;
    // 挂到 documentElement，避免 body 被 SPA 替换时面板一起消失
    (document.body || document.documentElement).appendChild(panel);

    elIdx = panel.querySelector("#wxch-idx");
    elTitle = panel.querySelector("#wxch-title");
    elTime = panel.querySelector("#wxch-time");
    elAcc = panel.querySelector("#wxch-acc");
    elStatus = panel.querySelector("#wxch-status");

    // 账号名识别不准时：双击「账号」行手动填写（留空恢复自动识别）
    if (elAcc) {
      elAcc.addEventListener("dblclick", () => {
        const cur = detectAccountName();
        const guess = /未识别|未登录/.test(cur) ? "" : cur;
        const v = window.prompt("手动填写当前账号名（留空恢复自动识别）", guess);
        if (v === null) return;
        setAccManual(v.trim());
        render();
        status(v.trim() ? "账号名已手动设置" : "已恢复自动识别", true);
      });
    }

    panel.querySelector("#wxch-min").onclick = () => {
      panel.classList.toggle("wxch-collapsed");
    };
    panel.querySelector("#wxch-oneclick").onclick = () => oneClick();
    panel.querySelector("#wxch-prev").onclick = () => move(-1);
    panel.querySelector("#wxch-done").onclick = () => move(1);

    // 拖拽
    const head = panel.querySelector(".wxch-head");
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    head.addEventListener("mousedown", (e) => {
      if (e.target.id === "wxch-min") return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = ox + (e.clientX - sx) + "px";
      panel.style.top = oy + (e.clientY - sy) + "px";
      panel.style.right = "auto";
    });
    document.addEventListener("mouseup", () => { dragging = false; });
  }

  function status(msg, ok) {
    if (!elStatus) return;
    elStatus.textContent = msg;
    elStatus.className = "wxch-status " + (ok === true ? "ok" : ok === false ? "err" : "");
  }

  /** 诊断：报告当前能找到的输入框情况，便于排查 */
  function selfTest() {
    const eds = findEditables();
    const ce = queryAllDeep('[contenteditable="true"]').length;
    const io = queryAllDeep("input,textarea").length;
    const roots = collectRoots().length;
    const bad = checkPage();
    let msg;
    if (bad) {
      msg = `${bad.msg}（URL: ${location.pathname}）`;
      status(msg, false);
    } else if (eds.length === 0) {
      msg = `未发现输入框（穿透后 ce=${ce}, io=${io}, 影子根=${roots}）→ 请先选好视频`;
      status(msg, false);
    } else {
      const first = eds[0];
      msg = `找到 ${eds.length} 个输入框，首个：${first.tagName}${first.className ? "." + String(first.className).slice(0, 24) : ""}`;
      status(msg, true);
    }
    log("【测试定位】", msg);
    log("【测试定位】URL：", location.href);
    log("【测试定位】候选明细：", eds.map((e) => ({
      tag: e.tagName,
      cls: String(e.className || "").slice(0, 60),
      ph: e.getAttribute("placeholder") || e.getAttribute("data-placeholder") || "",
      editable: e.getAttribute("contenteditable") || "",
      rect: (() => { const r = e.getBoundingClientRect(); return Math.round(r.width) + "x" + Math.round(r.height); })(),
    })));
  }

  /** 跳到发表视频页 */
  function gotoPostPage() {
    status("正在跳转到发表视频页…");
    location.href = "https://channels.weixin.qq.com/platform/post/create";
  }

  function render() {
    getTasks((tasks, i) => {
      if (!panel) return;
      if (!tasks.length) {
        elIdx.textContent = "0/0";
        elTitle.textContent = "未导入任务";
        elTime.textContent = "-";
        elAcc.textContent = detectAccountName();
        status("请点浏览器右上角插件图标导入任务");
        return;
      }
      i = Math.max(0, Math.min(i, tasks.length - 1));
      const t = tasks[i];
      elIdx.textContent = `${i + 1}/${tasks.length}`;
      elAcc.textContent = detectAccountName();
      elTitle.textContent = t.title || "-";
      elTime.textContent = t.time || "-";

      // 页面不对时主动提示
      const bad = checkPage();
      if (bad) status(bad.msg, false);
      else if (elStatus && !elStatus.textContent) status("就绪");
    });
  }

  function move(delta, markDone) {
    getTasks((tasks, i) => {
      if (!tasks.length) return;
      let n = Math.max(0, Math.min(i + delta, tasks.length - 1));
      setIndex(n, () => {
        render();
        status(markDone ? "已标记完成，已切换下一条" : "已切换", true);
      });
    });
  }

  function copyText(s) {
    if (!s || s === "-") return;
    navigator.clipboard.writeText(s).then(
      () => status("已复制", true),
      () => status("复制失败，请手动选中", false)
    );
  }

  /** 找话题/描述用的编辑器（返回所有可编辑元素，供逐个尝试） */
  function findEditables() {
    const list = [];
    queryAllDeep('div[contenteditable="true"], [contenteditable="true"], textarea, input').forEach((el) => {
      if (usable(el) && isEditable(el)) list.push(el);
    });
    return list;
  }

  /** 深度结构挖掘：iframe / Shadow DOM / role=textbox / 中点探测 */
  function deepProbe() {
    const d = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        cls: String(el.className || "").slice(0, 120),
        ph: el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || "",
        ce: el.getAttribute("contenteditable") || "",
        type: el.getAttribute("type") || "",
        value: el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? String(el.value || "").slice(0, 30) : "",
        rect: Math.round(r.width) + "x" + Math.round(r.height),
        at: Math.round(r.left) + "," + Math.round(r.top),
        visible: r.width > 0 && r.height > 0,
      };
    };

    const roots = collectRoots();

    const res = {
      url: location.href,
      summary: {
        rootCount: roots.length,
        ce: queryAllDeep('[contenteditable="true"]').length,
        io: queryAllDeep("input,textarea").length,
        roleTextbox: queryAllDeep('[role="textbox"]').length,
        iframes: document.querySelectorAll("iframe").length,
      },
      roots: [],
      editables: [],
      roleTextbox: queryAllDeep('[role="textbox"]').slice(0, 10).map(d),
      midpoints: [],
    };

    // 每个影子根里各扫一遍
    roots.forEach((root, i) => {
      const label = root === document ? "document" : "shadow#" + i + "@" + (root.host ? root.host.tagName : "?");
      const ce = root.querySelectorAll ? root.querySelectorAll('[contenteditable="true"]').length : 0;
      const io = root.querySelectorAll ? root.querySelectorAll("input,textarea").length : 0;
      if (ce || io) res.roots.push({ root: label, ce, io });
    });

    // 所有可编辑元素（穿透 shadow）
    queryAllDeep('input, textarea, [contenteditable="true"], [contenteditable], [role="textbox"]').forEach((el) => {
      res.editables.push(d(el));
    });
    res.editables = res.editables.slice(0, 50);

    // 视口中点向下探测（elementFromPoint 会返回 shadow 内的真实元素）
    [[innerWidth / 2, innerHeight * 0.45], [innerWidth / 2, innerHeight * 0.3], [innerWidth / 2, innerHeight * 0.6]].forEach(([x, y]) => {
      let el = null;
      try { el = document.elementFromPoint(x, y); } catch (e) {}
      const chain = [];
      let cur = el;
      for (let i = 0; i < 8 && cur; i++) {
        chain.push(d(cur));
        // 穿过 shadow 边界
        if (cur.parentElement) cur = cur.parentElement;
        else if (cur.getRootNode && cur.getRootNode().host) cur = cur.getRootNode().host;
        else break;
      }
      res.midpoints.push({ at: Math.round(x) + "," + Math.round(y), chain });
    });

    return res;
  }

  /** 深挖并把结果复制到剪贴板，方便发给助手 */
  function dumpStructure() {
    const res = deepProbe();
    const txt = JSON.stringify(res, null, 2);
    log("【深度结构】", res);
    console.log(txt);
    const s = res.summary;
    const tip = `ce=${s.ce} io=${s.io} role=${s.roleTextbox} iframe=${s.iframes} shadow=${res.shadow.length}`;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(txt).then(
        () => status(`结构已复制到剪贴板（${tip}），粘贴发给我`, true),
        () => status(`结构见 Console（${tip}），请手动复制`, false)
      );
    } else {
      status(`结构见 Console（${tip}），请手动复制`, false);
    }
  }

  /** 是否处于视频号发布页 */
  function isPostPage() {
    return /channels\.weixin\.qq\.com\/platform\/post\/create/.test(location.href);
  }

  /* ---------- 上传状态与一键流程（v2.1 增强） ---------- */

  /** 取路径的文件名（兼容 \ 与 /） */
  function basename(p) {
    const s = String(p || "").replace(/\\/g, "/");
    return s.split("/").pop() || "";
  }

  /** 找页面可点的「发表/发布」按钮（优先最靠下的、非禁用） */
  function findPublishButton() {
    const cands = queryAllDeep("button,div[role='button'],span,a");
    const hit = cands.filter((el) => {
      const t = (el.textContent || "").trim();
      if (!/^(发表|发布)$/.test(t)) return false;
      // 排除左侧导航/草稿箱那一片，避免误点跳转
      if (insideNav(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 12) return false;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
      const cls = String(el.className || "");
      if (/disabled|weui-desktop-btn_disabled|is-disabled/i.test(cls)) return false;
      if (el.disabled) return false;
      let p = el.parentElement, dis = false;
      for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
        if (/disabled|_disabled|is-disabled/i.test(String(p.className || ""))) { dis = true; break; }
      }
      return !dis;
    });
    hit.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return hit[0] || null;
  }

  /** 是否已选中视频：任一 file input 已带文件 */
  function isVideoPicked() {
    return findFileInputs().some((el) =>
      el.files && el.files.length > 0 && String(el.value || "").trim() !== "");
  }

  /** 同步段：调起视频选择框（必须在用户手势栈内调用）。成功返回该 file input，失败返回 null */
  function openVideoPickerSync() {
    const all = findFileInputs();
    if (!all.length) {
      status("页面还没有上传入口，请确认在发表视频页", false);
      return null;
    }
    const eligible = all.filter((el) => !el.disabled && isConnected(el));
    const explicit = eligible.filter((el) => /video\/|\.(mp4|mov|m4v)\b/i.test(el.accept || ""));
    let target = explicit.length ? explicit[0] : eligible.find((el) => !isCoverInput(el));
    if (!target) target = eligible[0];
    if (!target) {
      status("未找到视频上传入口，请手动点击页面上传区域", false);
      return null;
    }
    return openFilePicker(target) ? target : null;
  }

  /**
   * 等待视频上传完成：轮询「发表」按钮从禁用变为可用（视频号上传期间发表按钮不可点）。
   * 超时 240 秒；期间上报进度文字。
   */
  async function waitUploadReady() {
    for (let i = 0; i < 240; i++) {
      // 上传出错提示
      const errEl = queryAllDeep('[class*="error"], .status-msg.error, [class*="Error"]').find((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 8) return false;
        const t = (el.textContent || "").trim();
        return t && /上传|文件|失败|错误/.test(t) && t.length < 80;
      });
      if (errEl) {
        status("上传出错：" + (errEl.textContent || "").trim().slice(0, 60), false);
        return false;
      }
      const btn = findPublishButton();
      if (btn) {
        status(`上传完成，已等待 ${i}s`, true);
        return true;
      }
      if (i % 10 === 0) status(`正在上传…（${i}s）`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    status("等待上传超时（240s），请查看页面上传状态后重试", false);
    return false;
  }

  /** 校验刚选的文件是否与当前任务的视频文件一致 */
  function checkPickedFileName(f, wantCover) {
    getTasks((tasks, i) => {
      if (!tasks.length) return;
      const t = tasks[Math.min(i, tasks.length - 1)];
      const rel = wantCover ? t.cover : t.video;
      const want = basename(rel);
      if (want && f && want.toLowerCase() !== f.name.toLowerCase()) {
        status(`⚠ 已选「${f.name}」，但任务${wantCover ? "封面" : "视频"}是「${want}」，请核对是否选错`, false);
        log("文件名校验未通过：选中", f.name, "任务要求", want);
      } else if (f) {
        status(`${wantCover ? "封面" : "视频"}已选定：${f.name}（${(f.size / 1048576).toFixed(1)}MB），等待上传完成…`, true);
      }
    });
  }

  /* ---------- 视频/封面路径复制 ---------- */
  const ROOT_KEY = "wxch_root"; // 素材根目录，用户在 popup 里设置

  /** 取素材根目录 */
  function getRoot(cb) {
    if (!HAS_STORE) return cb("");
    chrome.storage.local.get([ROOT_KEY], (r) => cb((r[ROOT_KEY] || "").replace(/[\\/]+$/, "")));
  }

  /** 把任务的 video 字段拼成完整 Windows 路径并复制
   *  JSON 里 video 若已是绝对路径（如 D:\素材\账号\73_xxx.mp4），则原样使用；
   *  否则拼上「素材根目录」。 */
  function copyVideoPath(which) {
    getTasks((tasks, i) => {
      if (!tasks.length) return status("没有任务", false);
      const t = tasks[Math.min(i, tasks.length - 1)];
      const rel = which === "cover" ? t.cover : t.video;
      if (!rel) return status(`该任务没有${which === "cover" ? "封面" : "视频"}路径`, false);
      const isAbs = /^[a-zA-Z]:[\\/]/.test(rel) || /^\\\\/.test(rel) || /^\//.test(rel);
      const done = (full) =>
        navigator.clipboard.writeText(full).then(
          () => status(`已复制${which === "cover" ? "封面" : "视频"}路径：${full.slice(-40)}`, true),
          () => status("复制失败：" + full, false)
        );
      if (isAbs) return done(rel);
      getRoot((root) => {
        const full = root ? root.replace(/[\\/]+$/, "") + "\\" + rel.replace(/^[\\/]+/, "") : rel;
        done(full);
      });
    });
  }

  /* ---------- 上传（视频 / 封面） ---------- */
  // 浏览器限制：插件无法读磁盘、无法用合成事件打开系统选择框。
  // 这里做的是「尽力而为」：找到页面真实的 file input，
  // 用原生 input.click()（或点击它的可见触发容器），打开系统选择框。

  /** 找页面上的 file input（穿透 Shadow DOM） */
  function findFileInputs() {
    return queryAllDeep('input[type="file"]');
  }

  /** 从 input 的 accept / 附近文本判断它是不是封面（图片）入口 */
  function isCoverInput(el) {
    const acc = (el.accept || "").toLowerCase();
    if (/image/.test(acc)) return true;
    if (/video/.test(acc)) return false;
    // 看祖先的提示文字
    let p = el.parentElement;
    for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
      const t = (p.textContent || "").slice(0, 80);
      if (/封面|首图|图片/.test(t)) return true;
      if (/上传视频|视频动态/.test(t)) return false;
    }
    return false;
  }

  /**
   * 打开系统文件选择框。
   * 视频号用 Ant Design 上传组件：input 是 display:none，
   * 真正的可点区域是 .ant-upload-btn / .ant-upload-drag（role=button, tabindex=0）。
   * 直接点隐藏 input 大概率被拦截，所以优先点可见触发容器。
   */
  function openFilePicker(input) {
    // 必须在真实用户点击的同步调用栈中调用；隐藏 file input 也可使用。
    // 不点击父容器：click() 没抛异常不能证明组件实际打开了选择框。
    if (!input || input.disabled || !isConnected(input)) return false;
    try {
      if (typeof input.showPicker === "function") input.showPicker();
      else input.click();
      return true;
    } catch (e) {
      log("文件选择框调用失败：", e && e.message);
      return false;
    }
  }

  /** 找目标 file input（抽成函数，便于打开封面弹层后重试） */
  function findUploadTarget(wantCover) {
    const all = findFileInputs();
    log("file input 总数：", all.length);
    all.forEach((i, n) => {
      const r = i.getBoundingClientRect();
      const trigger = i.closest && (i.closest(".ant-upload-btn") || i.closest(".ant-upload"));
      log(`  #${n} accept=${i.accept || "-"} display=${getComputedStyle(i).display} ` +
        `rect=${Math.round(r.width)}x${Math.round(r.height)} trigger=${trigger ? trigger.className : "无"}`);
    });
    if (!all.length) return { list: all, picked: null, n: 0 };

    // 按明确文件类型选择唯一入口，绝不将封面交给视频输入框
    const eligible = all.filter((el) => !el.disabled && isConnected(el));
    const explicit = eligible.filter((el) => wantCover
      ? /image\/|\.(png|jpe?g|webp)\b/i.test(el.accept || "")
      : /video\/|\.(mp4|mov|m4v)\b/i.test(el.accept || ""));
    const candidates = explicit.length ? explicit : eligible.filter((el) =>
      !el.accept && isCoverInput(el) === wantCover);
    return { list: all, picked: candidates[0] || null, n: candidates.length };
  }

  /**
   * 尝试点开页面上的「封面设置」入口。
   * ★ 视频号的封面上传 input 通常藏在「更换封面 / 设置封面」弹层里，
   *   不先点开就根本找不到 → 这就是「选择封面失败」的原因。
   */
  async function openCoverDialog() {
    const pats = [/^更换封面$/, /^设置封面$/, /^上传封面$/, /^选择封面$/,
      /^自定义封面$/, /^本地上传$/, /^上传图片$/, /^添加封面$/,
      /上传图片|本地上传|从本地/, /封面/];
    for (const re of pats) {
      const hit = queryAllDeep("button, a, span, div, li, p").filter((el) => {
        const t = (el.textContent || "").trim();
        if (!t || t.length > 14) return false;
        if (!re.test(t)) return false;
        if (el.children && el.children.length > 2) return false;
        if (!shown(el)) return false;
        if (insideNav(el)) return false;
        try { if (panel && panel.contains(el)) return false; } catch (e) {}
        return true;
      })[0];
      if (hit) {
        log("点开封面入口：", (hit.textContent || "").trim(), hit.tagName + "." + String(hit.className || "").slice(0, 40));
        realClick(hit);
        await new Promise((r) => setTimeout(r, 900));
        return true;
      }
    }
    log("页面上没有可点的封面入口");
    return false;
  }

  /** 上传入口：找 input → 打开选择框 → 提示用户选文件 */
  async function startUpload(which) {
    log("=== startUpload 开始，which=" + which + "，frame=" + location.href);
    const wantCover = which === "cover";

    let found = findUploadTarget(wantCover);

    // 封面常藏在弹层里：先点开「更换封面 / 设置封面」再找一次（弹层有动画，多试几轮）
    if (wantCover && !found.picked) {
      status("未找到封面入口，尝试打开页面上的封面设置…");
      for (let k = 0; k < 3 && !found.picked; k++) {
        const opened = await openCoverDialog();
        if (!opened) break;
        await new Promise((r) => setTimeout(r, 800));
        found = findUploadTarget(wantCover);
        log("第 " + (k + 1) + " 轮找封面 input：", found.picked ? "找到了" : "仍没有");
      }
    }

    if (!found.list.length) {
      status("页面还没有上传入口。请确认在发表视频页，且视频上传区域已显示。", false);
      return;
    }
    if (!found.picked) {
      status(found.n > 1
        ? "检测到多个上传入口，请直接点击页面中需要的上传区域"
        : wantCover
          ? "仍未找到封面上传入口：请先上传视频，再手动点页面上的「更换封面/设置封面」，弹层打开后重试"
          : "未找到视频上传入口，请进入发表视频页后重试", false);
      return;
    }
    const target = found.picked;

    // 挂 change 监听，选完文件后提示 + 校验文件名（先挂再点）
    if (!target.__wxchHooked) {
      target.__wxchHooked = true;
      target.addEventListener("change", () => {
        const f = target.files && target.files[0];
        if (f) {
          checkPickedFileName(f, wantCover);
          log("已选定文件：", f.name, f.size);
          // ★ 封面常见坑：文件传上去了，但弹层要再点一次「确定/完成」才算设上去
          if (wantCover) {
            status("封面已选定，等上传完成后自动点「确定」…");
            setTimeout(() => confirmDialog("封面设置", 45000), 1200);
          }
        } else {
          log("change 触发但无文件");
        }
      });
    }

    const opened = openFilePicker(target);
    status(
      opened
        ? `已尝试调起${wantCover ? "封面" : "视频"}选择框，请在弹窗中选中文件` +
          (wantCover ? "" : "（对照面板「视频」行的文件名）")
        : `无法自动打开选择框，请手动点击页面上「上传${wantCover ? "封面" : "视频"}」的区域`,
      false
    );
  }

  /** 是否处于登录页 */
  function isLoginPage() {
    return /login/i.test(location.href) ||
      !!document.querySelector('[class*="login"], [class*="qrcode"]');
  }

  /** 页面环境体检，返回一句话结论 */
  function checkPage() {
    if (isLoginPage()) return { level: "err", msg: "当前在登录页，请先扫码登录" };
    if (!isPostPage()) return { level: "err", msg: "当前不是「发表视频」页，点下方按钮跳转" };
    return null;
  }

  /* ---------- 核心：填入 ---------- */
  /** 取任务（Promise 版，配合一键流程串联） */
  function getTasksAsync() {
    return new Promise((resolve) => getTasks((tasks, i) => resolve({ tasks, i })));
  }

  /** 真正把某条任务写进表单；返回 {titleOk, descOk, n} */
  async function fillTask(t) {
    const shortInput = findShortTitle();
    const descEditor = findDescEditor();

    // 1) 简短标题 → 独立的 input（页面没有该框则跳过，不改描述）
    let titleOk = false;
    if (shortInput) {
      clearEditor(shortInput);
      titleOk = fillInputValue(shortInput, t.title || "");
      log("已填短标题:", t.title, "→ input", titleOk);
    } else {
      log("未找到「短标题」独立输入框，跳过（描述区会写入标题+话题）");
    }

    // 2) 描述区 = 标题一份 + 话题（用户要求：标题加在话题前面）
    const tags = t.tags || [];
    let n = 0;
    const descOk = !!descEditor;
    if (descEditor) {
      clearEditor(descEditor);
      insertText(descEditor, t.title || "");
      insertText(descEditor, "\n"); // 标题单独一行，再走话题
      tags.forEach((tag) => {
        insertText(descEditor, "#" + tag);
        insertText(descEditor, " ");
        pressKey(descEditor, " ");
        n++;
      });
      log("已填描述区：标题 + 话题", n, "个");
    }
    return { titleOk, descOk, n };
  }

  async function doFill() {
    const bad = checkPage();
    if (bad) {
      status(bad.msg, false);
      log("页面检查未通过：", location.href);
      return false;
    }
    let editor = findEditor();
    if (!editor) {
      // 视频可能还在上传/转码，稍等再试几次
      status("正在等待发布表单出现…");
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 800));
        editor = findEditor();
        if (editor) break;
      }
    }
    if (!editor) {
      // 把现场信息打出来，方便定位（穿透 Shadow DOM 统计）
      const eds = findEditables();
      log("编辑元素候选：", eds.length,
        eds.map((e) => e.tagName + "." + String(e.className || "").slice(0, 40)));
      log("穿透统计 ce=", queryAllDeep('[contenteditable="true"]').length,
        " io=", queryAllDeep("input,textarea").length,
        " 影子根数=", collectRoots().length);
      log("当前 URL：", location.href);
      status("未找到内容输入框：点「深挖结构」把结果发我", false);
      return false;
    }

    const { tasks, i } = await getTasksAsync();
    if (!tasks.length) {
      status("没有任务，请先导入", false);
      return false;
    }
    const t = tasks[Math.min(i, tasks.length - 1)];
    status("正在填入...");
    try {
      const r = await fillTask(t);
      const parts = [];
      if (r.titleOk) parts.push("短标题");
      if (r.descOk) parts.push("描述(标题+" + r.n + "话题)");
      status(
        parts.length
          ? `已填入 ${parts.join(" + ")}，请核对后切定时/发表`
          : "没找到标题框或描述框，请点「深挖结构」发我",
        parts.length > 0
      );
      return parts.length > 0;
    } catch (e) {
      log("填入异常", e);
      status("填入失败：" + e.message, false);
      return false;
    }
  }

  /* ---------- 快捷键 ---------- */
  document.addEventListener("keydown", (e) => {
    if (!e.altKey) return;
    const k = (e.key || "").toLowerCase();
    if (k === "q") {
      e.preventDefault(); oneClick();
    } else if (k === "f") {
      e.preventDefault(); doFill();
    } else if (k === "n") {
      e.preventDefault(); move(1);
    } else if (k === "t") {
      e.preventDefault(); setSchedule();
    } else if (k === "p") {
      e.preventDefault(); clickPublish();
    }
  });

  /* ---------- Console 调试入口（面板上不放按钮，需要时手动调） ----------
   * 用法：F12 → Console → 输入 __wxch.help()
   */
  window.__wxch = {
    version: "2.9.0",
    help: () => log(
      "可用命令：\n" +
      "  __wxch.acc()            看账号名识别结果 + 候选元素（识别不准时先跑这个）\n" +
      "  __wxch.accSet('名字')    手动指定账号名（传空字符串恢复自动识别）\n" +
      "  __wxch.stats()          立刻抓一次当前页统计并刷新面板\n" +
      "  __wxch.collectAll()     依次读取四个数据页（关注者/视频/评论/私信）\n" +
      "  __wxch.snap()           导出当前页结构快照（表格/角标/标签数值），抓数不准时用\n" +
      "  __wxch.post()           视频数据页解析诊断（标签/表格/行/列），近7天视频读不出来时用\n" +
      "  __wxch.postTab()        只看「单篇视频」标签状态，并手动点一次切换\n" +
      "  __wxch.msg()            私信页解析诊断（会话行/日期/近3天统计），私信数不对时用\n" +
      "  __wxch.comment()        评论页解析诊断（作品行/日期/评论数/近3天统计），评论数不对时用\n" +
      "  __wxch.feishu()         同步到飞书多维表格，并打印上次同步明细（写入/跳过原因）\n" +
      "  __wxch.probe()          探测定时控件结构并复制\n" +
      "  __wxch.dump()           深挖页面结构并复制\n" +
      "  __wxch.panel()          打印当前识别到的时间面板（先把定时面板点开）\n" +
      "  __wxch.tp()             时间区状态（时/分列表是否展开、选中值、回显框），定时设不上时先跑这个\n" +
      "  __wxch.hm('09:30')      手动设一次时分（先把定时面板点开）\n" +
      "  __wxch.panelHTML()      复制时间面板的 HTML（先把定时面板点开）\n" +
      "  __wxch.modals()         列出当前所有弹层\n" +
      "  __wxch.closeOverlays()  关掉挡路的弹层\n" +
      "  __wxch.confirm()        手动点一次「确定」\n" +
      "  __wxch.sched()          重新执行一次定时设置\n" +
      "  __wxch.fill()           重新填一次内容"
    ),
    acc: () => {
      const cands = queryAllDeep('[class*="nick"],[class*="account"],[class*="user-name"],[class*="userName"],h1,h2,h3')
        .filter((el) => shown(el) && !(panel && panel.contains(el)))
        .slice(0, 40)
        .map((el) => ({
          cls: String(el.className || "").slice(0, 50),
          text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 30),
        }));
      const info = {
        手动: accManual || "(无)",
        本次命中: accHit || "(无)",
        缓存: accStored || "(无)",
        最终显示: detectAccountName(),
      };
      log("账号名识别：", info);
      log("候选元素：", cands);
      return { info, cands };
    },
    accSet: (name) => {
      setAccManual(name);
      render();
      log("账号名已设为：", name || "(恢复自动识别)");
      return detectAccountName();
    },
    stats: () => {
      const ok = tryCollectStats();
      renderStats();
      log(ok ? "已抓取并刷新" : "当前页面没有可读的统计结构");
      return ok;
    },
    collectAll: () => {
      runCollectAll(false);
      log("已发起四页读取（关注者 / 视频 / 评论 / 私信）");
      return true;
    },
    snap: () => {
      const L = leafTexts(document);
      const cellTxt = (c) => (c.innerText || c.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24);
      const tables = queryAllDeepFrom(document, "table").map((tb) => {
        const row = tb.querySelector("tbody tr");
        return {
          head: [...tb.querySelectorAll("thead th, thead td")].map(cellTxt),
          rows: tb.querySelectorAll("tbody tr").length,
          firstRow: row ? [...row.querySelectorAll("td")].map(cellTxt) : [],
        };
      });
      const badges = queryAllDeepFrom(document, '[class*="badge"], [class*="unread"], [class*="red-dot"]')
        .filter((el) => !(panel && panel.contains(el)))
        .slice(0, 25)
        .map((el) => ({
          cls: String(el.className || "").slice(0, 40),
          text: (el.innerText || "").trim().slice(0, 10),
          shown: shown(el),
        }));
      const labels = L
        .filter((x) => /关注|私信|消息|评论|未读|粉丝|净增/.test(x.text) && x.text.length <= 24)
        .slice(0, 50)
        .map((x) => x.text + "  =>  " + (numFromParent(x.el) || "-"));
      const out = { url: location.href, path: location.pathname, tables, badges, labels };
      const json = JSON.stringify(out, null, 2);
      console.log(json);
      try { if (navigator.clipboard) navigator.clipboard.writeText(json); } catch (e) { /* ignore */ }
      log("页面结构快照已打印（并尝试复制到剪贴板）");
      return out;
    },
    /* 视频数据页解析诊断：报「读不出来」时先跑这个，把结果发我看差在哪 */
    post: () => {
      const bodyTxt = (document.body && document.body.innerText) || "";
      // 先确保停在「单篇视频」标签（诊断时顺手点一下），再解析
      let tabNow = "";
      try { tabNow = ensureSinglePostTab(); } catch (e) { tabNow = "err:" + (e && e.message); }
      const node = singleTabNode();
      const tabs = {
        切标签结果: tabNow,   // current / clicked / waiting / missing / giving-up
        找到单篇视频: !!node,
        标签文字: node ? tabTextOf(node.el) : "",
        标签已选中: node ? tabIsCurrent(node) : false,
        点过次数: postTabClickCount,
        标签栏: tabBarTexts(),
      };
      const tables = queryAllDeepFrom(document, "table").map((tb) => {
        const rows = [...tb.querySelectorAll("tbody tr")];
        return {
          head: [...tb.querySelectorAll("thead th, thead td")].map(cellText),
          rows: rows.length,
          first: rows[0] ? [...rows[0].querySelectorAll("td")].map(cellText).slice(0, 12) : [],
        };
      });
      let tablegot = null, gridgot = null;
      try { tablegot = postTableVideos(document); } catch (e) { tablegot = { err: String(e && e.message) }; }
      try { gridgot = postGridVideos(document); } catch (e) { gridgot = { err: String(e && e.message) }; }
      const out = {
        url: location.href,
        kind: pageKind(),
        标签: tabs,
        页面有加载中: /加载中|正在加载/.test(bodyTxt),
        页面有暂无数据: /暂无数据|暂无视频|暂无作品|没有更多数据|还没有发布/.test(bodyTxt),
        包含视频数据的表格: tables,
        表格解析: tablegot ? { cols: tablegot.cols, head: tablegot.head, n: tablegot.videos.length, first: tablegot.videos[0] } : null,
        几何解析: gridgot ? { cols: gridgot.cols, n: gridgot.videos.length, first: gridgot.videos[0] } : null,
      };
      const json = JSON.stringify(out, null, 2);
      console.log(json);
      try { if (navigator.clipboard) navigator.clipboard.writeText(json); } catch (e) { /* ignore */ }
      log("视频数据页解析结果已打印（并尝试复制到剪贴板）");
      return out;
    },
    /* 只看「单篇视频」标签状态：读到的视频不对时，先确认插件点的是不是这个标签 */
    postTab: () => {
      let before = "";
      try { before = ensureSinglePostTab(); } catch (e) { before = "err:" + (e && e.message); }
      const node = singleTabNode();
      const out = {
        url: location.href,
        kind: pageKind(),
        切标签结果: before,
        找到单篇视频: !!node,
        标签文字: node ? tabTextOf(node.el) : "",
        标签已选中: node ? tabIsCurrent(node) : false,
        标签栏: tabBarTexts(),
        点过次数: postTabClickCount,
        最近点击: postTabClickedAt ? new Date(postTabClickedAt).toLocaleTimeString() : "",
        提示: before === "clicked" || before === "waiting"
          ? "刚点了标签，等 1~2 秒表格渲染完，再点面板的「读取最新数据」"
          : "标签状态正常，可直接点「读取最新数据」",
      };
      const json = JSON.stringify(out, null, 2);
      console.log(json);
      try { if (navigator.clipboard) navigator.clipboard.writeText(json); } catch (e) { /* ignore */ }
      log("视频数据页标签状态已打印（并尝试复制到剪贴板）");
      return out;
    },
    /* 私信页解析诊断：近 3 天私信数不对时先跑这个 */
    msg: () => {
      const now = new Date();
      const rows = msgSessionRows(document);
      const txt = (el) => (el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "");
      let parsed = null;
      try { parsed = collectMsg(document); } catch (e) { parsed = { err: String(e && e.message) }; }
      const out = {
        url: location.href,
        kind: pageKind(),
        今天: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`,
        会话行: rows.length,
        页面原文共几个: (() => {
          const el = queryAllDeepFrom(document, ".msg-nums")[0];
          return el ? txt(el) : "";
        })(),
        解析结果: parsed,
        明细: rows.slice(0, 40).map((r) => {
          const d = txt(r.querySelector(".date"));
          const dt = parseLooseDate(d, now);
          return {
            name: txt(r.querySelector(".name")) || txt(r.querySelector(".title")),
            date: d,
            解析成: dt ? `${dt.getFullYear()}-${dt.getMonth() + 1}-${dt.getDate()}` : "认不出",
            内容: txt(r.querySelector(".feed-info")).slice(0, 30),
          };
        }),
      };
      const json = JSON.stringify(out, null, 2);
      console.log(json);
      try { if (navigator.clipboard) navigator.clipboard.writeText(json); } catch (e) { /* ignore */ }
      log("私信页解析结果已打印（并尝试复制到剪贴板）");
      return out;
    },
    /* 评论页解析诊断：近 3 天评论数不对时先跑这个 */
    comment: () => {
      const now = new Date();
      let rows = queryAllDeepFrom(document, ".comment-feed-wrap");
      if (!rows.length) rows = queryAllDeepFrom(document, ".feeds-container .feed-content");
      const txt = (el) => (el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "");
      let parsed = null;
      try { parsed = collectComment(document); } catch (e) { parsed = { err: String(e && e.message) }; }
      const out = {
        url: location.href,
        kind: pageKind(),
        今天: `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`,
        作品行: rows.length,
        页面原文共几个: txt(queryAllDeepFrom(document, ".feeds-nums")[0]),
        解析结果: parsed,
        明细: rows.slice(0, 40).map((r) => {
          const d = txt(r.querySelector(".feed-time"));
          const dt = parseLooseDate(d, now);
          return {
            title: txt(r.querySelector(".feed-title")).slice(0, 24),
            date: d,
            解析成: dt ? `${dt.getFullYear()}-${dt.getMonth() + 1}-${dt.getDate()}` : "认不出",
            评论数原文: txt(r.querySelector(".feed-comment-total")),
            未读: txt(r.querySelector(".unread-comment-number")),
          };
        }),
      };
      const json = JSON.stringify(out, null, 2);
      console.log(json);
      try { if (navigator.clipboard) navigator.clipboard.writeText(json); } catch (e) { /* ignore */ }
      log("评论页解析结果已打印（并尝试复制到剪贴板）");
      return out;
    },
    /* 飞书同步：跑一次同步，并打印逐条明细（找不到行/列缺失都在这看） */
    feishu: () => {
      if (lastFeishuResult) console.log("[视频号助手] 上次同步明细：", lastFeishuResult);
      runFeishuSync();
      return "已开始同步，明细稍后见下方日志；上次结果也一并打印了";
    },
    probe: () => probeSchedule(),
    dump: () => dumpStructure(),
    panel: () => {
      const p = findPickerPanel();
      log("时间面板：", p ? String(p.className || "").slice(0, 80) : "未找到");
      if (p) log("面板年月：", panelYearMonth(p));
      return p;
    },
    /* 时间区状态：一键填写失败时先跑这个，看时分列表到底在不在 */
    tp: () => {
      const root = pickerRoot();
      const h = findTimeList("hour");
      const m = findTimeList("minute");
      const out = {
        url: location.href,
        pickerRoot: root ? root.tagName + "." + String(root.className || "").slice(0, 90) : "未找到",
        datePanel: (() => { const p = findPickerPanel(); return p ? p.tagName + "." + String(p.className || "").slice(0, 60) : "未找到"; })(),
        hourList: h ? `可见/${h.querySelectorAll("li").length}项` : "无（时间区没展开）",
        minuteList: m ? `可见/${m.querySelectorAll("li").length}项` : "无（时间区没展开）",
        selected: { h: selectedVal("hour"), mi: selectedVal("minute") },
        panelTime: readPanelTime(),
        pageTime: readTimeValue(),
        confirmBtn: (() => { const b = findPickerConfirm(root); return b ? (b.textContent || "").trim() : "无"; })(),
        recode: (() => {
          try { return [...root.querySelectorAll(".weui-desktop-picker__recode li")].map((x) => (x.textContent || "").trim()); }
          catch (e) { return []; }
        })(),
      };
      console.log("[视频号助手] 时间区状态：", out);
      const txt = JSON.stringify(out, null, 2);
      try { if (navigator.clipboard) navigator.clipboard.writeText(txt); } catch (e) { /* 忽略 */ }
      log("时间区状态已打印（并尝试复制）");
      return out;
    },
    /* 手动设时分（先把定时面板点开）：__wxch.hm("09:30") */
    hm: async (s) => {
      const m = String(s || "").match(/(\d{1,2})\D+(\d{1,2})/);
      if (!m) { log("用法：__wxch.hm('09:30')"); return null; }
      const r = await setHourMinute({ h: +m[1], mi: +m[2] });
      log("手动设时分结果：", r, "| 面板时间框", readPanelTime());
      return r;
    },
    panelHTML: () => {
      const p = pickerRoot() || findPickerPanel();
      if (!p) { log("未找到面板，先把定时面板点开再执行"); return null; }
      const html = p.outerHTML.slice(0, 12000);
      console.log(html);
      if (navigator.clipboard) navigator.clipboard.writeText(html);
      log("面板 HTML 已打印（并尝试复制）");
      return html;
    },
    modals: () => {
      const m = findModal();
      log("弹层：", m ? String(m.className || "").slice(0, 80) : "无");
      log("全部浮层：", queryAllDeep("[class*='modal'],[class*='dialog'],[class*='popover'],[class*='popup'],[class*='drawer']")
        .filter(shown).map((el) => String(el.className || "").slice(0, 50)));
      return m;
    },
    closeOverlays: () => dismissOverlays(3),
    confirm: () => confirmDialog("手动确认", 8000),
    sched: () => setSchedule(),
    fill: () => doFill(),
  };

  /* ================================================================
   * 统计模块 v2.3.0
   * 每次登录视频号助手后，自动从各数据页抓取并汇总到浮动面板：
   *   关注者总数 / 净增关注 / 新增关注 / 昨日视频关注
   *   最近视频（10-15 起）浏览数 / 新评论（标红）/ 私信数量（标红）
   * 抓取方式：在当前 frame 的 document（穿透 Shadow DOM）里按文本标签
   * 定位数据；每个 frame 都会尝试，命中结构才写入 storage。
   * ================================================================ */
  const STATS_KEY = "wxch_stats_v2";
  const STATS_TTL = 1000 * 60 * 30; // 同一数据 30 分钟内不重复抓（避免高频轮询重复写）

  /** 元素或祖先是否被 inline style 隐藏（页面上大量 tooltip / 下拉菜单是 display:none）
   *  ★ 这些隐藏节点里有重复的指标名和数字（帮助气泡里就有「净增关注」），
   *    不排除会把取值带偏，所以扫描一律跳过。
   */
  function hiddenInline(el) {
    let p = el;
    for (let i = 0; i < 10 && p && p.nodeType === 1; i++, p = p.parentElement) {
      if (p.hidden) return true;
      const st = p.style;
      if (st && (st.display === "none" || st.visibility === "hidden")) return true;
    }
    return false;
  }

  /** 收集某根下的叶子文本元素（穿透 shadow，跳过隐藏节点） */
  function leafTexts(root) {
    const out = [];
    (function walk(el, depth) {
      if (depth > 14) return;
      let all = [];
      try { all = el.querySelectorAll ? el.querySelectorAll("*") : []; } catch (e) { return; }
      for (const c of all) {
        if (c.children.length === 0 && c.innerText && c.innerText.trim()) {
          if (!hiddenInline(c)) out.push({ el: c, text: c.innerText.trim() });
        }
        if (c.shadowRoot) walk(c.shadowRoot, depth + 1);
      }
    })(root === document ? document.documentElement : root, 0);
    return out;
  }

  /** 查找文本完全等于 target 的叶子元素（可限定 className 片段） */
  function leafByText(root, target, clsPart) {
    return leafTexts(root).find((x) =>
      x.text === target && (!clsPart || String(x.el.className || "").indexOf(clsPart) >= 0)
    );
  }

  /** 取元素内部第一个「纯数字」文本：按子元素切分，避免 7/20/55 粘成 72055 */
  function firstNumIn(el) {
    const kids = el && el.children ? [...el.children] : [];
    for (const k of kids) {
      const t = (k.innerText || k.textContent || "").replace(/\s+/g, "").trim();
      const n = parseNumToken(t);
      if (n !== null) return n;
      const inner = firstNumIn(k);
      if (inner) return inner;
    }
    return null;
  }

  /** 取元素父容器里的第一个数字（支持 1,234 / 1.9万 / +7）
   *  ★ 先按子元素切分，再退回文本 token；否则表格行 "7 20 55" 会被并成 "72055"
   */
  function numFromParent(el) {
    if (!el) return null;
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++) {
      const byKid = firstNumIn(p);
      if (byKid) return byKid;
      const t = (p.innerText || p.textContent || "").replace(/\s+/g, " ").trim();
      if (t) {
        for (const tk of t.split(" ")) {
          const n = parseNumToken(tk);
          if (n !== null) return n;
        }
        // 「净增关注7」这种中间没有空格的
        // ★ 同样必须允许纯数字（19801），旧写法 \d{1,3} 会把它截成 198
        const m = t.match(/(?:^|[^\d.,-])([+\-]?\d+(?:,\d{3})*(?:\.\d+)?万?)/);
        if (m) return m[1].replace(/^\+/, "").replace(/,/g, "");
      }
      p = p.parentElement;
    }
    return null;
  }

  /** 把一段文本解析成统计数字（支持 1,234 / 1.9万 / +7 / −3 / 全角减号）
   *  ★ 与 numFromParent 的区别：这里只认「整段就是一个数字」，不会把别的文字里的数字抠出来
   */
  function parseNumToken(raw) {
    let t = String(raw == null ? "" : raw).replace(/\s+/g, "").trim();
    if (!t) return null;
    t = t.replace(/[−－—]/g, "-").replace(/＋/g, "+");
    // ★ 关键：必须允许「不带千分位的纯数字」（19801）和「千分位」（19,801）。
    //   旧写法是 \d{1,3}(?:,\d{3})*，只认最多 3 位整数，19801 直接被判为「不是数字」，
    //   于是掉进 numFromParent 的兜底正则，被截成前三位 198。
    //   这里用 \d+(?:,\d{3})*：19801 / 19,801 / 1.9万 / 0 都能过，
    //   而 7,20,55 这类错误千分位仍然不合法（,20 后面不足三位）。
    // 纯数字再限个长度：粉丝/播放量不会超过 12 位，避免把超长 ID 当成统计数字
    if (/^\d{13,}$/.test(t)) return null;
    if (/^\+?\d+(?:,\d{3})*(?:\.\d+)?万?$/.test(t)) return t.replace(/^\+/, "").replace(/,/g, "");
    if (/^-\d+(?:,\d{3})*(?:\.\d+)?万?$/.test(t)) return t.replace(/,/g, "");
    return null;
  }

  /** 容器内的叶子文本序列（按文档顺序），用于「标签 → 数值」的就近配对（跳过隐藏节点） */
  function leafSeq(root) {
    const out = [];
    if (!root || !root.querySelectorAll) return out;
    for (const el of root.querySelectorAll("*")) {
      if (el.children && el.children.length) continue;
      const t = (el.innerText || el.textContent || "").replace(/\s+/g, "").trim();
      if (t && !hiddenInline(el)) out.push({ el, text: t });
    }
    return out;
  }

  /** 在标签所在的「最小卡片 / 表格行」里，取标签之后的第一个数字
   *  周期指标表按「昨日 / 近7日 / 近30日」排列，标签后第一个数就是昨日值
   */
  function numNearLabel(labelEl) {
    if (!labelEl) return null;
    let p = labelEl.parentElement;
    for (let i = 0; i < 4 && p && p !== document.body; i++, p = p.parentElement) {
      const seq = leafSeq(p);
      if (!seq.length) continue;
      if (seq.length > 24) break; // 已经爬到整块面板了，再往上就串到邻居的数据
      const at = seq.findIndex((x) => x.el === labelEl);
      if (at < 0) continue; // 标签不是这一层的叶子，继续往上
      // ★ 只有「除标签外全是数字」的容器才算最小单元；
      //   否则会越过下一个项目，把别人的数当成自己的（例如「关注者总数」取到「净增关注 +7」）
      const others = seq.filter((x) => x.el !== labelEl);
      if (others.some((x) => parseNumToken(x.text) === null)) continue;
      for (let j = at + 1; j < seq.length; j++) {
        const n = parseNumToken(seq[j].text);
        if (n !== null) return n;
      }
    }
    return null;
  }

  /* ---------------- 精确取数（v2.5.0） ----------------
   * 旧做法：标签 → 爬父容器 → 取第一个数字。父容器一大就串到隔壁卡片，
   * 所以「关注者总数 / 净增关注 / 新增关注」经常取到别的指标（尤其近7日列）。
   * 现在改成四级，逐级降级，任何一级拿到就停：
   *   ① 表格：周期指标是 <table> 时，按表头「昨日」列精确定位（最准）
   *   ② 同行：用元素位置判断是否在同一行，取离标签最近的数（周期指标行）
   *   ③ 同列/邻行：数字在标签上方或下方的卡片布局
   *   ④ 文档顺序：拿不到布局信息时才用（仅兜底）
   * ------------------------------------------------ */
  function rectOf(el) {
    try {
      const r = el.getBoundingClientRect();
      if (!r || (r.width < 1 && r.height < 1)) return null;
      return r;
    } catch (e) { return null; }
  }
  function cyOf(r) { return r.top + r.height / 2; }
  function cxOf(r) { return r.left + r.width / 2; }
  function cellText(c) {
    return (c.innerText || c.textContent || "").replace(/\s+/g, " ").trim();
  }

  /** 容器内所有「整段就是数字」的叶子（可排除标签自身），带位置 */
  function numLeavesIn(container, skipEl) {
    const out = [];
    for (const x of leafSeq(container)) {
      if (skipEl && x.el === skipEl) continue;
      const n = parseNumToken(x.text);
      if (n === null) continue;
      out.push({ el: x.el, text: x.text, n: n, r: rectOf(x.el) });
    }
    return out;
  }

  /** 页面上「昨日 / 今天」表头的横坐标，用来确认周期指标哪一列是昨日 */
  function yestAnchorX(labelEl) {
    const lr = rectOf(labelEl);
    let best = null;
    for (const x of leafTexts(document)) {
      const t = x.text.replace(/\s+/g, "");
      if (!/^(昨日|昨天|今日|今天)$/.test(t)) continue;
      const r = rectOf(x.el);
      if (!r) continue;
      const dy = lr ? Math.abs(cyOf(r) - cyOf(lr)) : 0;
      if (lr && dy > 1400) continue; // 太远的同名表头不要
      if (!best || dy < best.dy) best = { x: cxOf(r), dy: dy };
    }
    return best ? best.x : null;
  }

  /** 周期指标是表格时：按表头「昨日」列取值（纵表：首列是指标名） */
  function followerTable(root) {
    const out = {};
    const want = [
      ["fansTotal", /^(关注者总数|总关注者|粉丝总数|关注人数|粉丝数|总粉丝数)$/],
      ["netAdd", /^(净增关注|净增粉丝|净增关注数)$/],
      ["newAdd", /^(新增关注|新增粉丝|新增关注数)$/],
      ["cancelAdd", /^(取消关注|取消关注数|取关数|取关人数)$/],
    ];
    const tables = queryAllDeepFrom(root, "table");
    for (const tb of tables) {
      const rows = [...tb.querySelectorAll("tr")];
      if (rows.length < 2) continue;
      let yCol = -1;
      for (const tr of rows) {
        const cells = [...tr.querySelectorAll("th, td")].map(cellText);
        const k = cells.findIndex((c) => /^(昨日|昨天)$/.test(c.replace(/\s+/g, "")));
        if (k >= 0) { yCol = k; break; }
      }
      if (yCol < 1) continue; // 没有「昨日」列就不按表头猜，交给几何判断
      for (const tr of rows) {
        const cells = [...tr.querySelectorAll("th, td")].map(cellText);
        if (cells.length <= yCol) continue;
        const name = (cells[0] || "").replace(/\s+/g, "");
        const hit = want.find((w) => w[1].test(name));
        if (!hit) continue;
        const v = parseNumToken(cells[yCol]);
        if (v === null) continue;
        out[hit[0]] = v;
        out[hit[0] + "Raw"] = cells[yCol];
      }
      if (Object.keys(out).length) return out;
    }
    return out;
  }

  /** 周期指标卡片（线上真实结构，最优先）：
   *    div.keypoint-item > div.name(净增关注) + div.value(32) + div.percent(+1500%)
   *  ★ 必须用 .name / .value 直接配对，不能靠「标签后第一个数字」：
   *    卡片顶部的帮助气泡里还有一份「净增关注 / 新增关注 / 取消关注」，
   *    文档顺序排在真实数据前面，会把取值带偏（之前数不准就是这个原因）。
   *    百分号（+1500%）也不是数字，不会被当值。
   */
  const KP_NAME = [
    ["fansTotal", /^(关注者总数|总关注者|粉丝总数|总粉丝数|关注人数|粉丝数|关注者|总粉丝)$/],
    ["netAdd", /^(净增关注|净增粉丝|净增关注数)$/],
    ["newAdd", /^(新增关注|新增粉丝|新增关注数)$/],
    ["cancelAdd", /^(取消关注|取消关注数|取关数|取关人数)$/],
  ];
  function keypointMetrics(root) {
    const out = {};
    const items = queryAllDeepFrom(root, '[class*="keypoint-item"]').filter((el) =>
      String(el.className || "").split(/\s+/).indexOf("keypoint-item") >= 0
    );
    for (const it of items) {
      if (hiddenInline(it)) continue;
      // 优先直接子元素，取不到再在 item 内找（避免误抓气泡里的节点）
      const pick = (cls) => {
        for (const c of it.children) {
          if (String(c.className || "").split(/\s+/).indexOf(cls) >= 0) return c;
        }
        return it.querySelector('[class~="' + cls + '"]');
      };
      const nameEl = pick("name");
      const valEl = pick("value");
      if (!nameEl || !valEl) continue;
      const name = (nameEl.innerText || nameEl.textContent || "").replace(/\s+/g, "");
      const raw = (valEl.innerText || valEl.textContent || "").replace(/\s+/g, " ").trim();
      const v = parseNumToken(raw);
      if (v === null) continue;
      const hit = KP_NAME.find((w) => w[1].test(name));
      if (!hit || out[hit[0]] !== undefined) continue;
      out[hit[0]] = v;
      out[hit[0] + "Raw"] = raw;
    }
    return out;
  }

  /** 取某个指标标签对应的数值（表格没给时用）；返回 {n, raw, how} */
  function metricOne(labelRe, L) {
    const hit = findLeaf(L, labelRe, 20);
    if (!hit) return null;
    const labelEl = hit.el;
    const lr = rectOf(labelEl);
    const MAXN = 3; // 一个指标最多和 3 个数绑在一起（昨日/近7日/近30日）
    let p = labelEl.parentElement;
    for (let d = 0; d < 6 && p && p !== document.body; d++, p = p.parentElement) {
      const nums = numLeavesIn(p, labelEl);
      if (!nums.length) continue;
      if (nums.length > MAXN) continue;
      if (!lr) return { n: nums[0].n, raw: nums[0].text, how: "order" }; // 无布局信息
      // ① 与标签同一行
      const row = nums
        .filter((x) => x.r && Math.abs(cyOf(x.r) - cyOf(lr)) <= Math.max(lr.height, x.r.height) * 0.7)
        .sort((a, b) => a.r.left - b.r.left);
      if (row.length) return { n: row[0].n, raw: row[0].text, how: "row" };
      // ② 这些数自己在同一行（数字在标签上方/下方的卡片）
      const b0 = nums[0];
      if (b0.r) {
        const line = nums
          .filter((x) => x.r && Math.abs(cyOf(x.r) - cyOf(b0.r)) <= Math.max(b0.r.height, 22) * 0.9)
          .sort((a, b) => a.r.left - b.r.left);
        if (line.length === nums.length) {
          if (line.length === 1) return { n: line[0].n, raw: line[0].text, how: "line" };
          const ax = yestAnchorX(labelEl);
          let pick = null, how = "";
          if (ax !== null) {
            pick = line.slice().sort((a, b) => Math.abs(cxOf(a.r) - ax) - Math.abs(cxOf(b.r) - ax))[0];
            how = "line-anchor";
          } else {
            // 等间距 → 周期三列（昨日/近7日/近30日），取最左；否则是一排卡片，取横向离标签最近的
            const xs = line.map((x) => cxOf(x.r));
            const gaps = xs.slice(1).map((v, i) => v - xs[i]);
            const even = gaps.length > 0 && gaps.every((g) => g > 0 && Math.abs(g - gaps[0]) < gaps[0] * 0.35);
            if (even) { pick = line[0]; how = "line-cols"; }
            else {
              pick = line.slice().sort((a, b) =>
                Math.abs(cxOf(a.r) - cxOf(lr)) - Math.abs(cxOf(b.r) - cxOf(lr)))[0];
              how = "line-near";
            }
          }
          if (pick) return { n: pick.n, raw: pick.text, how: how };
        }
      }
      // ③ 同列最近（正上方 / 正下方）
      const col = nums
        .filter((x) => x.r && Math.abs(cxOf(x.r) - cxOf(lr)) < Math.max(lr.width, 40) * 1.3)
        .sort((a, b) => Math.abs(cyOf(a.r) - cyOf(lr)) - Math.abs(cyOf(b.r) - cyOf(lr)));
      if (col.length) return { n: col[0].n, raw: col[0].text, how: "col" };
    }
    const near = numNearLabel(labelEl);
    if (near !== null) return { n: near, raw: "", how: "legacy" };
    const f = numFromParent(labelEl);
    if (f !== null) return { n: f, raw: "", how: "parent" };
    return null;
  }

  /** 数值转成可比较的数字（支持 1.9万） */
  function numOf(v) {
    if (v === null || v === undefined) return null;
    const m = String(v).replace(/,/g, "").trim().match(/^(-?\d+(?:\.\d+)?)(万)?$/);
    if (!m) return null;
    return Number(m[1]) * (m[2] ? 10000 : 1);
  }

  /** 在已扫描好的叶子列表里按正则找文本（避免重复全量扫描 DOM） */
  function findLeaf(leaves, re, maxLen) {
    const lim = maxLen || 24;
    for (const x of leaves) {
      if (x.text.length > lim) continue;
      if (!re.test(x.text)) continue;
      return x;
    }
    return null;
  }

  /** 叶子兄弟序列：收集某元素同容器内全部叶子文本，用于找"标签后数值" */
  function siblingsTexts(el) {
    const p = el.parentElement;
    if (!p) return [];
    return leafTexts(p).map((x) => x.text);
  }

  /* ---------------- 账号名识别（v2.3.1：多策略 + 缓存兜底） ----------------
   * 视频号助手改版频繁，class 名一变「只认 .finder-nickname」就失效。
   * 现在依次尝试：已知 class → 广谱 class（含 nick/account/user）→ 头像旁的文本
   * → localStorage / cookie 里的 nickname 字段 → document.title。
   * 全部失败还有两层兜底：① storage 里上次识别到的名字 ② 双击面板「账号」行手动填。
   */
  const ACC_KEY = "wxch_acc_name";          // 上次识别到的账号名（跨页面/刷新兜底）
  const ACC_MANUAL_KEY = "wxch_acc_manual"; // 手动指定（最高优先级）
  let accManual = "";
  let accHit = "";                          // 本页结构命中的名字
  let accHitAt = 0;
  let accStored = "";

  function loadAccStore(cb) {
    if (!HAS_STORE) { cb && cb(); return; }
    chrome.storage.local.get([ACC_KEY, ACC_MANUAL_KEY], (o) => {
      accStored = (o && o[ACC_KEY]) || "";
      accManual = (o && o[ACC_MANUAL_KEY]) || "";
      cb && cb();
    });
  }

  function saveAccName(name) {
    if (!HAS_STORE || !name || name === accStored) return;
    accStored = name;
    chrome.storage.local.set({ [ACC_KEY]: name });
  }

  function setAccManual(name) {
    accManual = String(name || "").trim();
    if (!HAS_STORE) return;
    if (accManual) chrome.storage.local.set({ [ACC_MANUAL_KEY]: accManual });
    else chrome.storage.local.remove(ACC_MANUAL_KEY);
    if (accManual) saveAccName(accManual);
  }

  /** 明显不是账号名的词（菜单/按钮/状态） */
  const ACC_BAD = /^(账号|账号名|昵称|视频号|视频号助手|助手|首页|数据|数据中心|数据助手|内容管理|互动管理|成长任务|收益|设置|管理|退出|退出登录|切换账号|切换视频号|切换|登录|立即登录|扫码登录|发布|发表|创作|草稿箱|全部|暂无|加载中|空白|通知中心|消息中心|帮助与反馈|意见反馈|账号设置|客服)$/;

  function accLike(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return false;
    if (t.length < 2 || t.length > 30) return false;
    if (t.indexOf("视频号发布助手") >= 0) return false;
    if (ACC_BAD.test(t)) return false;
    if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(t)) return false;
    return true;
  }

  /** 候选打分：越像「账号名」分越高 */
  function accScore(el, text, selIsNick) {
    let sc = 0;
    const cls = String(el.className || "");
    if (/nick/i.test(cls)) sc += 6;
    if (/account|user|finder/i.test(cls)) sc += 2;
    if (selIsNick) sc += 4;
    try {
      const r = el.getBoundingClientRect();
      if (r.left < 380) sc += 2;          // 左侧栏
      if (r.top < 220) sc += 2;           // 顶栏
      if (r.width > 0 && r.width < 320) sc += 1;
    } catch (e) { /* ignore */ }
    // 祖先里带 account-info / side-bar-footer：这正是侧边栏底部账号区
    let p = el.parentElement;
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      const pc = String(p.className || "");
      if (/account-info|account_info/i.test(pc)) sc += 5;
      if (/side-bar-footer/i.test(pc)) sc += 3;
    }
    if (/^[\u4e00-\u9fa5A-Za-z0-9_\-·]+$/.test(text)) sc += 1;
    return sc;
  }

  /** 在给定的一组根（含 shadow）里查询，避免每个选择器都重扫一遍 DOM */
  function queryInRoots(roots, selector) {
    const out = [];
    for (const r of roots) {
      try { r.querySelectorAll(selector).forEach((el) => out.push(el)); } catch (e) { /* ignore */ }
    }
    return out;
  }

  /** 策略 0：侧边栏底部的账号区（当前线上结构：.side-bar-footer .account-info .name） */
  function scanAccByAccountBox() {
    const SEL = [
      ".side-bar-footer .account-info .name",
      '.side-bar-footer [class*="account-info"] [class*="name"]',
      ".account-info .name",
      '[class*="account-info"] .name',
      '[class*="side-bar-footer"] .name',
      '[class*="account-info"] [class*="nick"]',
      '[class*="side-bar"] .name',
    ];
    const roots = collectRoots();
    for (const sel of SEL) {
      for (const el of queryInRoots(roots, sel)) {
        if (panel && panel.contains(el)) continue;
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (!accLike(text)) continue;
        // 「切换视频号」弹层里也有 .name，别把别的号当成当前号
        if (el.closest && el.closest('[class*="dialog"], [class*="modal"], [class*="popover"]')) continue;
        if (!shown(el)) continue;
        return text;
      }
    }
    return "";
  }

  /** 策略 1：按 class 找（含广谱匹配） */
  function scanAccByClass() {
    const SEL = [
      ".side-bar-footer .account-info .name",
      ".account-info .name",
      '[class*="account-info"] .name',
      ".finder-nickname", '[class*="finder-nickname"]',
      '[class*="finder-nick_name"]', '[class*="finder-name"]',
      ".account-name", ".account_nickname", ".accountNickname",
      '[class*="account-name"]', '[class*="accountName"]',
      ".weui-desktop-account__nickname",
      '[class*="nickname"]', '[class*="nickName"]', '[class*="nick_name"]',
      '[class*="user-name"]', '[class*="userName"]', ".user-name",
      '[class*="nick"]',
    ];
    let best = "", bestScore = 0;
    const roots = collectRoots();
    for (const sel of SEL) {
      const list = queryInRoots(roots, sel);
      const isNick = /nick|finder-name|account-info/i.test(sel);
      for (const el of list) {
        if (panel && panel.contains(el)) continue;
        if (el.closest && el.closest('[class*="dialog"], [class*="modal"], [class*="popover"]')) continue;
        if (!shown(el)) continue;
        const raw = el.innerText || el.textContent || "";
        if (raw.length > 200) continue; // 大容器不算
        const text = raw.replace(/\s+/g, " ").trim();
        if (!accLike(text)) continue;
        const sc = accScore(el, text, isNick);
        if (sc > bestScore) { bestScore = sc; best = text; }
      }
    }
    return bestScore >= 4 ? best : "";
  }

  /** 策略 2：把侧边栏/顶栏的头像当作锚点，取旁边的文本 */
  function scanAccByAvatar() {
    let best = "", bestScore = 0;
    const imgs = queryAllDeep("img");
    for (const img of imgs) {
      const src = String(img.currentSrc || img.src || "");
      const cls = String(img.className || "");
      if (!/avatar|head|portrait|logo|finder/i.test(src + " " + cls)) continue;
      if (!shown(img)) continue;
      let r;
      try { r = img.getBoundingClientRect(); } catch (e) { continue; }
      // 只要求「在左侧栏」，不再限制 top —— 账号区在侧边栏**底部**，以前被 top 过滤掉了
      if (r.left > 420 || r.width < 12 || r.width > 160) continue;
      let p = img.parentElement;
      for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
        const txt = (p.innerText || "").replace(/\s+/g, " ").trim();
        if (!txt) continue;
        const cand = txt.split(" ")[0];
        if (accLike(cand)) {
          const sc = 10 - i;
          if (sc > bestScore) { bestScore = sc; best = cand; }
        }
        break;
      }
    }
    return best;
  }

  /** 策略 3：localStorage / cookie 里的 nickname 字段（改版后最稳的兜底） */
  function scanAccFromStore() {
    const re = /"?(?:nick_?name|nickName|finderNickname|nicknameStr)"?\s*[:=]\s*"([^"]{2,40})"/i;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        let v = "";
        try { v = localStorage.getItem(k) || ""; } catch (e) { continue; }
        if (!v || v.length > 200000) continue;
        const m = v.match(re);
        if (m && accLike(m[1])) return m[1];
      }
    } catch (e) { /* ignore */ }
    try {
      const m = document.cookie.match(/(?:nick_?name|nickName)=([^;]{2,60})/i);
      if (m) {
        let v = m[1];
        try { v = decodeURIComponent(v); } catch (e) { /* ignore */ }
        if (accLike(v)) return v;
      }
    } catch (e) { /* ignore */ }
    return "";
  }

  /** 策略 4：页面标题（形如「张三的视频号助手」） */
  function scanAccFromTitle() {
    const t = (document.title || "").replace(/\s+/g, " ").trim();
    const m = t.match(/^(.{2,30}?)\s*(?:的)?(?:视频号助手|视频号后台|视频号)/);
    if (m && accLike(m[1])) return m[1];
    return "";
  }

  /** 极轻量的账号区读取（只查一次选择器，不做全页扫描）：换号后能立刻发现名字变了 */
  function quickAccName() {
    try {
      const el = document.querySelector(".side-bar-footer .account-info .name") ||
        document.querySelector(".account-info .name");
      if (!el) return "";
      const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      return accLike(t) ? t : "";
    } catch (e) { return ""; }
  }

  /** 页面顶部账号名（对外统一入口）
   *  ★ v2.5.3：侧边栏账号区是「当前登录是谁」的唯一事实来源。
   *    换号后它立刻变，所以它一出现就优先用它，并且作废之前手动指定的名字，
   *    否则新账号的数据会被写到旧账号名下（表现为「新号读不出视频」）。
   *  ★ fresh=true 时跳过 60 秒缓存，强制重扫（写统计前必须这样）。
   */
  function detectAccountName(fresh) {
    if (/login/i.test(location.href)) return accHit || accStored || "未登录";
    const now = Date.now();

    // 快查：账号区名字和缓存不一致 → 换号了，立刻切换
    const q = quickAccName();
    if (q && q !== accHit) {
      if (accManual && accManual !== q) {
        accManual = "";
        if (HAS_STORE) chrome.storage.local.remove(ACC_MANUAL_KEY);
        log("检测到换号，已作废之前手动指定的账号名 →", q);
      }
      accHit = q;
      accHitAt = now;
      saveAccName(q);
      return q;
    }
    if (!fresh && accHit && now - accHitAt < 60000) return accHit;

    const boxName = scanAccByAccountBox();
    if (boxName) {
      if (accManual && accManual !== boxName) {
        accManual = "";
        if (HAS_STORE) chrome.storage.local.remove(ACC_MANUAL_KEY);
        log("检测到换号，已作废之前手动指定的账号名 →", boxName);
      }
      accHit = boxName;
      accHitAt = now;
      saveAccName(boxName);
      return boxName;
    }
    if (accManual) return accManual;

    const name = scanAccByClass() || scanAccByAvatar() || scanAccFromStore() || scanAccFromTitle();
    if (name) {
      accHit = name;
      accHitAt = now;
      saveAccName(name);
      return name;
    }
    return accStored || "未识别到账号（双击可手动填写）";
  }

  /** 统计存储用的账号键：识别不到时归到「未知账号」 */
  function accountKey(fresh) {
    const n = detectAccountName(fresh);
    if (!n || /未识别|未登录/.test(n)) return "未知账号";
    return n;
  }

  /** 关注者数据页：/platform/statistic/follower
   *  取：关注者总数 / 净增关注 / 新增关注（周期指标取「昨日」列，即行内第一个数）
   */
  function collectFollower(root, leaves) {
    const d = {};
    const L = leaves || leafTexts(root);

    // ⓿ 周期指标卡片（线上真实结构，最准）：.keypoint-item > .name + .value
    const kp = keypointMetrics(root);
    Object.keys(kp).forEach((k) => {
      d[k] = kp[k];
      if (!/Raw$/.test(k)) d.how = Object.assign({}, d.how, { [k]: "keypoint" });
    });

    // ① 表格：周期指标是 <table> 时，按表头「昨日」列定位
    const tb = followerTable(root);
    Object.keys(tb).forEach((k) => {
      if (d[k] !== undefined) return; // 卡片结构已经给了更可靠的
      d[k] = tb[k];
      if (!/Raw$/.test(k)) d.how = Object.assign({}, d.how, { [k]: "table" });
    });

    const put = (key, res) => {
      if (!res || res.n === null || res.n === undefined) return;
      if (d[key] !== null && d[key] !== undefined) return; // 表格已给更可靠的
      d[key] = res.n;
      if (res.raw) d[key + "Raw"] = res.raw;
      d.how = Object.assign({}, d.how, { [key]: res.how });
    };

    put("fansTotal", metricOne(/^关注者总数$|^总关注者$|^粉丝总数$|^关注人数$|^粉丝数$/, L));
    put("netAdd", metricOne(/^净增关注$|^净增粉丝$/, L));
    put("newAdd", metricOne(/^新增关注$|^新增粉丝$/, L));
    put("cancelAdd", metricOne(/^取消关注$|^取关数$|^取消关注数$/, L));

    // ② 周期指标的另一层保险：若同一行里还有别的数（昨日/近7日/近30日），
    //    用「昨日」表头的横坐标去认列，避免把近7日的数当成昨日
    const ROW_RE = {
      netAdd: /^净增关注$|^净增粉丝$/,
      newAdd: /^新增关注$|^新增粉丝$/,
      cancelAdd: /^取消关注$|^取关数$|^取消关注数$/,
    };
    Object.keys(ROW_RE).forEach((k) => {
      const re = ROW_RE[k];
      const howNow = (d.how || {})[k];
      // 卡片 / 表格已经拿到确切值，别再被几何推算覆盖
      if (howNow === "keypoint" || howNow === "table") return;
      const hit = findLeaf(L, re, 20);
      if (!hit) return;
      const lr = rectOf(hit.el);
      if (!lr) return;
      let p = hit.el.parentElement;
      for (let dpt = 0; dpt < 5 && p && p !== document.body; dpt++, p = p.parentElement) {
        const nums = numLeavesIn(p, hit.el).filter((x) => x.r &&
          Math.abs(cyOf(x.r) - cyOf(lr)) <= Math.max(lr.height, x.r.height) * 0.7);
        if (nums.length < 2) continue;
        const ax = yestAnchorX(hit.el);
        let pick = nums.sort((a, b) => a.r.left - b.r.left)[0];
        if (ax !== null) {
          pick = nums.slice().sort((a, b) => Math.abs(cxOf(a.r) - ax) - Math.abs(cxOf(b.r) - ax))[0];
        }
        if (pick && pick.n !== null) {
          d[k] = pick.n;
          d[k + "Raw"] = pick.text;
          d.how = Object.assign({}, d.how, { [k]: (ax !== null ? "row-anchor" : "row-left") });
        }
        break;
      }
    });

    // ③ 合理性校验：明显串到别的指标上的值直接丢掉（保留上一次正确值）
    const F = numOf(d.fansTotal);
    ["netAdd", "newAdd", "cancelAdd"].forEach((k) => {
      if (d[k] === null || d[k] === undefined) return;
      const v = numOf(d[k]);
      const drop = () => { delete d[k]; delete d[k + "Raw"]; };
      if (v === null) { drop(); return; }
      if (F !== null && Math.abs(v) > F) { drop(); return; }              // 不可能超过关注者总数
      if (F !== null && v === F) { drop(); return; }                      // 同一个数被抓了两次
      if (d.netAdd !== undefined && d.newAdd !== undefined &&
          String(d.netAdd) === String(d.newAdd) && numOf(d.netAdd) > 0 &&
          (F === null || numOf(d.netAdd) > F * 0.9)) {                       // 两个指标完全相同且量级离谱
        delete d.netAdd; delete d.netAddRaw;
      }
    });

    return Object.keys(d).length ? d : null;
  }

  /* ---------------- 视频数据页解析（v2.5.3 重写） ----------------
   * 换号后读不出近 7 天视频，根因有三类，这里都兜住了：
   *   ① 新号作品少，表格列数变少（原来 rows 里 `tds.length < 4` 直接跳过整行）；
   *   ② 表头不在 thead / 换了列名，原逻辑强依赖「表头含发布时间」，认不出就整表放弃；
   *   ③ 表格不是 <table>（虚拟列表 / div 栅格），原逻辑完全读不到。
   * 现在：表头优先 → 用首行内容反推列 → 全表无 <table> 时按「同一行」几何关系还原表格。
   * 另外「页面读到了但确实没视频」会记 postRead/postEmpty，面板据此显示「0 条」而不是「未读取」。
   * ---------------------------------------------------------- */
  const DATE_CELL_RE = /^(?:\d{4}\s*[-\/年.]\s*\d{1,2}\s*[-\/月.]\s*\d{1,2}|\d{1,2}\s*[-\/月.]\s*\d{1,2}|今天|昨天|前天)(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/;

  /** 单元格「整段就是一个日期」，标题里带日期不算 */
  function isDateCell(t) {
    const s = String(t == null ? "" : t).replace(/\s+/g, " ").trim();
    if (!s || s.length > 20) return false;
    return DATE_CELL_RE.test(s);
  }

  /** 时长形态的值（00:15 / 15秒）：绝不能当成播放量 */
  function isDurText(t) {
    const s = String(t == null ? "" : t).replace(/\s+/g, "");
    return /^\d{1,2}:\d{2}(?::\d{2})?$/.test(s) || /^\d+(\.\d+)?(秒|s|min|分|分钟)$/i.test(s);
  }

  let postTryCnt = 0; // 表格连续解析失败几次后才启用几何兜底（避免每次重试都全页扫描）

  /** <table> 解析：列位置按表头文字定位，表头缺失时用首行内容反推 */
  function postTableVideos(root) {
    const tables = queryAllDeepFrom(root, "table");
    let best = null;
    for (const tb of tables) {
      let head = [...tb.querySelectorAll("thead th, thead td")].map(cellText);
      let rows = [...tb.querySelectorAll("tbody tr")];
      if (!head.length) { // 没有 thead 的表格：拿第一行当表头
        const hrow = tb.querySelector("tr");
        head = hrow ? [...hrow.querySelectorAll("th, td")].map(cellText) : [];
        if (!rows.length) rows = [...tb.querySelectorAll("tr")].slice(1);
      }
      if (!rows.length) continue;
      const rowCells = (tr) => [...tr.querySelectorAll("td")];
      const tds0 = rowCells(rows[0]);
      if (tds0.length < 2) continue;                       // ★ 原来是 < 4，新号列少就被整表丢掉
      if (!head.length || head.every((c) => !c)) head = tds0.map(() => "");

      // —— 日期列：先表头，再首行内容 ——
      let iDate = head.findIndex((c) => /发布时间|发表时间|发布日期|日期/.test(c));
      if (iDate < 0) iDate = tds0.findIndex((td) => isDateCell(cellText(td)));
      if (iDate < 0) continue;                             // 没有日期列，这不是作品列表

      // —— 其余列 ——
      let iTitle = head.findIndex((c) => /^(标题|作品|内容|视频|作品名称|标题\/作品)$/.test(c));
      if (iTitle < 0) {
        iTitle = head.findIndex((c) => /标题|内容|作品|名称/.test(c) &&
          !/时长|播放|关注|评论|点赞|分享|发布/.test(c));
      }
      if (iTitle < 0) iTitle = Math.max(0, iDate - 1);

      let iPlay = head.findIndex((c) => /^(播放|播放量|播放数|播放次数|播放人数|观看量|观看数)$/.test(c));
      if (iPlay < 0) {
        iPlay = head.findIndex((c) => /播放|观看/.test(c) && !/时长|均|率|占比|趋势|完播/.test(c));
      }
      let iFollow = head.findIndex((c) =>
        /^(关注|关注量|关注数|新增关注|关注人数|涨粉|涨粉数|转粉数|加粉数)$/.test(c));
      if (iFollow < 0) {
        iFollow = head.findIndex((c) => /关注|涨粉|转粉|加粉/.test(c) && !/率|占比|趋势|取关|总关注/.test(c));
      }
      const iLike = head.findIndex((c) => /点赞/.test(c));
      const iCmt = head.findIndex((c) => /评论/.test(c));

      // 首行校验：播放列不能是时长、不能是空（表头认错时换列 / 用「日期右边第一个数字列」）
      const val0 = (k) => (k >= 0 && tds0[k] ? cellText(tds0[k]) : "");
      if (iPlay < 0 || iPlay >= tds0.length || isDurText(val0(iPlay)) || parseNumToken(val0(iPlay)) === null) {
        let alt = head.findIndex((c, k) => k > iDate && /播放|观看/.test(c) && !/时长|均|率|占比|完播/.test(c));
        if (alt < 0) {
          for (let k = iDate + 1; k < tds0.length; k++) {
            const t = cellText(tds0[k]);
            if (!isDurText(t) && parseNumToken(t) !== null) { alt = k; break; }
          }
        }
        iPlay = alt;
      }

      const videos = [];
      rows.forEach((tr) => {
        const cells = rowCells(tr);
        if (cells.length < 2) return;
        const txt = cells.map(cellText);
        // 日期：按列取，取不到就在整行里找（列漂移 / 合并单元格都能救回来）
        let di = iDate;
        if (!isDateCell(txt[di])) di = txt.findIndex(isDateCell);
        if (di < 0) return;
        // 播放：按列取，取到时长或空值时，就取日期右侧第一个纯数字
        let pi = iPlay;
        if (pi < 0 || pi >= txt.length || isDurText(txt[pi]) || parseNumToken(txt[pi]) === null) {
          pi = -1;
          for (let k = di + 1; k < txt.length; k++) {
            if (!isDurText(txt[k]) && parseNumToken(txt[k]) !== null) { pi = k; break; }
          }
        }
        videos.push({
          title: (txt[iTitle] || "(无标题)").slice(0, 40),
          date: txt[di],
          play: pi >= 0 ? txt[pi] : "",
          follow: iFollow >= 0 ? (txt[iFollow] || "") : "",
          like: iLike >= 0 ? (txt[iLike] || "") : "",
          comment: iCmt >= 0 ? (txt[iCmt] || "") : "",
        });
      });
      if (videos.length && (!best || videos.length > best.videos.length)) {
        best = {
          videos,
          cols: { play: head[iPlay] || "", follow: head[iFollow] || "" },
          head: head.join("|").slice(0, 80),
        };
      }
    }
    return best;
  }

  /** 不是 <table> 的布局兜底：把叶子文本按「同一行」聚成行，再用表头的横坐标认列 */
  function postGridVideos(root) {
    const items = [];
    for (const x of leafTexts(root)) {
      if (panel && panel.contains(x.el)) continue;
      const r = rectOf(x.el);
      if (!r || r.width < 6 || r.height < 6) continue;
      if (r.left < 120 || r.top < 40) continue;      // 左侧菜单 / 顶部导航不算
      const t = String(x.text || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 60) continue;
      items.push({ t, r });
    }
    if (items.length < 12) return null;
    items.sort((a, b) => cyOf(a.r) - cyOf(b.r) || a.r.left - b.r.left);
    const rows = [];
    for (const it of items) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(cyOf(it.r) - last.cy) <= 13) last.items.push(it);
      else rows.push({ cy: cyOf(it.r), items: [it] });
    }
    // 找表头行
    let hi = -1;
    for (let i = 0; i < rows.length; i++) {
      const ts = rows[i].items.map((x) => x.t);
      if (ts.length >= 2 && ts.some((t) => /^(播放量?|播放数|观看量|关注|涨粉|发布时间|标题|作品)$/.test(t))) {
        hi = i; break;
      }
    }
    if (hi < 0) return null;
    const headRow = rows[hi].items.slice().sort((a, b) => a.r.left - b.r.left);
    const anchor = (re, bad) => {
      const c = headRow.find((x) => re.test(x.t) && !(bad && bad.test(x.t)));
      return c ? cxOf(c.r) : null;
    };
    const xPlay = anchor(/^(播放量?|播放数|观看量)$/, /时长|均|率/);
    const xFollow = anchor(/^(关注|涨粉|转粉)$/, /率/);
    if (xPlay === null) return null;

    const videos = [];
    for (let i = hi + 1; i < rows.length; i++) {
      const cells = rows[i].items;
      const dCell = cells.find((x) => isDateCell(x.t));
      if (!dCell) continue;
      const nearestNum = (ax) => {
        if (ax === null) return "";
        let best = "", bd = 1e9;
        cells.forEach((c) => {
          if (c === dCell || parseNumToken(c.t) === null) return;
          const dd = Math.abs(cxOf(c.r) - ax);
          if (dd < bd) { bd = dd; best = c.t; }
        });
        return bd < 140 ? String(best).replace(/,/g, "") : "";
      };
      const titleCell = cells
        .filter((c) => c !== dCell && parseNumToken(c.t) === null && !isDurText(c.t) && c.t.length > 1)
        .sort((a, b) => b.t.length - a.t.length)[0];
      videos.push({
        title: (titleCell ? titleCell.t : "(无标题)").slice(0, 40),
        date: dCell.t,
        play: nearestNum(xPlay),
        follow: nearestNum(xFollow),
        like: "",
        comment: "",
      });
    }
    return videos.length
      ? { videos, cols: { play: "按列位置识别", follow: xFollow !== null ? "按列位置识别" : "" }, head: "(非表格布局)" }
      : null;
  }

  /* ---------- 视频数据页的「单篇视频」标签（v2.6.1） ----------
   * /platform/statistic/post 打开后默认停在「全部视频」（汇总），
   * 必须再点「单篇视频」，才会渲染逐条视频的表格。
   * 以前没点：读到的是汇总页 / 空表 → 播放量、关注量都是错的。
   */
  const SINGLE_TAB_RE = /^(单篇视频|单条视频|单个视频|单视频|视频明细|逐条视频|单篇作品)$/;
  // 页面上确实有标签栏，但暂时没找到「单篇视频」（多半还在渲染）→ 先等一等再放弃
  const TAB_BAR_HINT = /^(全部视频|全部作品|图文|视频|全部动态)$/;
  let postTabClickedAt = 0;
  let postTabClickCount = 0;
  let postTabUrl = "";
  let postTabFirstTryAt = 0;
  let lastPostTabState = "";

  function tabTextOf(el) {
    return String((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, "");
  }

  /** 找「单篇视频」这个标签：优先标签栏里、可见的；再退回全页
   *  先找 <a>，再找 li，最后 span —— 只取最内层（一个标签只算一个节点）
   */
  function singleTabNode() {
    const pools = ["a", "li", "span", "div"];
    for (const sel of pools) {
      const all = queryAllDeepFrom(document, sel).filter((el) => {
        if (panel && panel.contains(el)) return false;
        return SINGLE_TAB_RE.test(tabTextOf(el));
      });
      if (!all.length) continue;
      const inBar = all.filter((el) => {
        let p = el;
        for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
          if (/weui-desktop-tab|tab__nav|role=.?tab/i.test(String(p.className || "") + " " + String(p.getAttribute && p.getAttribute("role") || ""))) return true;
        }
        return false;
      });
      const pickFrom = inBar.length ? inBar : all;
      let best = pickFrom.find(shown) || pickFrom[0];
      // 取「文字相同」的最内层子元素（点它才落在真正的可点区域上）
      for (let i = 0; i < 4; i++) {
        const t = tabTextOf(best);
        const inner = Array.from(best.children || []).find((c) => tabTextOf(c) === t);
        if (!inner) break;
        best = inner;
      }
      const a = best.tagName === "A" ? best : (best.querySelector ? best.querySelector("a") : null);
      const li = (best.closest ? best.closest("li") : null) || best;
      return { el: best, a: a || best, li };
    }
    return null;
  }

  /** 标签是否已处于选中态 */
  function tabIsCurrent(node) {
    const mark = /(^|[\s_-])(nav[_-]current|active|selected|checked|current)([\s_-]|$)/i;
    for (const el of [node.el, node.a, node.li]) {
      if (!el) continue;
      const cls = String(el.className || "");
      if (mark.test(cls)) return true;
      if (el.getAttribute) {
        if (el.getAttribute("aria-selected") === "true") return true;
        if (el.getAttribute("aria-current")) return true;
      }
    }
    return false;
  }

  /** 页面上的标签栏长什么样（诊断用） */
  function tabBarTexts() {
    const out = [];
    for (const el of queryAllDeepFrom(document, "a, li")) {
      if (panel && panel.contains(el)) continue;
      const t = tabTextOf(el);
      if (!t || t.length > 10) continue;
      let p = el, inBar = false;
      for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
        if (/weui-desktop-tab|tab__nav/i.test(String(p.className || ""))) { inBar = true; break; }
      }
      if (inBar && out.indexOf(t) < 0) out.push(t);
    }
    return out;
  }

  /** 确保停在「单篇视频」标签
   *  返回：current（已选中，可解析）| clicked（刚点，等渲染）| waiting（等渲染）
   *        missing（没有这个标签，按老逻辑解析）| giving-up（点两次还不认，直接解析）
   */
  function ensureSinglePostTab() {
    if (postTabUrl !== location.href) {
      postTabUrl = location.href;
      postTabClickCount = 0;
      postTabClickedAt = 0;
      postTabFirstTryAt = 0;
    }
    if (!postTabFirstTryAt) postTabFirstTryAt = Date.now();
    const node = singleTabNode();
    if (!node) {
      // 有「全部视频」这类标签、却没有「单篇视频」→ 多半还在渲染，先等（最多 5 秒）
      const bar = tabBarTexts();
      const hasBar = bar.some((t) => TAB_BAR_HINT.test(t));
      if (hasBar && Date.now() - postTabFirstTryAt < 5000) return "waiting";
      return "missing";
    }
    if (tabIsCurrent(node)) { postTabClickCount = 0; return "current"; }
    // 页面可能没有「选中态」class：点 3 次还认不出来就不再硬点，直接按当前内容解析
    if (postTabClickCount >= 3) return "giving-up";
    const now = Date.now();
    if (now - postTabClickedAt < 2000) return "waiting";
    postTabClickedAt = now;
    postTabClickCount++;
    try { realClick(node.a); } catch (e) { /* ignore */ }
    if (node.li && node.li !== node.a) {
      try { realClick(node.li); } catch (e) { /* ignore */ } // 有的组件把监听挂在 li 上
    }
    try { log("视频数据页：已点击「" + tabTextOf(node.el) + "」标签，等表格渲染"); } catch (e) { /* ignore */ }
    return "clicked";
  }

  /** 视频数据页：/platform/statistic/post
   *  取「单篇视频」列表（页面默认近 7 天）：标题 + 播放量 + 关注量
   */
  function collectPost(root, leaves) {
    const d = {};
    // ★ 先切到「单篇视频」：不切的话读到的是「全部视频」汇总，数值不准
    const tabState = ensureSinglePostTab();
    lastPostTabState = tabState;
    if (tabState === "clicked" || tabState === "waiting") {
      postTryCnt = 0;
      return null; // 交给外层重试，等逐条视频渲染出来
    }
    const L = leaves || leafTexts(root);
    // 关键指标-昨日数据里的「关注」（别把表格表头「关注」当成指标，否则会抓错数字）
    const fol = findLeaf(L, /^关注$/);
    if (fol && !(fol.el.closest && fol.el.closest("th, thead, tr"))) {
      const n = numFromParent(fol.el);
      if (n !== null) d.yestVideoFollow = n;
    }
    // 当前时间范围（近7天 / 昨日 / 近30天），页面默认近7天
    const range = findLeaf(L, /^(近\s?\d+\s?天|昨日|今天|近\s?\d+\s?日)$/, 10);
    if (range) d.range = range.text.replace(/\s+/g, "");

    let got = postTableVideos(root);
    let layout = "table";
    if (!got || !got.videos.length) {
      postTryCnt += 1;
      if (postTryCnt >= 3) {                 // 表格怎么都解析不出时才走几何兜底（它要全页扫，较重）
        const g = postGridVideos(root);
        if (g && g.videos.length) { got = g; layout = "grid"; }
      }
    } else {
      postTryCnt = 0;
    }

    if (got && got.videos.length) {
      d.videos = got.videos.slice(0, 30);
      d.cols = got.cols || null;             // 便于排查取错列
      d.postLayout = layout;
      d.postRead = true;
      d.postTab = tabState;                  // current / missing / giving-up，排查用
    } else {
      // 页面已经渲染完、但确实没有视频（新号 / 这段时间没发作品）：
      // 也要记一笔，否则面板会一直提示「未读取」
      const bodyTxt = (document.body && document.body.innerText) || "";
      if (!/加载中|正在加载/.test(bodyTxt) &&
          /暂无数据|暂无视频|暂无作品|没有更多数据|还没有发布/.test(bodyTxt)) {
        d.videos = [];
        d.postRead = true;
        d.postEmpty = true;
        d.postTab = tabState;
      }
    }
    return Object.keys(d).length ? d : null;
  }

  /** 统计未读角标：数字角标求和，纯圆点算 1 条
   *  只在「会话 / 评论」这类列表容器内统计，并排除左侧「通知中心」的红点
   */
  function sumUnreadBadges(root, containerRe) {
    const out = { total: 0, badges: 0 };
    const nodes = queryAllDeepFrom(
      root,
      '[class*="badge"], [class*="unread"], [class*="red-dot"], [class*="reddot"], [class*="redDot"]'
    );
    for (const el of nodes) {
      if (panel && panel.contains(el)) continue;
      const txt = (el.innerText || el.textContent || "").trim();
      const isNum = /^\d{1,3}$/.test(txt);
      if (!isNum && !/badge|unread|dot/i.test(String(el.className || ""))) continue;
      if (!shown(el)) continue;
      let p = el, inList = false, isNotice = false;
      for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
        const pc = String(p.className || "");
        if (containerRe.test(pc)) inList = true;
        if (/message-center|notice|notif|bell|side-bar-footer/i.test(pc)) { isNotice = true; break; }
      }
      if (!inList || isNotice) continue;
      out.badges++;
      out.total += isNum ? parseInt(txt, 10) : 1;
    }
    return out;
  }

  // 「近 3 天」= 含今天在内的 3 个自然日（今天 / 昨天 / 前天），评论、私信两页共用
  const RECENT_DAYS = 3;

  /** 评论管理页：/platform/interaction/comment
   *  ★ v2.5.5 口径：近 3 天评论量
   *    = 「近 3 天（含今天）发布的作品」截至现在的评论总数之和
   *    页面每条作品只给「发布时间 + 评论总数」（.feed-time / .feed-comment-total），
   *    没有单条评论的时间，所以按作品发布时间归集（与视频数据页「近 7 天」同一思路）。
   */
  function collectComment(root, leaves) {
    const d = {};
    const L = leaves || leafTexts(root);
    // 右上角「共129个」= 作品数
    let total = null;
    for (const x of L) {
      const m = x.text.match(/共\s*(\d[\d,]*)\s*个/);
      if (m) { total = parseInt(m[1].replace(/,/g, ""), 10); break; }
    }
    if (total == null) {
      const el = queryAllDeepFrom(root, ".feeds-nums")[0];
      const m = el ? (el.textContent || "").match(/(\d[\d,]*)/) : null;
      if (m) total = parseInt(m[1].replace(/,/g, ""), 10);
    }
    if (total != null) d.commentTotal = total;

    // 作品行：真实结构是 .comment-feed-wrap，改版时逐层降级
    let rows = queryAllDeepFrom(root, ".comment-feed-wrap");
    if (!rows.length) rows = queryAllDeepFrom(root, ".feeds-container .feed-content");
    if (!rows.length) rows = queryAllDeepFrom(root, '[class*="feed-content"]');
    rows = rows.filter((el) => !rows.some((o) => o !== el && o.contains && o.contains(el)));

    // 取文本末尾的数字：支持 1,234 / 1.2万
    const numAtEnd = (s) => {
      const m = String(s || "").match(/(\d[\d,]*(?:\.\d+)?)\s*(万)?\s*$/);
      if (!m) return null;
      const n = parseFloat(m[1].replace(/,/g, ""));
      return isNaN(n) ? null : Math.round(n * (m[2] ? 10000 : 1));
    };

    if (!rows.length) {
      if (total) return null;           // 列表还没渲染出来，交给调用方稍后重试
      d.commentRecentDays = RECENT_DAYS;
      d.commentRecent = 0;
      d.commentRecentVideos = 0;
      d.commentScanned = 0;
      d.commentRead = true;
      return d;
    }

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const from = startOfToday - (RECENT_DAYS - 1) * 86400000; // 前天 00:00
    const to = startOfToday + 86400000;                       // 明天 00:00

    const list = [];
    const recent = [];
    let recentSum = 0, recentVideos = 0, unreadSum = 0, unreadVideos = 0;
    let dated = 0, oldest = null;

    rows.forEach((row) => {
      const txt = (sel) => {
        const el = row.querySelector(sel);
        return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
      };
      const title = txt(".feed-title") || txt('[class*="feed-title"]');
      const dateTxt = txt(".feed-time") || txt('[class*="feed-time"]');
      if (!title && !dateTxt) return;
      // 评论总数：.feed-comment-total 里最后一个数字（前面的 span 只是图标）
      const cntTxt = txt(".feed-comment-total") || txt('[class*="comment-total"]');
      const count = numAtEnd(cntTxt);
      // 未读角标：.unread-comment-number（没有新评论时是个空注释）
      const unTxt = txt(".unread-comment-number");
      const um = unTxt.match(/(\d[\d,]*)/);
      const unread = um ? parseInt(um[1].replace(/,/g, ""), 10) : (/未读|新/.test(unTxt) ? 1 : 0);
      if (unread > 0) { unreadSum += unread; unreadVideos++; }

      const dt = parseLooseDate(dateTxt, now);
      if (dt) {
        dated++;
        if (!oldest || dt.getTime() < oldest.getTime()) oldest = dt;
      }
      const near = !!dt && dt.getTime() >= from && dt.getTime() < to;
      const item = {
        title: (title || "(无标题)").slice(0, 40),
        date: dateTxt,
        count: count == null ? 0 : count,
        unread,
      };
      if (near) {
        recentSum += item.count;
        recentVideos++;
        if (recent.length < 30) recent.push({ title: item.title, count: item.count, date: dateTxt });
      }
      if (list.length < 40) list.push(item);
    });

    // 有作品行却一条日期都认不出 → 多半是改版了，别把「0 条」写进存储
    if (!dated && rows.length >= 3) return null;

    d.commentRecentDays = RECENT_DAYS;
    d.commentRecent = recentSum;             // 近3天评论总量
    d.commentRecentVideos = recentVideos;    // 近3天作品数
    d.commentScanned = rows.length;
    d.commentRead = true;
    if (list.length) d.commentVideos = list; // 前 40 条作品明细（排查用）
    if (recent.length) d.commentRecentList = recent;
    if (unreadSum) { d.unreadComments = unreadSum; d.unreadCommentVideos = unreadVideos; }
    if (dated < rows.length) d.commentNoDate = rows.length - dated;
    // 列表没滚到底、最旧一条还在近 3 天内 → 这 3 天可能还有没加载出来的
    if (total && rows.length < total && oldest && oldest.getTime() >= from) d.commentPartial = true;
    return Object.keys(d).length ? d : null;
  }

  /* ---------- 私信页：近 N 天私信数量 ---------- */

  /** 列表日期文本 → Date（认不出返回 null）。私信、评论两页共用
   *  认得：今天/昨天/前天 09:19、10月01日 09:19、2026/10/17 21:09、星期三、09:19
   */
  function parseLooseDate(txt, base) {
    const t = String(txt == null ? "" : txt).replace(/\s+/g, " ").trim();
    if (!t) return null;
    const now = base || new Date();
    const hm = t.match(/(\d{1,2})[:：](\d{2})/);
    const HH = hm ? Math.min(23, +hm[1]) : 0;
    const MI = hm ? Math.min(59, +hm[2]) : 0;
    const mk = (y, mo, d) => {
      const dt = new Date(y, mo - 1, d, HH, MI, 0, 0);
      return isNaN(dt.getTime()) ? null : dt;
    };
    const y = now.getFullYear(), mo = now.getMonth() + 1, d = now.getDate();
    if (/今\s*天/.test(t)) return mk(y, mo, d);
    if (/昨\s*天/.test(t)) return mk(y, mo, d - 1);
    if (/前\s*天/.test(t)) return mk(y, mo, d - 2);
    const mFull = t.match(/(\d{4})\s*[-\/年.]\s*(\d{1,2})\s*[-\/月.]\s*(\d{1,2})/);
    if (mFull) return mk(+mFull[1], +mFull[2], +mFull[3]);
    const mMD = t.match(/(\d{1,2})\s*(?:月|[-\/.])\s*(\d{1,2})/);
    if (mMD) {
      const m2 = +mMD[1], d2 = +mMD[2];
      if (m2 >= 1 && m2 <= 12 && d2 >= 1 && d2 <= 31) {
        let dt = mk(y, m2, d2);
        // 列表里的日期不带年份：算出来比今天还晚（12 月跨到次年 1 月）就按去年
        if (dt && dt.getTime() > now.getTime() + 86400000) dt = mk(y - 1, m2, d2);
        return dt;
      }
    }
    const mW = t.match(/(?:星期|周)([一二三四五六日天])/);
    if (mW) {
      const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
      const back = (now.getDay() - map[mW[1]] + 7) % 7;
      return mk(y, mo, d - back);
    }
    if (/^\d{1,2}[:：]\d{2}$/.test(t)) return mk(y, mo, d); // 只有时间 = 今天
    return null;
  }

  /** 私信会话行：优先 .session-wrap；改版时逐层降级 */
  function msgSessionRows(root) {
    const q = (sel) => {
      try { return queryAllDeepFrom(root, sel); } catch (e) { return []; }
    };
    let rows = q(".session-wrap");
    if (!rows.length) rows = q(".session-container .feed-content");
    if (!rows.length) rows = q(".private-msg-wrapper .feed-content");
    if (!rows.length) rows = q(".feed-title");
    // 只留最外层，避免同一会话被父子节点重复计数
    rows = rows.filter((el) => !rows.some((o) => o !== el && o.contains && o.contains(el)));
    return rows;
  }

  /** 私信管理页：/platform/private_msg
   *  ★ v2.5.4 口径：近 3 天（含今天）有私信往来的会话数量
   *    页面结构：.session-wrap > .feed-content > .feed-title(.name + .date) + .feed-info
   */
  function collectMsg(root, leaves) {
    const d = {};
    const L = leaves || leafTexts(root);
    // 页面右上角「共20个」（全部私信 / 未读私信 下拉旁边的会话总数）
    let total = null;
    for (const x of L) {
      const m = x.text.match(/共\s*(\d[\d,]*)\s*个/);
      if (m) { total = parseInt(m[1].replace(/,/g, ""), 10); break; }
    }
    if (total == null) {
      const el = queryAllDeepFrom(root, ".msg-nums")[0];
      const m = el ? (el.textContent || "").match(/(\d[\d,]*)/) : null;
      if (m) total = parseInt(m[1].replace(/,/g, ""), 10);
    }
    if (total != null) {
      d.msgTotal = total;
      d.totalMsgs = String(total);
    }

    const rows = msgSessionRows(root);
    if (!rows.length) {
      // 一条会话都没渲染，却写着「共 N 个」：列表还没出来，交给调用方稍后重试
      if (total) return null;
      d.msgRecentDays = RECENT_DAYS;
      d.msgRecent = 0;
      d.msgScanned = 0;
      d.msgRead = true;
      return d;
    }

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const from = startOfToday - (RECENT_DAYS - 1) * 86400000; // 前天 00:00
    const to = startOfToday + 86400000;                          // 明天 00:00（排除未来时间）
    const recent = [];
    let dated = 0;
    let oldest = null;

    rows.forEach((row) => {
      const cell = (sel) => {
        const el = row.querySelector(sel);
        return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
      };
      const name = cell(".name") || cell(".title");
      let dateTxt = cell(".date");
      if (!dateTxt) {
        // 日期有时落在 .feed-title 里的兄弟 span 上
        const sp = [...row.querySelectorAll(".feed-title span, span")].find(
          (s) => /\d{1,2}[:：]\d{2}/.test(s.textContent || "") && parseLooseDate(s.textContent, now)
        );
        if (sp) dateTxt = (sp.textContent || "").trim();
      }
      const dt = parseLooseDate(dateTxt, now);
      if (!dt) return;
      dated++;
      if (!oldest || dt.getTime() < oldest.getTime()) oldest = dt;
      if (dt.getTime() >= from && dt.getTime() < to) {
        recent.push({
          name: name || "(未命名)",
          date: dateTxt.replace(/\s+/g, " ").trim(),
          info: cell(".feed-info").slice(0, 40),
        });
      }
    });

    // 有会话行但一条日期都认不出 → 多半是改版了，别把「0 条」写进存储
    if (!dated && rows.length >= 3) return null;

    d.msgRecentDays = RECENT_DAYS;
    d.msgRecent = recent.length;
    d.msgScanned = rows.length;
    d.msgRead = true;
    if (recent.length) d.msgRecentList = recent.slice(0, 30);
    // 列表没滚到底、最旧一条还在近 3 天内 → 这几天可能还有没加载出来的
    if (total && rows.length < total && oldest && oldest.getTime() >= from) d.msgPartial = true;
    if (dated < rows.length) d.msgNoDate = rows.length - dated;
    return Object.keys(d).length ? d : null;
  }

  /** 首页：/platform/ —— 只取「昨日数据」里的播放/点赞/评论
   *  ★ 关注者总数 / 净增关注 / 新增关注 一律以「关注者数据页」为准：
   *    首页是卡片式布局，数字和标签挨得近，模糊匹配很容易串到隔壁的数（之前就不准）
   */
  function collectHome(root, leaves) {
    const d = {};
    const L = leaves || leafTexts(root);
    // 昨日数据四项：净增关注 -1 / 新增播放 4943 / 新增点赞 1 / 新增评论 0
    const cards = findLeaf(L, /昨日数据/, 12);
    if (cards) {
      const p = cards.el.parentElement;
      if (p) {
        const txt = p.innerText || "";
        const mNet = txt.match(/净增关注\s*(-?[\d,]+)/);
        const mPlay = txt.match(/新增播放\s*([\d,]+)/);
        const mLike = txt.match(/新增点赞\s*([\d,]+)/);
        const mCmt = txt.match(/新增评论\s*([\d,]+)/);
        if (mNet) d.yestNetAdd = mNet[1].replace(/,/g, "");
        if (mPlay) d.yestPlay = mPlay[1].replace(/,/g, "");
        if (mLike) d.yestLike = mLike[1].replace(/,/g, "");
        if (mCmt) d.yestComment = mCmt[1].replace(/,/g, "");
      }
    }
    return Object.keys(d).length ? d : null;
  }

  /** 在给定根下做 queryAllDeep（穿透 shadow 的集合查询） */
  function queryAllDeepFrom(root, selector) {
    const out = [];
    (function walk(el, depth) {
      if (depth > 14) return;
      let all = [];
      try { all = el.querySelectorAll ? el.querySelectorAll("*") : []; } catch (e) { return; }
      all.forEach((c) => {
        if (c.matches && c.matches(selector)) out.push(c);
        if (c.shadowRoot) walk(c.shadowRoot, depth + 1);
      });
    })(root === document ? document.documentElement : root, 0);
    return out;
  }

  /* 统计存储 */
  let lastStatsWrite = {};
  function loadStats(cb) {
    if (!HAS_STORE) { cb({}); return; }
    chrome.storage.local.get(STATS_KEY, (o) => cb((o && o[STATS_KEY]) || {}));
  }
  function saveStatsAll(all) {
    if (!HAS_STORE) return;
    chrome.storage.local.set({ [STATS_KEY]: all });
  }
  function saveStatsPartial(acc, patch, srcs) {
    loadStats((all) => {
      const cur = all[acc] || {};
      const next = Object.assign({}, cur, patch);
      // 与已有值完全相同则不重复写入（轮询时避免高频写 storage）
      const same = Object.keys(patch).every((k) =>
        JSON.stringify(cur[k]) === JSON.stringify(next[k])
      );
      // 记录「这一页最近一次读到数据」的时间（每次都刷新，换号/空数据也能看出真的读过）
      const srcList = srcs || [];
      next.readAt = Object.assign({}, cur.readAt);
      srcList.forEach((k) => { next.readAt[k] = Date.now(); });
      if (same && !srcList.length) return;
      next.updatedAt = Date.now();
      all[acc] = next;
      chrome.storage.local.set({ [STATS_KEY]: all }, () => {
        renderStats();
      });
    });
  }

  /** 当前页面属于哪一类数据页（只认这四个路径，别的一律不抓） */
  function pageKind() {
    const p = location.pathname || "";
    if (/\/statistic\/follower/.test(p)) return "follower";
    if (/\/statistic\/post/.test(p)) return "post";
    if (/\/interaction\/comment/.test(p)) return "comment";
    if (/\/private_msg/.test(p)) return "msg";
    if (/^\/platform\/?(index|home)?\/?$/.test(p)) return "home";
    return "other";
  }

  /** 当前 frame 尝试抓取
   *  ★ 只抓「本页对应」的那一项。以前「没命中就跑全部采集器」，
   *    结果在发表页/首页把页面上的杂数字写进统计（数值不准的主因之一）。
   */
  function tryCollectStats() {
    if (inLoginPage()) return false; // 登录页没有数据，别把杂数字写进去
    const kind = pageKind();
    if (kind === "other") return false;
    const root = document;
    const leaves = leafTexts(root); // 只扫一次 DOM
    let found = null;
    let src = kind;
    if (kind === "follower") found = collectFollower(root, leaves);
    else if (kind === "post") found = collectPost(root, leaves);
    else if (kind === "comment") found = collectComment(root, leaves);
    else if (kind === "msg") found = collectMsg(root, leaves);
    else if (kind === "home") { found = collectHome(root, leaves); src = "home"; }
    if (!found || !Object.keys(found).length) return false;
    // 视频页只读到「时间范围」这类装饰信息时，说明表格还没渲染出来，继续等
    if (kind === "post" && !Array.isArray(found.videos) && found.postRead !== true) return false;
    // ★ 写入时强制重新识别账号（不走 60 秒缓存）：换号后第一件事就是把数据记到新号名下
    const acc = accountKey(true);
    saveStatsPartial(acc, found, [src]);
    log("统计已抓取:", acc, found, "来源:", src);
    return true;
  }

  /* 统计面板 UI */
  let elStatsBox;
  function ensureStatsUI() {
    if (!panel || elStatsBox) return;
    const wrap = document.createElement("div");
    wrap.className = "wxch-stats";
    wrap.innerHTML = `
      <div class="wxch-stats-head">
        <span>统计数据</span>
        <div class="wxch-stats-acts">
          <button id="wxch-stats-refresh" class="wxch-stats-btn" title="依次读取四个数据页，取回最新数据">读取最新数据</button>
          <button id="wxch-stats-feishu" class="wxch-stats-btn" title="只同步当前登录的这个账号：昨天和今天发布的视频播放量写「新增浏览量」，更早的写「累计浏览量」，关注量写「视频关注量」；粉丝表写昨天的行（没有就自动新建）。数值直接覆盖">同步飞书</button>
        </div>
      </div>
      <div class="wxch-stats-body" id="wxch-stats-body">
        <div class="wxch-stats-empty">还没有读取过数据<br>点「读取最新数据」</div>
      </div>`;
    const body = panel.querySelector("#wxch-body");
    if (body) body.appendChild(wrap);
    elStatsBox = wrap;
    panel.classList.add("wxch-stats-wide"); // 统计区 3 列，面板加宽（CSS 里的 .wxch-stats-wide）
    wrap.querySelector("#wxch-stats-refresh").onclick = () => runCollectAll(false);
    wrap.querySelector("#wxch-stats-feishu").onclick = () => runFeishuSync();
  }

  /* ---------- 同步到飞书多维表格（v2.6.0） ---------- */
  let feishuBusy = false;
  let lastFeishuResult = null;

  function runFeishuSync() {
    if (feishuBusy) return;
    if (window.top !== window) return; // 只在顶层页面发起
    const btn = elStatsBox ? elStatsBox.querySelector("#wxch-stats-feishu") : null;
    const setBusy = (b, text) => {
      feishuBusy = !!b;
      if (!btn) return;
      btn.disabled = !!b;
      btn.textContent = b ? (text || "同步中…") : "同步飞书";
      btn.classList.toggle("wxch-busy", !!b);
    };
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      status("扩展未就绪，请重新加载插件", false);
      return;
    }
    // ★ v2.9.0：只同步「当前登录的这个账号」。
    //   你的流程是 登录A→查询→同步→退出→登录B→查询→同步，
    //   以前不带账号会让本机存过的所有账号一起被写一遍旧快照，反而覆盖正确数据。
    const acc = accountKey(true);
    if (!acc || acc === "未知账号") {
      status("还没识别到当前账号名，先点「读取最新数据」再同步", false);
      return;
    }
    setBusy(true);
    status(`正在把「${acc}」同步到飞书…`);
    chrome.runtime.sendMessage({ type: "wxchFeishuSync", account: acc }, (r) => {
      const err = chrome.runtime.lastError;
      if (err) {
        setBusy(false);
        status("后台未响应，请重新加载插件后重试", false);
        return;
      }
      lastFeishuResult = r || null;
      setBusy(false);
      if (!r) { status("飞书没有返回结果", false); return; }
      if (r.needSetup) {
        status(r.message + "——点插件图标，在弹窗里填好飞书配置再点同步", false);
        return;
      }
      if (!r.ok) {
        status("同步飞书失败：" + (r.message || "未知错误"), false);
        try { console.warn("[视频号助手] 飞书同步结果：", r); } catch (e) {}
        return;
      }
      const accList = (r.accounts || []).map((a) => a.name).filter(Boolean);
      const vU = r.video ? r.video.updated || 0 : 0;
      const fU = r.fans ? r.fans.updated || 0 : 0;
      const fC = r.fans ? r.fans.created || 0 : 0;
      let msg = `已同步 ${r.updated} 条`;
      if (r.fans) msg += `（浏览量 ${vU} / 粉丝 ${fU + fC}）`;
      if (fC) msg += `，粉丝表新建 ${fC} 行`;
      if (accList.length === 1) msg += ` · ${accList[0]}`;
      else if (accList.length > 1) msg += ` · ${accList.length} 个账号`;
      if (r.skippedCount) msg += `，跳过 ${r.skippedCount} 条（明细见控制台）`;
      status(msg, true);
      try {
        if (r.skippedCount) console.warn("[视频号助手] 飞书跳过的行：", r.skipped);
        console.log("[视频号助手] 飞书同步明细：", r);
      } catch (e) {}
    });
  }

  /* 跨页读取：按钮/自动触发时，由后台依次打开四个数据页取数 */
  let statsBusy = false;
  let jobWatchdog = 0;
  let busyPoll = 0;
  let busyMiss = 0;

  function armJobWatchdog() {
    clearTimeout(jobWatchdog);
    jobWatchdog = setTimeout(() => {
      if (!statsBusy) return;
      setStatsBusy(false);
      status("读取超时，可再点一次「读取最新数据」", false);
    }, 100000);
  }

  /** 心跳自愈：后台任务结束/失联时，别让按钮永远卡在「读取中」 */
  function startBusyPoll() {
    clearInterval(busyPoll);
    busyMiss = 0;
    busyPoll = setInterval(() => {
      if (!statsBusy) { clearInterval(busyPoll); return; }
      chrome.runtime.sendMessage({ type: "wxchJobState" }, (r) => {
        const err = chrome.runtime.lastError;
        if (err) {
          if (++busyMiss >= 2) {
            clearInterval(busyPoll);
            setStatsBusy(false);
            status("后台未响应，请重新加载插件后重试", false);
          }
          return;
        }
        busyMiss = 0;
        if (r && r.busy === false) {
          clearInterval(busyPoll);
          setStatsBusy(false);
          renderStats();
          status("读取已结束，可再点一次「读取最新数据」", true);
        }
      });
    }, 4000);
  }

  function stopBusyPoll() {
    clearInterval(busyPoll);
    busyMiss = 0;
  }

  function setStatsBusy(busy, text) {
    statsBusy = !!busy;
    const btn = elStatsBox ? elStatsBox.querySelector("#wxch-stats-refresh") : null;
    if (!btn) return;
    btn.disabled = !!busy;
    btn.textContent = busy ? (text || "读取中…") : "读取最新数据";
    btn.classList.toggle("wxch-busy", !!busy);
  }

  /** 是否真的停在登录/扫码页（登录后侧边栏账号区存在，就不会误判） */
  function inLoginPage() {
    if (/\/login|login\.html/i.test(location.href)) return true;
    if (document.querySelector(".side-bar-footer .account-info .name")) return false;
    const accBox = queryAllDeep(".side-bar-footer .account-info .name").filter((el) => shown(el));
    if (accBox.length) return false;
    const qr = queryAllDeep('[class*="qrcode"], [class*="login-qrcode"], [class*="qrcode-img"]')
      .filter((el) => shown(el));
    return qr.length > 0;
  }

  function runCollectAll(silent) {
    if (statsBusy) return;
    if (window.top !== window) return; // 只在顶层页面发起
    if (inLoginPage()) {
      setStatsBusy(false);
      status("当前在登录页，请先扫码登录视频号助手", false);
      return;
    }
    tryCollectStats(); // 当前页先就地抓一次，按钮响应更快
    renderStats();
    setStatsBusy(true, "读取中…");
    // ★ 当前页就是数据页时，后台不用再跑一遍（否则视频页会把你当下看的页面切走）
    const here = pageKind();
    const skip = ["follower", "post", "comment", "msg"].indexOf(here) >= 0 ? [here] : [];
    // 当前页继续就地重试：
    //   · 视频页要先点「单篇视频」标签、再等表格渲染，一次抓不到（v2.6.1）
    //   · 其余页面也可能还在加载
    // 后台跳过了当前页，所以这里必须自己等，不然视频数据永远是空的。
    if (skip.length) {
      collectWithRetry(here === "post" ? 15000 : 8000).then(() => renderStats());
    }
    if (!silent) {
      status(skip.length
        ? "读取中：当前页已读取，正在打开其余数据页…"
        : "读取中：正在打开各数据页（视频数据页需切到前台渲染，读完自动切回）");
    }
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      setStatsBusy(false);
      if (!silent) status("扩展未就绪，请重新加载插件", false);
      return;
    }
    chrome.runtime.sendMessage({ type: "wxchCollectAll", skip }, (res) => {
      const err = chrome.runtime.lastError;
      if (err || !res || !res.ok) {
        setStatsBusy(false);
        if (!silent) status("后台读取不可用（请到扩展管理页重新加载插件）", false);
        return;
      }
      armJobWatchdog();
      startBusyPoll();
      if (!silent && res.busy) status("已有读取任务在进行中…");
    });
  }

  /** 通用账号键：老版本识别失败时存下的（如「未知账号」），可安全并入当前账号 */
  function isGenericAccKey(k) {
    return /^(未知账号|当前账号|未登录|未识别.*)$/.test(String(k || "").trim());
  }

  /** 只取一条记录：当前登录账号优先，没有则回退最近更新的一条 */
  function pickStatsEntry(all) {
    const cur = accountKey();
    if (all[cur] && Object.keys(all[cur]).length) return { acc: cur, s: all[cur] };
    let best = "", bestAt = -1;
    Object.keys(all).forEach((k) => {
      const s = all[k];
      if (!s || !Object.keys(s).length) return;
      const at = s.updatedAt || 0;
      if (at > bestAt) { bestAt = at; best = k; }
    });
    return best ? { acc: best, s: all[best] } : null;
  }

  function renderStats() {
    if (!panel || !elStatsBox) return;
    loadStats((all) => {
      const body = panel.querySelector("#wxch-stats-body");
      if (!body) return;
      let picked = pickStatsEntry(all);
      if (!picked) {
        body.innerHTML = inLoginPage()
          ? `<div class="wxch-stats-empty">请先扫码登录视频号助手<br>登录后点「读取最新数据」</div>`
          : `<div class="wxch-stats-empty">还没有读取过数据<br>点「读取最新数据」</div>`;
        return;
      }
      // 老版本可能把数据存在「未知账号」名下：并到当前账号，避免面板出现多组重复块
      const cur = accountKey();
      if (!isGenericAccKey(cur)) {
        let dirty = false;
        Object.keys(all).forEach((k) => {
          if (k === cur || !isGenericAccKey(k)) return;
          // 两份数据按更新时间取新的那份覆盖旧的，避免刚抓到的数被旧数据盖回去
          const a = all[k] || {};
          const b = all[cur] || {};
          const newer = (a.updatedAt || 0) > (b.updatedAt || 0) ? a : b;
          const older = newer === a ? b : a;
          const merged = Object.assign({}, older, newer);
          merged.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
          all[cur] = merged;
          delete all[k];
          dirty = true;
        });
        if (dirty) {
          saveStatsAll(all);
          picked = { acc: cur, s: all[cur] };
        } else if (picked.acc !== cur && all[cur] && Object.keys(all[cur]).length) {
          picked = { acc: cur, s: all[cur] };
        }
      }

      const s = picked.s;
      const acc = picked.acc;
      const vids = Array.isArray(s.videos) ? s.videos : [];
      const range = (s.range || "近7天").replace(/\s+/g, "");
      const dt = new Date(s.updatedAt || Date.now());
      const tm = `${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")} ` +
        dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const tip = (k, label) => {
        const raw = s[k + "Raw"];
        const howCn = {
          keypoint: "指标卡片 .name/.value", table: "表格·昨日列",
          "row-anchor": "同一行·按昨日列", "row-left": "同一行·最左",
          row: "同一行", line: "标签上方/下方", "line-anchor": "按昨日列",
          "line-cols": "周期三列·最左", "line-near": "就近", col: "同列就近",
          order: "文档顺序", legacy: "就近兜底", parent: "父容器兜底",
        };
        const how = howCn[(s.how || {})[k]] || "";
        const parts = [];
        if (raw) parts.push(`页面原文「${raw}」`);
        if (how) parts.push("识别方式：" + how);
        parts.push("读取时间 " + tm);
        return ` title="${escapeHtml(label + " · " + parts.join("；"))}"`;
      };

      const msgDays = s.msgRecentDays || RECENT_DAYS;
      const msgTip = (() => {
        const p = [];
        const names = (s.msgRecentList || []).map((x) => x.name).filter(Boolean);
        if (names.length) p.push(`近${msgDays}天：${names.slice(0, 6).join("、")}${names.length > 6 ? " 等" : ""}`);
        if (s.msgTotal != null) p.push(`列表共 ${s.msgTotal} 个会话`);
        if (s.msgScanned != null) p.push(`本次扫描 ${s.msgScanned} 条`);
        if (s.msgPartial) p.push("列表还没滚到底，可能还有更早的");
        if (s.msgNoDate) p.push(`${s.msgNoDate} 条日期认不出`);
        p.push("读取时间 " + tm);
        return ` title="${escapeHtml("近" + msgDays + "天私信 · " + p.join("；"))}"`;
      })();

      const cmDays = s.commentRecentDays || RECENT_DAYS;
      const cmTip = (() => {
        const p = [];
        const list = s.commentRecentList || [];
        if (list.length) {
          p.push(`近${cmDays}天 ${list.length} 个作品：` +
            list.slice(0, 4).map((x) => `${x.title}（${x.count}）`).join("、") + (list.length > 4 ? " 等" : ""));
        }
        if (s.commentTotal != null) p.push(`列表共 ${s.commentTotal} 个作品`);
        if (s.commentScanned != null) p.push(`本次扫描 ${s.commentScanned} 个`);
        if (s.commentPartial) p.push("列表还没滚到底，可能还有更早的");
        if (s.commentNoDate) p.push(`${s.commentNoDate} 条日期认不出`);
        p.push("读取时间 " + tm);
        return ` title="${escapeHtml("近" + cmDays + "天评论 · " + p.join("；"))}"`;
      })();

      let html = "";
      html += `<div class="wxch-stats-acc">${escapeHtml(acc)} · 读取 ${escapeHtml(tm)}</div>`;
      html += `<div class="wxch-stats-grid">`;
      html += `<div class="wxch-stats-k"><span>关注者</span><b${tip("fansTotal", "关注者总数")}>${fmtStat(s.fansTotal)}</b></div>`;
      html += `<div class="wxch-stats-k"><span>净增关注</span><b${tip("netAdd", "净增关注")}>${fmtStat(s.netAdd)}</b></div>`;
      html += `<div class="wxch-stats-k"><span>新增关注</span><b${tip("newAdd", "新增关注")}>${fmtStat(s.newAdd)}</b></div>`;
      html += `<div class="wxch-stats-k"><span>近${msgDays}天私信</span><b${msgTip} class="${s.msgRecent > 0 ? "wxch-hot" : ""}">${s.msgRecent != null ? s.msgRecent : "-"}</b></div>`;
      html += `<div class="wxch-stats-k"><span>近${cmDays}天评论</span><b${cmTip} class="${(s.commentRecent != null ? s.commentRecent : s.unreadComments) > 0 ? "wxch-hot" : ""}">${s.commentRecent != null ? s.commentRecent : (s.unreadComments != null ? s.unreadComments : "-")}</b></div>`;
      html += `<div class="wxch-stats-k"><span>${escapeHtml(range)}视频</span><b>${s.postRead ? vids.length : (vids.length || "-")}</b></div>`;
      html += `</div>`;

      // 近 N 天私信：数量 + 谁发来的（一行小字，最多列 5 个）
      if (s.msgRecent != null) {
        const names = (s.msgRecentList || []).map((x) => x.name).filter(Boolean);
        const head = names.length
          ? "：" + names.slice(0, 5).join("、") + (names.length > 5 ? ` 等 ${names.length} 人` : "")
          : "";
        const tail = (s.msgTotal != null ? `（全部 ${s.msgTotal} 个会话）` : "") +
          (s.msgPartial ? "（列表未滚到底，可能还有）" : "");
        html += `<div class="wxch-stats-sub">${escapeHtml(`近${msgDays}天私信 ${s.msgRecent} 人` + head + tail)}</div>`;
      } else if (s.unreadMsgs != null) {
        // 老数据：v2.5.3 之前存的是「未读数」
        html += `<div class="wxch-stats-sub">${escapeHtml(`新私信 ${s.unreadMsgs}（旧口径：未读数，点「读取最新数据」换成近${msgDays}天）`)}</div>`;
      }

      // 近 N 天评论：数量 + 覆盖多少个作品
      if (s.commentRecent != null) {
        const tail = (s.commentPartial ? "（列表未滚到底，可能还有）" : "");
        html += `<div class="wxch-stats-sub">${escapeHtml(`近${cmDays}天评论 ${s.commentRecent} 条（${s.commentRecentVideos || 0} 个作品）` + tail)}</div>`;
      } else if (s.unreadComments != null) {
        html += `<div class="wxch-stats-sub">${escapeHtml(`新评论 ${s.unreadComments}（旧口径：未读数，点「读取最新数据」换成近${cmDays}天）`)}</div>`;
      }

      // 每个视频：标题 + 播放量 + 关注量
      if (vids.length) {
        html += `<div class="wxch-stats-sub">${escapeHtml(range)}视频数据（${vids.length} 条）· 播放 / 关注</div>`;
        html += `<div class="wxch-stats-vlist">`;
        vids.forEach((v) => {
          const meta = [escapeHtml(fmtDate(v.date)), `播放 ${escapeHtml(v.play || "-")}`, `关注 ${escapeHtml(v.follow || "-")}`]
            .filter(Boolean).join(" · ");
          html += `<div class="wxch-stats-v">` +
            `<span class="t" title="${escapeHtml(v.title)}">${escapeHtml(v.title)}</span>` +
            `<span class="m">${meta}</span></div>`;
        });
        html += `</div>`;
      } else if (s.postRead) {
        // 读到了视频数据页，但这段时间确实没有作品：这是「0 条」，不是「读取失败」
        html += `<div class="wxch-stats-sub">${escapeHtml(range)}视频数据（0 条）</div>` +
          `<div class="wxch-stats-miss">这段时间没有发布视频（视频数据页已读到，不是读取失败）</div>`;
      }

      // 哪些页还没有数据（按「有没有值」判断，老数据也不会误报）
      const srcName = { follower: "关注者", msg: "私信", comment: "评论", post: "视频" };
      const has = {
        follower: s.fansTotal != null || s.netAdd != null || s.newAdd != null,
        msg: s.msgRecent != null || s.unreadMsgs != null,
        comment: s.commentRecent != null || s.unreadComments != null,
        post: vids.length > 0 || s.postRead === true,
      };
      const missing = Object.keys(srcName).filter((k) => !has[k]);
      if (missing.length) {
        html += `<div class="wxch-stats-miss">未读取：${missing.map((k) => srcName[k]).join(" / ")}（点「读取最新数据」）</div>`;
      }
      body.innerHTML = html;
    });
  }

  /** 日期缩成 10-15（认不出就原样截断，如「昨天」） */
  function fmtDate(s) {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    if (!t) return "";
    const m = t.match(/(\d{4})\s*[-\/年.]\s*(\d{1,2})\s*[-\/月.]\s*(\d{1,2})/);
    if (m) return `${+m[2]}-${+m[3]}`;
    const m2 = t.match(/^(\d{1,2})\s*[-\/月.]\s*(\d{1,2})/);
    if (m2) return `${+m2[1]}-${+m2[2]}`;
    return t.slice(0, 8);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  /** 面板显示用：纯数字且 >=4 位时加千分位（19801 → 19,801），万/小数/短数字原样 */
  function fmtStat(v) {
    if (v === null || v === undefined || v === "") return "-";
    const t = String(v).trim();
    if (!/^-?\d{4,}$/.test(t)) return t;
    return t.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  /* ---------- 跨页读取：与后台 service worker 协作 ---------- */
  /** 等 DOM 里出现可读数据再回应（表格/卡片是异步渲染的） */
  function collectWithRetry(maxMs) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      postTryCnt = 0;
      const tick = () => {
        let ok = false;
        try { ok = tryCollectStats(); } catch (e) { ok = false; }
        if (ok) { resolve({ ok: true }); return; }
        if (Date.now() - t0 > maxMs) { resolve({ ok: false, reason: "页面没有可读数据" }); return; }
        setTimeout(tick, 800);
      };
      tick();
    });
  }

  /** 告诉后台「这一页已加载」，后台据此发来抓取指令 */
  function notifyReady() {
    if (window.top !== window) return;
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) return;
    try {
      chrome.runtime.sendMessage({ type: "wxchContentReady", path: location.pathname }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* ignore */ }
  }

  // 统计模块：只把「上次读到的快照」渲染出来，自己不抓数
  // ★ v2.5.0：去掉登录后自动读取、15 秒轮询、切路由补抓。
  //   数据一律以点「读取最新数据」那一刻读到的页面为准，
  //   这样既不会被浏览别的页面时的杂数字覆盖，数字也不会在你眼前跳。
  function initStatsModule() {
    ensureStatsUI();
    renderStats();
  }

  /* ---------- 启动：面板立刻注入，不依赖发布页是否已加载完成 ---------- */
  // 视频号是单页应用，切换路由不会重新注入脚本，
  // 因此这里持续监听 URL 变化，只要进入平台页就保证面板存在。
  function ensurePanel() {
    if (!document.body) return;
    if (!panel) buildPanel();
    render();
    initStatsModule(); // ★ v2.3.1 修复：之前这里漏了调用，统计区/账号名一直没被渲染
  }

  // 读取缓存/手动指定的账号名（异步），拿到后立刻补渲染一次
  loadAccStore(() => {
    if (panel) {
      render();
      renderStats();
    }
  });

  // 立即尝试，并以轮询兜底（应对 body 尚未就绪）
  let boot = 0;
  const bootTimer = setInterval(() => {
    boot++;
    if (document.body) {
      clearInterval(bootTimer);
      ensurePanel();
      notifyReady(); // 通知后台：本页已注入，可下发抓取指令
      log("面板已注入 | frame=" + location.href +
        " | 顶层?=" + (window.top === window) +
        " | file input 数=" + queryAllDeep('input[type="file"]').length +
        " | 版本 2.9.0（调试命令见 __wxch.help()）");
    } else if (boot > 60) {
      clearInterval(bootTimer);
    }
  }, 300);

  // 监听 SPA 路由变化：URL 变了就确保面板还在
  let lastUrl = location.href;
  setInterval(() => {
    if (elAcc) {
      const name = detectAccountName();
      if (elAcc.textContent !== name) elAcc.textContent = name;
    }
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      ensurePanel();
      notifyReady();
    }
  }, 800);

  // 临时数据页读到数后会写 storage：这里只「重新渲染已存的快照」，不触发任何抓取
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[STATS_KEY]) return;
      if (window.top !== window) return;
      renderStats();
    });
  }

  // 监听 popup 的导入/刷新消息
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      // 后台跨页读取：收到指令后在当前页反复尝试直到抓到数据
      if (msg.type === "wxchCollect") {
        // 视频数据页要先切「单篇视频」再等表格渲染，多给 6 秒
        const waitMs = msg.pageKey === "post" ? 18000 : 12000;
        collectWithRetry(waitMs).then((r) => sendResponse(r));
        return true;
      }
      // 读取进度 / 结束（广播）
      if (msg.type === "wxchCollectProgress") {
        if (statsBusy) {
          setStatsBusy(true, msg.text || "读取中…");
          status(msg.text || "");
        }
        return;
      }
      if (msg.type === "wxchCollectDone") {
        clearTimeout(jobWatchdog);
        stopBusyPoll();
        setStatsBusy(false);
        renderStats();
        const rs = (msg.results || []).filter(Boolean);
        const okNames = rs.filter((r) => r.ok).map((r) => r.name);
        const badNames = rs.filter((r) => !r.ok).map((r) => r.name);
        if (okNames.length) {
          status("已读取：" + okNames.join("、") +
            (badNames.length ? "；未读到：" + badNames.join("、") : ""), true);
        } else {
          status(msg.message || "没读到数据（可能未登录或页面结构已变）", false);
        }
        return;
      }
      if (msg.type === "refresh") {
        if (!panel) buildPanel();
        render();
      } else if (msg.type === "diagnose") {
        const eds = findEditables();
        const bad = checkPage();
        sendResponse({
          url: location.href,
          path: location.pathname,
          pageOk: !bad,
          pageMsg: bad ? bad.msg : "",
          ce: queryAllDeep('[contenteditable="true"]').length,
          io: queryAllDeep("input,textarea").length,
          roots: collectRoots().length,
          candidates: eds.map((e) => {
            const r = e.getBoundingClientRect();
            return {
              tag: e.tagName,
              cls: String(e.className || "").slice(0, 60),
              ph: e.getAttribute("placeholder") || e.getAttribute("data-placeholder") || "",
              editable: e.getAttribute("contenteditable") || "",
              rect: Math.round(r.width) + "x" + Math.round(r.height),
            };
          }),
        });
        return true; // 同步返回，但保持通道语义
      }
    });
  }
})();
