#!/bin/bash
# Benchmark: How fast can git traverse commits?

set -e

COMMIT_COUNT=${1:-100000}
TEMP_DIR=$(mktemp -d)
cd "$TEMP_DIR"

echo "=== Git Traversal Benchmark ==="
echo "Target: $COMMIT_COUNT commits"
echo "Temp dir: $TEMP_DIR"
echo ""

# Initialize repo
git init -q
git config user.email "bench@test.com"
git config user.name "Benchmark"

echo "Creating $COMMIT_COUNT commits via fast-import..."

START_CREATE=$(date +%s.%N)

# Generate fast-import stream with Python (faster than bash loops)
python3 << PYEOF | git fast-import --quiet
import sys

count = $COMMIT_COUNT
prev_mark = None

for i in range(1, count + 1):
    mark = i

    # Every 10000th commit is a "release"
    if i % 10000 == 0:
        version = f"{i // 10000}.0.0"
        content = f'{{"version": "{version}"}}'
        msg = f"chore: release v{version}"

        # Blob for versions.json
        print(f"blob")
        print(f"mark :{mark * 2}")
        print(f"data {len(content)}")
        print(content)

        # Commit
        print(f"commit refs/heads/main")
        print(f"mark :{mark * 2 + 1}")
        print(f"committer Bench <bench@test.com> {1700000000 + i} +0000")
        print(f"data {len(msg)}")
        print(msg)
        if prev_mark:
            print(f"from :{prev_mark}")
        print(f"M 100644 :{mark * 2} .pls/versions.json")
        prev_mark = mark * 2 + 1
    else:
        msg = "feat: regular commit"
        print(f"commit refs/heads/main")
        print(f"mark :{mark * 2 + 1}")
        print(f"committer Bench <bench@test.com> {1700000000 + i} +0000")
        print(f"data {len(msg)}")
        print(msg)
        if prev_mark:
            print(f"from :{prev_mark}")
        prev_mark = mark * 2 + 1

    if i % 50000 == 0:
        print(f"  ... {i} commits", file=sys.stderr)

print("done")
PYEOF

git checkout -q main

END_CREATE=$(date +%s.%N)
CREATE_TIME=$(echo "$END_CREATE - $START_CREATE" | bc)

echo ""
echo "Created $COMMIT_COUNT commits in ${CREATE_TIME}s"
echo ""

# Verify
ACTUAL=$(git rev-list --count HEAD)
echo "Verified: $ACTUAL commits in repo"
echo ""

# Now benchmark traversals
echo "=== Traversal Benchmarks ==="
echo ""

# 1. Count all commits
echo "1. Count all commits (git rev-list --count)"
time git rev-list --count HEAD
echo ""

# 2. Full log traversal
echo "2. Full log traversal (git log --oneline | wc -l)"
time git log --oneline | wc -l
echo ""

# 3. Search for specific string in commit messages
echo "3. Search commits by message (git log --grep 'release v5.0.0')"
time git log --oneline --grep="release v5.0.0" | head -5
echo ""

# 4. Search for string change in file (git log -S) - THE ACTUAL USE CASE
echo "4. Search for version in file (git log -S '5.0.0') - OUR USE CASE"
time git log -S "5.0.0" --format="%H %s" -- .pls/versions.json | head -1
echo ""

# 5. With limit
echo "5. Same search with -n 5000 limit"
time git log -S "5.0.0" --format="%H" -n 5000 -- .pls/versions.json | head -1
echo ""

# Cleanup
echo "=== Cleanup ==="
rm -rf "$TEMP_DIR"
echo "Done. Temp dir removed."
