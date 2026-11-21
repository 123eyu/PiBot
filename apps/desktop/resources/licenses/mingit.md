# MinGit (Git for Windows), Windows builds only

The Windows installer of Pi Bot bundles MinGit, the minimal distribution of Git for Windows, so
that Git is available on computers that have none. Pi Bot runs it as a separate program and uses
it only when no Git is installed on the computer. It ships as the official release zip; the first
time Git is needed, Pi Bot checks the zip's SHA-256 and unpacks it, unchanged, into
`%LOCALAPPDATA%\Pi Bot\runtimes\mingit\`.

| Files | Version | License | Source |
|---|---|---|---|
| `resources/bin/mingit/` (MinGit-2.56.1-64-bit.zip on x64, MinGit-2.56.1-arm64.zip on arm64) | Git for Windows 2.56.1 (`v2.56.1.windows.1`) | GNU General Public License, version 2 (Git), plus the licenses of the bundled components | https://github.com/git-for-windows/git/releases/tag/v2.56.1.windows.1 |

MinGit is distributed unmodified, exactly as published in the release above (SHA-256
`4a92850b6e917da4fd010669b614b55dccf5b0ec333a534cc4be4700dfefdafd` for x64,
`96571e442e90523a90e5fd8661b4c4e43bc192910f3c6db938816e6955b4cc8c` for arm64).

The complete license texts, including the GNU General Public License version 2 and the licenses
of every component MinGit contains, are in `resources/bin/mingit/LICENSE.txt` of the installed
application (and `LICENSE.txt` inside the zip and the unpacked copy).

Corresponding source code:

- Git for Windows: https://github.com/git-for-windows/git/tree/v2.56.1.windows.1 (source
  archives are attached to the release page above).
- The runtime packages MinGit is assembled from (MSYS2 / MINGW packages and their build recipes):
  https://github.com/git-for-windows/MINGW-packages, https://github.com/git-for-windows/MSYS2-packages
  and https://github.com/git-for-windows/build-extra (`mingit/`).

The GPL applies to MinGit only, not to the rest of Pi Bot, which runs it as a separate program.
