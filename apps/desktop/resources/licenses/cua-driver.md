# Cua Driver and its Node runtime

Pi Bot bundles the following unmodified files to operate apps on this computer.

| Files | License | Source |
|---|---|---|
| `Contents/Resources/cua-driver` 0.38.0 (macOS daemon, re-signed with the application) | MIT | https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.38.0 |
| `@trycua/cua-driver` 0.38.0 (JavaScript) and `@trycua/cua-driver-<platform>` 0.38.0 `libcua_driver_sdk.{dylib,so,dll}` | MIT | https://github.com/trycua/cua (release tag of Cua Driver 0.38.0, directory `libs/cua-driver`) |
| `@trycua/cua-driver-<platform>` 0.38.0 `cua_driver_node_runtime.node` | MPL-2.0 | Derived from the N-API runtime of uniffi-bindgen-react-native 0.31.0-3 by `scripts/build-node-runtime.mjs` in the Cua repository at the same tag; upstream https://github.com/jhugman/uniffi-bindgen-react-native |
| `@ubjs/core` 0.31.0-3, `@ubjs/node` 0.31.0-3, `@ubjs/node-<platform>` 0.31.0-3 | MPL-2.0 | https://github.com/jhugman/uniffi-bindgen-react-native (`runtimes/napi`), npm packages of the same version |

The MPL-2.0 files are distributed unmodified; their source code is available at the
locations above. The full text of the Mozilla Public License 2.0 is in `MPL-2.0.txt` next to
this file. MPL-2.0 applies to those files only, not to the rest of Pi Bot.

The Cua native library contains third-party Rust crates and other components under their own
permissive licenses (MIT, Apache-2.0 and similar); see `libs/cua-driver/rust/THIRD_PARTY_NOTICES.md`
in the Cua repository at the tag above. Pi Bot does not download or enable Cua's optional
visual-recognition extension.

## MIT License (Cua Driver)

Copyright (c) Cua AI, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
