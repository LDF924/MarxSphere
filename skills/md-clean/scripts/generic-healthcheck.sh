#!/usr/bin/env bash
# 通用健康检查（自动生成）：验证 SKILL.md 存在且 frontmatter 完整
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -f "$SKILL_DIR/SKILL.md" ]; then
  echo "状态: FAIL - SKILL.md 缺失"
  exit 1
fi
if ! head -1 "$SKILL_DIR/SKILL.md" | grep -q "^---"; then
  echo "状态: FAIL - frontmatter 缺失"
  exit 1
fi
if ! grep -q "^name:" "$SKILL_DIR/SKILL.md"; then
  echo "状态: FAIL - name 字段缺失"
  exit 1
fi
NAME=$(grep -m1 "^name:" "$SKILL_DIR/SKILL.md" | sed 's/name: *//; s/"//g')
echo "状态: OK - skill $NAME 就绪 (SKILL.md 完整)"
exit 0
