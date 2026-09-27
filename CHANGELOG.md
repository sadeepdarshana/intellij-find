# Changelog

## 0.2.0

- **Replace in Files** (`⇧⌘R`): replace mode of the Find in Files popup with per-row previews, inline editor preview, replace selected (`⌥↵`), Replace All (`⌥A`, confirmed), regex `$1`/`$<name>` replacements, stale-match protection and single-step undo.
- *Replace in Files…* in the Explorer, editor tab and editor right-click menus.
- Fix: closing and immediately re-opening the popup could close the new popup.
- Internal popup commands no longer appear in the Command Palette.

## 0.1.1

- Screenshots (light and dark) and source repository link on the Marketplace page.
- Scope picker: the workspace root shows as its folder name and is no longer offered as a "parent" directory.

## 0.1.0

- Find in Files popup: live ripgrep results, Match Case / Words / Regex, file mask, scope, exclude toggle, history, pin, editor preview, Open in Search View.
- Go to File popup: IntelliJ-style fragment matching, directory narrowing, `:line:col`, recent files, directories.
- Directory scoping from the Explorer selection (keyboard) and from Explorer / editor tab right-click menus.
