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


def test_chapter_extraction_requests_full_chapter_bridge():
    given_source = read_repo_file("src/content/extractor.js")
    when_body = method_body(given_source, "async extractChapter")

    assert "_extractFullChapterContent" in when_body
    assert "WEREAD_REQ_CHAPTER_CONTENT" in given_source
    assert "_extractFromCanvas" not in when_body
    assert "_extractFromDOM" not in when_body
    assert "_extractFromPreElements" not in when_body
    assert "_extractVisibleText" not in when_body


def test_visible_extraction_is_canvas_scoped():
    given_source = read_repo_file("src/content/extractor.js")
    when_body = method_body(given_source, "async extractVisible")

    assert "_extractSelection" in when_body
    assert "_extractFromCanvas" in when_body
    assert "_extractFullChapterContent" not in when_body
    assert "_extractVisibleText" not in when_body


def test_main_world_bridge_provides_full_chapter_content():
    given_source = read_repo_file("src/content/canvas-hook.js")

    assert "WEREAD_REQ_CHAPTER_CONTENT" in given_source
    assert "WEREAD_CHAPTER_CONTENT" in given_source
    assert "chapterContentForEPub" in given_source
    assert "chapterResponseCache" in given_source
    assert "installNetworkHook" in given_source
