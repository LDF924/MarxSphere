import sys
key = sys.argv[1]
endpoint = sys.argv[2]
model = "doubao-seed-1-6-lite-250815"

with open(r"%USERPROFILE%\import_graphiti.py", "r", encoding="utf-8") as f:
    content = f.read()

# Replace API_KEY
content = content.replace(
    'API_KEY = "sk-ws-H.RYLILHY.lsJi.MEYCIQDHgQnlt7xN53O3psWWPAy3Z-sVwXXXZmdpVDqoqmU09gIhAPv1t66dBPALsszjMrTCASZmVd75mSptGZVeYqPfUVmO"',
    f'API_KEY = "{key}"'
)

# Replace BASE_URL
content = content.replace(
    'BASE_URL = "https://ws-4cbe4oorrmbrzdya.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"',
    f'BASE_URL = "{endpoint}"'
)

# Replace model name
content = content.replace('model="qwen3.7-max"', f'model="{model}"')
content = content.replace('small_model="qwen3.7-max"', f'small_model="{model}"')
content = content.replace('embedding_model="text-embedding-v4"', 'embedding_model="doubao-embedding"')

with open(r"%USERPROFILE%\import_graphiti.py", "w", encoding="utf-8") as f:
    f.write(content)

print("Config updated.")
