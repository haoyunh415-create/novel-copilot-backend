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
