import sys,io; sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding='utf-8')
from openai import AsyncOpenAI
import asyncio

client = AsyncOpenAI(
    api_key='',
    base_url='https://ws-of9v7c4da1zhezwm.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
)

async def test():
    r = await client.chat.completions.create(model='qwen3.7-max', messages=[{'role':'user','content':'hi'}], max_tokens=10)
    print('OK:', r.choices[0].message.content)

asyncio.run(test())
