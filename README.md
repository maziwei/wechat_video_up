# 视频号发布助手（Chrome 插件）

一个跑在微信视频号后台（`channels.weixin.qq.com`）的浏览器插件，把「每天手动发视频、手动抄数据」变成两条流水线：

- **发布流水线**：粘贴一段 JSON 导入排期任务 → 插件在发布页自动填标题、话题、定时时间、选择视频和封面 → 到点发表
- **数据流水线**：页面上浮动面板一键读取关注者、视频播放/关注、评论、私信数据 → 同步到飞书多维表格

纯前端 Chrome Extension (Manifest V3)，没有后端、没有账号体系。任务数据全部存在浏览器本地（`chrome.storage.local`），只和视频号后台与飞书开放接口通信。

## 功能

**自动发布**
- 粘贴 JSON 一次性导入整批任务（支持 Windows / 绝对相对路径、多种容错写法）
- 自动解析并保存「素材根目录」，video / cover 绝对、相对路径都能用
- 自动填标题、话题标签（`#话题`）、定时时间，选择视频与封面文件
- 支持指定发布账号、定时发表

**数据面板**
- 穿透视频号后台的 Shadow DOM（Wujie 微前端），浮动面板显示：
  - 关注者数据（`/platform/statistic/follower`）
  - 视频播放与关注数据（`/platform/statistic/post`）
  - 评论（`/platform/interaction/comment`）、私信（`/platform/private_msg`）
- 账号名识别多级兜底（页面节点 → localStorage / cookie → 标题），改版不易失效

**飞书同步**
- 数据一键写入飞书多维表格（Bitable）
- 使用你自己的飞书应用凭证（App ID / App Secret），存在浏览器本地，不经过任何第三方
- 支持飞书 / Larksuite 域名，token 自动刷新

## 安装

1. 下载或 clone 本仓库
2. 打开 Chrome / Edge 的 `chrome://extensions/`（Edge 为 `edge://extensions/`）
3. 打开右上角「开发者模式」
4. 「加载已解压的扩展程序」→ 选择本目录
5. 打开视频号后台，点浏览器右上角插件图标开始使用

## 任务 JSON 格式

```json
{
  "root": "D:\\素材",
  "tasks": [
    { "time": "2026-10-16 12:03", "acc": "我的账号",
      "title": "视频标题", "tags": ["话题1", "话题2"],
      "video": "D:\\素材\\我的账号\\73_xxx.mp4",
      "cover": "D:\\素材\\我的账号\\73_xxx.png" }
  ]
}
```

## 飞书配置（需自备）

插件**不内置**任何表格地址和凭证。首次使用在插件弹窗里填：

| 项 | 说明 |
|---|---|
| 多维表格链接 | 形如 `https://xxx.feishu.cn/base/你的baseToken?table=tbl你的表ID`（直接粘贴表格 URL 即可，插件自动解析） |
| App ID | `cli_` 开头的应用 ID，弹窗输入框的占位提示就是它的格式（`cli_xxxxxxxxxxxx`） |
| App Secret | 与 App ID 同页的「App Secret」，点显示后复制 |

获取路径：[飞书开放平台](https://open.feishu.cn/) → 开发者后台 → 你的自建应用 →「凭证与基础信息」。应用需要开通「多维表格」权限并把表格授权给应用。

注意：插件**不会自动创建**多维表格或字段，请先在飞书里建好表和列。

## 目录结构

```
├── manifest.json      插件清单 (MV3)
├── background.js      后台：拉取统计数据
├── content.js         页面脚本：自动填写 / 浮动面板 / 数据读取
├── feishu.js          飞书多维表格 API 封装
├── popup.html / .js   弹窗：任务导入与飞书配置
└── content.css        面板样式
```

## 隐私

- 任务、凭证、统计数据全部存本机浏览器，卸载插件即消失
- 网络请求只有两类：视频号后台页面本身、`open.feishu.cn` 开放接口
- 仓库不含任何真实凭证、表格地址或账号数据

## License

代码以 [MIT](LICENSE) 许可证发布。
