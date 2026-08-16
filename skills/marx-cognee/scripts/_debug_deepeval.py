import sys, os, re
sys.path.insert(0, r"%USERPROFILE%\cognee")
os.chdir(r"%USERPROFILE%\cognee")
os.environ["DEEPEVAL_HOME"] = r"%USERPROFILE%\cognee\.deepeval"
os.environ["NLTK_DATA"] = r"%USERPROFILE%\cognee\.venv312\nltk_data"
os.makedirs(r"%USERPROFILE%\cognee\.deepeval", exist_ok=True)
import dotenv; dotenv.load_dotenv(dotenv_path=r"%USERPROFILE%\cognee\.env", override=True)
KEY = os.getenv("LLM_API_KEY","")
print("KEY:", bool(KEY), flush=True)

# Monkey-patch trimAndLoadJson to print what it receives
import deepeval.metrics.utils as dm_utils
_orig_trim = dm_utils.trimAndLoadJson
def _debug_trim(input_string, metric=None):
    snippet = (input_string[:300] if input_string else "NONE")
    print("trimAndLoadJson input:", repr(snippet), flush=True)
    try:
        return _orig_trim(input_string, metric)
    except ValueError as e:
        print("trimAndLoadJson FAILED on:", repr(input_string[:500] if input_string else "NONE"), flush=True)
        raise
dm_utils.trimAndLoadJson = _debug_trim

from deepeval.models.base_model import DeepEvalBaseLLM
from deepeval.metrics import FaithfulnessMetric
from deepeval.test_case import LLMTestCase

class CleanJudge(DeepEvalBaseLLM):
    def __init__(self):
        self.model_name = "qwen3.7-max"
    def load_model(self):
        return "litellm"
    def generate(self, *args, **kwargs):
        import litellm
        prompt = args[0] if args else ""
        resp = litellm.completion(
            model="openai/qwen3.7-max",
            messages=[{"role":"user","content":prompt}],
            api_base="https://dashscope.aliyuncs.com/compatible-mode/v1",
            api_key=KEY, n=1, temperature=0, max_tokens=1024, timeout=120
        )
        raw = resp.choices[0].message.content or ""
        cleaned = raw.strip()
        if cleaned.startswith("`"):
            cleaned = re.sub(r"^```(?:json)?\s*\n?", "", cleaned)
            cleaned = re.sub(r"\n?```\s*$", "", cleaned)
        s = cleaned.find("{")
        e = cleaned.rfind("}")
        if s != -1 and e != -1 and e > s:
            cleaned = cleaned[s:e+1]
        print("generate returning:", cleaned[:200], flush=True)
        return cleaned
    async def a_generate(self, *args, **kwargs):
        return self.generate(*args, **kwargs)
    def get_model_name(self):
        return self.model_name

judge = CleanJudge()
tc = LLMTestCase(
    input="什么是资本?",
    actual_output="资本是投入再生产的财富",
    retrieval_context=["资本指用于再生产的财富积累"],
    expected_output="资本是用于再生产和价值增值的财富"
)
fm = FaithfulnessMetric(threshold=0.5, include_reason=False, model=judge)
try:
    fm.measure(tc)
    print("Score:", fm.score, flush=True)
except Exception as e:
    print("ERROR:", e, flush=True)
