# ==============================================================================
# HeartBeatz Sensor Node — Top-level CMakeLists.txt
# ==============================================================================
# This is the ESP-IDF project root. PlatformIO uses this automatically
# when framework = espidf is set in platformio.ini.
#
# The actual source files are in the main/ component directory.

cmake_minimum_required(VERSION 3.16)

# Include the ESP-IDF CMake build system
include($ENV{IDF_PATH}/tools/cmake/project.cmake)

project(heartbeatz-node)
