# Repository Guidelines

## Project Structure & Module Organization

This repository is a Chrome Manifest V3 extension for extracting content from WeChat Read pages.

- `manifest.json` defines permissions, content scripts, popup, icons, and service worker.
- `src/background/` contains the service worker and message relay logic.
- `src/content/` contains extraction strategy, floating panel UI, and content styles.
- `src/popup/` contains the browser action popup HTML, CSS, and JavaScript.
- `src/icons/` stores extension icons and icon-generation helper HTML.
- `tests/` is reserved for automated tests.

## Build, Test, and Development Commands

There is no package manager setup or build step; the extension runs directly from source.

- Load locally: open `chrome://extensions/`, enable Developer Mode, choose "Load unpacked", and select this repository root.
- Manual smoke test: open `https://weread.qq.com/web/reader/*`, verify the floating button, then test chapter extraction, visible extraction, format switching, and clipboard copy.
- Package manually only when needed, and do not commit generated `.crx`, `.pem`, or `.zip` files.

## Coding Style & Naming Conventions

- Use plain JavaScript, HTML, and CSS consistent with the existing files.
- Use two-space indentation, semicolons, `camelCase` for variables/functions, and `PascalCase` for classes.
- Keep modules focused: extraction in `src/content/extractor.js`, page UI in `src/content/content.js`, popup logic in `src/popup/popup.js`.
- Prefer readable Chinese comments when comments add useful context.
- Avoid relative import patterns unless a future module system is introduced.

## Testing Guidelines

- Use Pytest for future automated tests, placing test files under `tests/`.
- Name tests by behavior, for example `tests/content/test_extract_visible.py`.
- Cover success paths, fallback extraction strategies, empty content, canvas-mode warnings, format conversion, and clipboard failure fallback.
- Until automated browser tests exist, include manual Chrome verification notes in each pull request.

## Commit & Pull Request Guidelines

Git history uses concise conventional-style summaries such as `feat: initial MVP of Weread Extract Chrome extension`.

- Prefer commit messages in the form `feat(scope): summary`, `fix(scope): summary`, `docs(scope): summary`, or `test(scope): summary`.
- Keep each commit focused on one file or one tightly related change.
- Pull requests should include a short description, affected files, manual test steps, screenshots or screen recordings for UI changes, and linked issues when available.

## Security & Configuration Tips

- Keep permissions in `manifest.json` minimal and explain any new host permission.
- Do not commit private keys, packed extension artifacts, browser profiles, or copied book content.
