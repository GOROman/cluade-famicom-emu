#!/bin/bash
# Build the C++ NES core to WebAssembly (output: web/nes.js + web/nes.wasm)
set -e
cd "$(dirname "$0")"

# Homebrew emscripten needs these on this machine (system python is 3.9, config points at wrong LLVM)
if [ -x /opt/homebrew/bin/python3.14 ]; then
  export EMSDK_PYTHON=/opt/homebrew/bin/python3.14
fi
if [ -d /opt/homebrew/opt/emscripten/libexec/llvm/bin ]; then
  export EM_LLVM_ROOT=/opt/homebrew/opt/emscripten/libexec/llvm/bin
  export EM_BINARYEN_ROOT=/opt/homebrew/opt/emscripten/libexec/binaryen
fi

emcc -O3 -std=c++17 \
  core/cpu.cpp core/ppu.cpp core/apu.cpp core/cartridge.cpp core/nes.cpp \
  -o web/nes.js \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=createNesModule \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,HEAPF32 \
  -sENVIRONMENT=web \
  --no-entry

# stamp a fresh version into index.html so browsers never serve stale JS/WASM
VER=$(date +%s)
sed -i '' -E "s/(\\?v=|NES_VER=')[0-9a-zA-Z]+/\\1${VER}/g" web/index.html

echo "Build OK: web/nes.js web/nes.wasm (v=${VER})"
