<div align="center">

# Weread Extractor

<p align="center">
  <img src="logo/logo.png" alt="Weread Extractor Logo" width="200" />
</p>

> *「不光读完，还要读懂」*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Chrome Extension](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-blue)](https://developer.chrome.com/docs/extensions/mv3/)
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen.svg)](https://github.com/Harryleft/weread-extractor/pulls)

<br>

**一键提取章节内容，交给 AI 理解**

<br>

[效果演示](#效果演示) · [安装](#安装) · [使用](#使用) · [背后的故事](#背后的故事)

<br>

</div>

---

## 效果演示

**一键操作，一步到位。**

点击右下角蓝色按钮 → 自动提取 + 复制 → 粘贴到 AI 对话窗口。

提取出的内容自动格式化为 Markdown：

```markdown
## 第三章 认知驱动

真正的成长不是积累知识，而是改变认知框架...

### 认知框架的本质

认知框架是我们理解世界的方式。它不是静态的...
```

在微信读书阅读页右下角点击按钮，整章内容即刻到手。

---

## 安装

### 开发者模式加载

1. 克隆仓库
   ```bash
   git clone https://github.com/Harryleft/weread-extractor.git
   ```

2. 打开 Chrome，地址栏输入 `chrome://extensions/`

3. 开启右上角「**开发者模式**」

4. 点击「**加载已解压的扩展程序**」→ 选择本项目根目录

5. 打开 [weread.qq.com](https://weread.qq.com) 任意书籍阅读页，右下角出现蓝色按钮即安装成功

---

## 使用

| 操作 | 效果 |
|------|------|
| 点击右下角蓝色按钮 | 一键提取当前可见内容并复制到剪贴板 |
| 点击工具栏插件图标 | 打开 Popup 面板，可预览后再复制 |

复制后直接粘贴到 ChatGPT、Claude、DeepSeek 等 AI 工具中进行分析。

---

## 背后的故事

我经常用微信读书看书，看到精彩内容想摘出来交给 AI 做深度分析。但微信读书的正文通过 Canvas 渲染，无法直接复制。

手动截图再 OCR？太慢。一篇篇导出？太麻烦。

后来发现 [drunkdream/weread-exporter](https://github.com/drunkdream/weread-exporter) 的思路——Hook Canvas `fillText()` 在文字渲染前截获。于是基于这个思路做了 Chrome 插件版本，一键提取、自动格式化、直接进剪贴板。

从「点击按钮 → 打开面板 → 选择提取 → 点击复制」到「点击按钮 → 完成」，让提取这件事尽可能无感。

---

<div align="center">

MIT License © [Harryleft](https://github.com/Harryleft)

</div>
