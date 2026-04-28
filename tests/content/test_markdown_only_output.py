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


def test_content_panel_has_no_format_selector():
    given_source = read_repo_file("src/content/content.js")
    given_styles = read_repo_file("src/content/content.css")

    assert "we-format-group" not in given_source
    assert "we-fmt-btn" not in given_source
    assert "wereadExtractFormat" not in given_source
    assert "preferredFormat" not in given_source
    assert "data-format" not in given_source
    assert "we-format-group" not in given_styles
    assert "we-format-btns" not in given_styles
    assert "we-fmt-btn" not in given_styles


def test_popup_has_no_format_selector():
    given_html = read_repo_file("src/popup/popup.html")
    given_script = read_repo_file("src/popup/popup.js")
    given_styles = read_repo_file("src/popup/popup.css")

    assert "format-group" not in given_html
    assert "fmt-btn" not in given_html
    assert "data-format" not in given_html
    assert "输出格式" not in given_html
    assert "selectedFormat" not in given_script
    assert "wereadExtractFormat" not in given_script
    assert "updateFormatButtons" not in given_script
    assert "reformat" not in given_script
    assert "format:" not in given_script
    assert ".format-group" not in given_styles
    assert ".format-btns" not in given_styles
    assert ".fmt-btn" not in given_styles


def test_extractor_always_formats_markdown():
    given_source = read_repo_file("src/content/extractor.js")
    chapter_body = method_body(given_source, "async extractChapter")
    visible_body = method_body(given_source, "async extractVisible")

    assert "async extractChapter()" in given_source
    assert "async extractVisible()" in given_source
    assert "_toMarkdown(content, meta)" in chapter_body
    assert "_toMarkdown(content, meta)" in visible_body
    assert "_format(" not in given_source
    assert "_toHTML" not in given_source
    assert "_toPlainText" not in given_source


def test_messages_and_defaults_do_not_carry_format():
    given_content = read_repo_file("src/content/content.js")
    given_popup = read_repo_file("src/popup/popup.js")
    given_background = read_repo_file("src/background/service-worker.js")

    assert "msg.format" not in given_content
    assert "format:" not in given_popup
    assert "wereadExtractFormat" not in given_background


def test_manifest_describes_markdown_only_output():
    given_manifest = read_repo_file("manifest.json")

    assert "Markdown" in given_manifest
    assert "纯文本" not in given_manifest
    assert "HTML 格式输出" not in given_manifest
