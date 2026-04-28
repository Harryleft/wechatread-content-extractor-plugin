from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read_repo_file(path):
    return (ROOT / path).read_text(encoding="utf-8")


def test_content_panel_exposes_only_visible_extract_button():
    given_source = read_repo_file("src/content/content.js")

    assert "提取当前章节" not in given_source
    assert "we-extract-chapter" not in given_source
    assert "EXTRACTOR.extractChapter" not in given_source
    assert "we-extract-visible" in given_source
    assert "提取可见内容" in given_source


def test_popup_exposes_only_visible_extract_button():
    given_html = read_repo_file("src/popup/popup.html")
    given_script = read_repo_file("src/popup/popup.js")

    assert "提取当前章节" not in given_html
    assert "btn-extract-chapter" not in given_html
    assert "btnExtractChapter" not in given_script
    assert "EXTRACT_CHAPTER" not in given_script
    assert "btn-extract-visible" in given_html
    assert "EXTRACT_VISIBLE" in given_script


def test_legacy_chapter_message_uses_visible_extraction():
    given_source = read_repo_file("src/content/content.js")
    chapter_branch_start = given_source.index("msg.type === 'EXTRACT_CHAPTER'")
    visible_call_index = given_source.index("EXTRACTOR.extractVisible", chapter_branch_start)
    next_branch_index = given_source.index("msg.type === 'EXTRACT_VISIBLE'", chapter_branch_start)

    assert visible_call_index < next_branch_index
