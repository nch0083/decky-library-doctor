# Library Doctor

Decky Loader plugin for cleaning and maintaining non-Steam shortcuts on Steam Deck.

## Current version

**v0.18.0 · by nach**

## Features

- Find broken non-Steam shortcuts.
- Distinguish missing executables from offline storage.
- Detect duplicate shortcuts and delete multiple selected duplicates.
- Scan configured folders recursively for unregistered `.exe` files.
- Mark non-game executables as **Not a game**.
- Add discovered executables to Steam with a configurable default Proton tool.
- Show SSD / SD storage badges for executable paths.
- Review games from a selected Steam collection before deleting both the game folder and non-Steam shortcut.
- Adjust inferred delete paths wider or narrower before deletion.
- Back up `shortcuts.vdf` before shortcut deletion.
- Korean, Japanese and English UI localization.
- Scan progress and debug checkpoints for troubleshooting.

## Build

On Steam Deck:

```bash
./build-release.sh
```

The script builds the frontend and creates:

```text
out/LibraryDoctor-v<VERSION>.zip
```

It does **not** install the plugin or restart Decky.

## Automatic GitHub Releases

Push a version tag matching `package.json`, for example:

```bash
git tag v0.18.0
git push origin v0.18.0
```

GitHub Actions will automatically:

1. Install dependencies.
2. Build the plugin.
3. Package the Decky ZIP.
4. Create a GitHub Release.
5. Attach `LibraryDoctor-v0.18.0.zip`.

The tag version must match the version in `package.json`.

## License

BSD-3-Clause.
