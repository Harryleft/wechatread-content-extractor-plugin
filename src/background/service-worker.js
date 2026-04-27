/**
 * WereadExtract - Background Service Worker
 */

// 安装事件
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[WereadExtract] 已安装');
    // 设置默认格式
    chrome.storage.local.set({
      wereadExtractFormat: 'markdown'
    });
  }
});

// 点击扩展图标时（如果没有 popup），可以在这里处理
// 当前有 popup，这里仅做备用消息转发
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 转发 popup → content 的消息（备用通道）
  if (msg.type === 'RELAY_TO_CONTENT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, msg.payload, sendResponse);
      } else {
        sendResponse({ error: 'No active tab' });
      }
    });
    return true;
  }
});
