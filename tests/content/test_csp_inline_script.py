import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def read_repo_file(path):
    return (ROOT / path).read_text(encoding="utf-8")


def test_canvas_hook_runs_in_main_world():
    manifest = json.loads(read_repo_file("manifest.json"))
    entries = [
        entry
        for entry in manifest["content_scripts"]
        if "src/content/canvas-hook.js" in entry.get("js", [])
    ]

    assert entries, "manifest.json 必须注册 canvas-hook.js"
    assert entries[0].get("run_at") == "document_start"
    assert entries[0].get("world") == "MAIN"


def test_content_scripts_do_not_inject_inline_scripts():
    for path in ["src/content/canvas-hook.js", "src/content/extractor.js"]:
        source = read_repo_file(path)

        assert "script.textContent" not in source
        assert "createElement('script')" not in source
        assert 'createElement("script")' not in source


def test_page_data_uses_post_message_bridge():
    extractor_source = read_repo_file("src/content/extractor.js")
    hook_source = read_repo_file("src/content/canvas-hook.js")

    assert "WEREAD_REQ_STATE" in extractor_source
    assert "WEREAD_STATE" in extractor_source
    assert "WEREAD_REQ_STATE" in hook_source
    assert "window.__INITIAL_STATE__" in hook_source
