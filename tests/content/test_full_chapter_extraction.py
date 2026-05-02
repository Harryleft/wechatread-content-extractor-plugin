import json
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def run_node(script):
    result = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout)


def build_extractor_script(test_body):
    extractor_source = (ROOT / "src/content/extractor.js").read_text(encoding="utf-8")
    return f"""
const fs = require('fs');
const vm = require('vm');
const logs = [];

function printResult(value) {{
  process.stdout.write(JSON.stringify(value));
}}

const context = {{
  console: {{
    log(message) {{ logs.push(String(message)); }},
    warn() {{}},
    error() {{}}
  }},
  location: {{ href: 'https://weread.qq.com/web/reader/book/chapter' }},
  document: {{
    querySelectorAll() {{ return []; }},
    querySelector() {{ return null; }},
    createElement() {{
      return {{
        innerHTML: '',
        textContent: '',
        querySelectorAll() {{ return []; }}
      }};
    }}
  }},
  window: {{
    addEventListener() {{}},
    removeEventListener() {{}},
    postMessage() {{}}
  }},
  setTimeout,
  clearTimeout
}};
context.window.window = context.window;
context.window.document = context.document;
context.window.location = context.location;
context.globalThis = context;

vm.createContext(context);
vm.runInContext({json.dumps(extractor_source)}, context);

(async () => {{
  const extractor = context.window.__wereadExtractor;
  extractor._debugEnabled = true;
  extractor.getBookMeta = async () => ({{
    title: '测试书',
    author: '测试作者',
    bookId: 'book-1',
    chapterUid: 'chapter-1',
    chapterTitle: '第一章',
    chapterIndex: 0,
    isCanvasMode: true
  }});
  {test_body}
}})().catch((error) => {{
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}});
"""


def test_extract_visible_prefers_full_chapter_content_over_canvas_buffer():
    """Given 完整章节可用 When 提取真实内容 Then 不应使用 Canvas 临时缓冲。"""
    script = build_extractor_script(
        """
  extractor._extractFullChapterContent = async () => ({
    rawContent: '完整章节第一段\\n\\n完整章节第二段',
    source: 'full-chapter',
    title: '第一章',
    chapterUid: 'chapter-1'
  });
  extractor._extractFromCanvas = async () => 'Canvas 只捕获到一小段可见内容';

  const result = await extractor.extractVisible();
  printResult({
    success: result.success,
    method: result.method,
    rawContent: result.rawContent,
    content: result.content
  });
"""
    )

    result = run_node(script)

    assert result["success"] is True
    assert result["method"] == "full-chapter"
    assert result["rawContent"] == "完整章节第一段\n\n完整章节第二段"
    assert "Canvas 只捕获到一小段可见内容" not in result["content"]


def test_extract_visible_falls_back_to_canvas_when_full_chapter_is_unavailable():
    """Given 完整章节不可用 When 提取真实内容 Then 使用 Canvas 兜底但标明来源。"""
    script = build_extractor_script(
        """
  extractor._extractFullChapterContent = async () => ({
    rawContent: '',
    error: '页面没有返回完整章节内容。'
  });
  extractor._extractFromCanvas = async () => 'Canvas 兜底内容超过二十个字符，确保可以通过长度校验。';

  const result = await extractor.extractVisible();
  printResult({
    success: result.success,
    method: result.method,
    rawContent: result.rawContent
  });
"""
    )

    result = run_node(script)

    assert result["success"] is True
    assert result["method"] == "canvas-hook"
    assert result["rawContent"] == "Canvas 兜底内容超过二十个字符，确保可以通过长度校验。"


def test_canvas_hook_exposes_full_chapter_bridge():
    """Given 主世界 Hook When 提取完整章节 Then 应提供章节内容消息桥。"""
    canvas_hook = (ROOT / "src/content/canvas-hook.js").read_text(encoding="utf-8")

    assert "WEREAD_REQ_CHAPTER_CONTENT" in canvas_hook
    assert "WEREAD_CHAPTER_CONTENT" in canvas_hook
    assert "getFullChapterContent" in canvas_hook


def test_extract_visible_writes_debug_logs_with_required_prefix():
    """Given 调试开启 When 提取内容 Then 控制台日志必须使用指定前缀。"""
    script = build_extractor_script(
        """
  extractor._extractFullChapterContent = async () => ({
    rawContent: '',
    error: '页面没有返回完整章节内容。'
  });
  extractor._extractFromCanvas = async () => 'Canvas 兜底内容超过二十个字符，确保可以通过长度校验。';

  const result = await extractor.extractVisible();
  printResult({
    success: result.success,
    logs
  });
"""
    )

    result = run_node(script)

    assert result["success"] is True
    assert result["logs"]
    assert all(log.startswith("[debug]:") for log in result["logs"])
    assert any("extract-start" in log for log in result["logs"])
    assert any("extract-complete" in log for log in result["logs"])
