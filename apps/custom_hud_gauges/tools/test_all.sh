#!/bin/sh
# Every desk test. Run from anywhere.
set -e
cd "$(dirname "$0")/.."
node tools/check_package.js
node tools/test_render.js
node tools/test_controller.js
node tools/test_source.js
node tools/test_settings.js
node tools/test_page.js
node tools/test_page.js --resume
