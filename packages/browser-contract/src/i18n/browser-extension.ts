/** Stable screenshot failure codes shared by the extension and desktop host. */
export const browserScreenshotErrors = {
  zh: {
    browser_screenshot_rate_limited: "浏览器截图请求过于频繁，请稍后再试。",
    browser_screenshot_window_obscured: "浏览器窗口被遮挡，暂时无法截图。",
    browser_screenshot_window_minimized: "浏览器窗口已最小化，暂时无法截图。",
    browser_screenshot_tab_inactive: "要截图的标签页已不是当前标签页。",
    browser_screenshot_restricted: "这个页面不允许浏览器扩展截图。",
    browser_screenshot_unavailable: "浏览器没有返回可用截图。",
  },
  en: {
    browser_screenshot_rate_limited:
      "Browser screenshot requests are too frequent; try again shortly.",
    browser_screenshot_window_obscured: "The browser window is obscured, so it cannot be captured.",
    browser_screenshot_window_minimized:
      "The browser window is minimized, so it cannot be captured.",
    browser_screenshot_tab_inactive: "The tab to capture is no longer the active tab.",
    browser_screenshot_restricted: "This page does not allow browser extension screenshots.",
    browser_screenshot_unavailable: "The browser did not return a usable screenshot.",
  },
} as const;
