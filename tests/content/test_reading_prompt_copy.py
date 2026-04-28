from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read_repo_file(path):
    return (ROOT / path).read_text(encoding="utf-8")


def method_body(source, signature):
    start = source.index(signature)
    brace_start = source.index("{", start)
    depth = 0

    for index in range(brace_start, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[brace_start + 1:index]

    raise AssertionError(f"找不到方法体: {signature}")


def test_extractor_builds_reading_prompt_copy_content():
    given_source = read_repo_file("src/content/extractor.js")
    chapter_body = method_body(given_source, "async extractChapter")
    visible_body = method_body(given_source, "async extractVisible")

    assert "_buildReadingPrompt(markdownContent)" in given_source
    assert "你是一个严谨、有洞察力、善于联想的读书伙伴" in given_source
    assert "## 4. 我可能忽略的东西" in given_source
    assert "## 5. 向外联想" in given_source
    assert "--- 章节开始 ---" in given_source
    assert "--- 章节结束 ---" in given_source
    assert "const singlePrompt = [" in given_source
    assert "return [singlePrompt, singlePrompt].join('\\n\\n');" in given_source
    assert given_source.count("markdownContent,") == 1
    assert "完整原文副本" not in given_source
    assert "copyContent: this._buildReadingPrompt(formatted)" in chapter_body
    assert "copyContent: this._buildReadingPrompt(formatted)" in visible_body


def test_page_panel_copies_prompt_wrapped_content():
    given_source = read_repo_file("src/content/content.js")

    assert "function getCopyContent(result)" in given_source
    assert "result?.copyContent || result?.content || ''" in given_source
    assert "const copyContent = getCopyContent(lastResult)" in given_source
    assert "navigator.clipboard.writeText(copyContent)" in given_source
    assert "fallbackCopy(copyContent)" in given_source
    assert "navigator.clipboard.writeText(lastResult.content)" not in given_source
    assert "fallbackCopy(lastResult.content)" not in given_source


def test_popup_copies_prompt_wrapped_content():
    given_source = read_repo_file("src/popup/popup.js")

    assert "function getCopyContent(result)" in given_source
    assert "result?.copyContent || result?.content || ''" in given_source
    assert "const copyContent = getCopyContent(currentResult)" in given_source
    assert "navigator.clipboard.writeText(copyContent)" in given_source
    assert "textarea.value = copyContent" in given_source
    assert "navigator.clipboard.writeText(currentResult.content)" not in given_source
    assert "textarea.value = currentResult.content" not in given_source
