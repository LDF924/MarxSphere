import sys,io; sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding='utf-8')
from openai import AsyncOpenAI
import asyncio

client = AsyncOpenAI(
    api_key='sk-ws-H.RYRRIEP.c27n.MEQCIH9Blb-_G38pAxOmXN9aOGSyyc_EjejYiztcv1di2feQAiB3d4VNAhBro7ts94OR5HD9biDhseby4C8YIeOdhjXWvw',
    base_url='https://ws-of9v7c4da1zhezwm.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'
)

async def test():
    r = await client.chat.completions.create(model='qwen3.7-max', messages=[{'role':'user','content':'hi'}], max_tokens=10)
    print('OK:', r.choices[0].message.content)

asyncio.run(test())
