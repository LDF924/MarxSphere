import os, re, time
os.environ["DEEPEVAL_HOME"] = r"%USERPROFILE%\cognee\.deepeval"
os.makedirs(r"%USERPROFILE%\cognee\.deepeval", exist_ok=True)
os.chdir(r"%USERPROFILE%\cognee")
import dotenv; dotenv.load_dotenv(dotenv_path=r"%USERPROFILE%\cognee\.env", override=True)
KEY = os.getenv("LLM_API_KEY", "")
ENDPOINT = "https://dashscope.aliyuncs.com/compatible-mode/v1"
import json, litellm
from deepeval.models.base_model import DeepEvalBaseLLM
from deepeval.metrics import FaithfulnessMetric
from deepeval.test_case import LLMTestCase

cache = json.load(open(r"D:\Desktop\执行流程\eval_output\answers_cache_v2.json", encoding="utf-8"))
s = cache["graphiti"][0]

class QJ(DeepEvalBaseLLM):
    def __init__(self):
        self.model_name = "qwen3.7-max"
        self.model = litellm

    def load_model(self):
        return litellm

    def generate(self, prompt):
        fixed = prompt + "\nOutput only pure JSON, no ```markdown, no extra words."
        print(f"  generate: prompt len={len(fixed)}", flush=True)
        t0 = time.time()
        resp = self.model.completion(
            model="openai/qwen3.7-max",
            messages=[{"role": "user", "content": fixed}],
            api_base=ENDPOINT,
            api_key=KEY,
            n=1, temperature=0, max_tokens=1024, timeout=120,
        )
        print(f"  litellm done in {time.time()-t0:.1f}s", flush=True)
        raw = resp.choices[0].message.content or ""
        print(f"  raw[:200]={raw[:200]}", flush=True)
        match = re.search(r"\{.*\}", raw, re.DOTALL)
        result = match.group(0) if match else raw.strip()
        print(f"  result len={len(result)}", flush=True)
        return result

    async def a_generate(self, p):
        return self.generate(p)

    def get_model_name(self):
        return self.model_name

judge = QJ()
fm = FaithfulnessMetric(threshold=0.5, include_reason=False, model=judge)
tc = LLMTestCase(
    input=s["question"],
    actual_output=s["answer"],
    retrieval_context=[str(c)[:2000] for c in (s.get("contexts") or [])],
    expected_output=s.get("ground_truth", ""),
)
print("calling measure...", flush=True)
t0 = time.time()
fm.measure(tc)
print(f"DONE in {time.time()-t0:.1f}s, score={fm.score}", flush=True)
