# MinerU Cloud SDK API 参考

## 安装

```bash
pip install "mineru-open-sdk>=0.2.5"
```

## Token 获取

1. 访问 https://mineru.net/apiManage/token
2. 注册/登录（支持 GitHub、微信）
3. 复制 token 填入 config.env 的 `MINERU_TOKEN`

## API 模式

### flash 模式（免费，无需 token）

- 限制：每文件 ≤10MB 且 ≤20 页
- 不返回图片（仅 Markdown 文本）
- 适合小文件快速预览

### precision 模式（需 token，免费额度 1000 页/天）

- 完整解析，含图片、表格、公式
- 大文件支持（最大 600 页）
- 返回 `ExtractResult` 含 `.markdown` + `.images`

## Python API

```python
from mineru import MinerU

# precision 模式（推荐）
client = MinerU(token="your-token")
result = client.extract("paper.pdf", formula=True, table=True, language="ch", timeout=600)

# flash 模式（免费）
client = MinerU()
result = client.flash_extract("paper.pdf", language="ch", enable_formula=True, enable_table=True)

# 访问结果
print(result.markdown)       # Markdown 文本
print(result.images)         # list[Image]，每个有 .name / .data
print(result.state)          # "done" | "failed" | "pending"
```

## ExtractResult 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `task_id` | str | 任务 ID |
| `state` | str | done / failed / pending / running |
| `markdown` | str? | Markdown 正文（不含 YAML frontmatter） |
| `images` | list[Image] | 提取的图片列表 |
| `Image.name` | str | 图片文件名（如 `abc123.jpg`） |
| `Image.data` | bytes | 图片二进制数据 |

## 注意事项

- flash 模式的 Markdown 输出与 precision 模式相同，但不含图片
- Markdown 中的图片引用格式：`![](images/xxx.jpg)`
- 每日 precision 额度约 1000 页，超出后返回 429
- CPU 推理下 precision 模式每页约 2-5 分钟，服务端 GPU 加速后约 15-30 秒
