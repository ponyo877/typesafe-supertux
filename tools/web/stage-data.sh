#!/bin/sh
#  SuperTux
#  Copyright (C) 2026 ponyo877
#
#  This program is free software: you can redistribute it and/or modify
#  it under the terms of the GNU General Public License as published by
#  the Free Software Foundation, either version 3 of the License, or
#  (at your option) any later version.
#
#  This program is distributed in the hope that it will be useful,
#  but WITHOUT ANY WARRANTY; without even the implied warranty of
#  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#  GNU General Public License for more details.
#
#  You should have received a copy of the GNU General Public License
#  along with this program.  If not, see <http://www.gnu.org/licenses/>.

# Copies the game data into the build directory, where the link step packs it
# into supertux2.data:
#
#   tools/web/stage-data.sh [build dir]
#
# Content under a non-commercial license (CC BY-NC 4.0, see data/AUTHORS) is
# left out, so that the web build can be shared without that restriction:
# the conveyor belt images (Shallow Green has no conveyor belts) and the
# death sound, which is replaced by the hurt sound.

set -e

repo=$(cd "$(dirname "$0")/../.." && pwd)
build=${1:-$repo/build.wasm}

rsync -a --delete --delete-excluded \
  --exclude 'images/objects/conveyor_belt/' \
  --exclude 'sounds/kill.wav' \
  "$repo/data/" "$build/data/"
cp "$repo/data/sounds/hurt.wav" "$build/data/sounds/kill.wav"

echo "Staged $repo/data in $build/data (without CC BY-NC content)"
