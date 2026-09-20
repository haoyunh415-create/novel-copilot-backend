// 扩展安装/更新时初始化
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.storage.local.set({ installed_at: Date.now() });
    console.log("鉴来助手已安装");
  }
  if (details.reason === "update") {
    console.log("鉴来助手已更新到版本 " + chrome.runtime.getManifest().version);
  }
});

// 跨域正文抓取代理：content script 受 CORS 限制（Chrome 85+），
// 经后台 service worker（已声明 host_permissions）转发，抓取纵横 read.zongheng.com 等跨域章节正文。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "jl-fetch-text" && msg.url) {
    (async () => {
      try {
        const resp = await fetch(msg.url, { credentials: "include" });
        const text = await resp.text();
        sendResponse({ ok: resp.ok, status: resp.status, text });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true; // 异步响应，保持消息通道打开
  }
});
