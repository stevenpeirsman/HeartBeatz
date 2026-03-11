#!/usr/bin/env bash
# ======================================================================
#  ESP32 Firmware Build Script
#
#  Automates the Docker-based build for different ESP32 targets.
#
#  Usage:
#    ./build.sh [target]
#
#  Targets:
#    esp32s3    (Default)
#    esp32c3
#    esp32c6
# ======================================================================

set -euo pipefail

TARGET="${1:-esp32s3}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

case "${TARGET}" in
    esp32s3|esp32c3|esp32c6)
        echo "Building for target: ${TARGET}"
        ;;
    *)
        echo "Error: Invalid target '${TARGET}'"
        echo "Supported targets: esp32s3, esp32c3, esp32c6"
        exit 1
        ;;
esac

# 1. Prepare sdkconfig.defaults
CONFIG_FILE="sdkconfig.defaults.${TARGET}"
if [ ! -f "${SCRIPT_DIR}/${CONFIG_FILE}" ]; then
    echo "Error: Configuration file '${CONFIG_FILE}' not found."
    exit 1
fi

echo "Setting up sdkconfig.defaults from ${CONFIG_FILE}..."
cp "${SCRIPT_DIR}/${CONFIG_FILE}" "${SCRIPT_DIR}/sdkconfig.defaults"

# 2. Run Docker build
echo "Starting Docker build (espressif/idf:v5.2)..."
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "${REPO_ROOT}:/project" \
  -w "/project/firmware/esp32-csi-node" \
  espressif/idf:v5.2 bash -c \
  "rm -rf build sdkconfig && idf.py set-target ${TARGET} && idf.py reconfigure && idf.py build"

echo ""
echo "Build complete! Artifacts are in: firmware/esp32-csi-node/build/"
echo "Binaries: esp32-csi-node.bin, bootloader/bootloader.bin, partition_table/partition-table.bin"
