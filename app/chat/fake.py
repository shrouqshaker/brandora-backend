"""Offline Gemini stand-in using the real client's parsing/retry infrastructure."""
import json

from ..providers.gemini import GeminiClient


class DemoGemini(GeminiClient):
    async def _generate(self, model, system, user, *, schema, temperature, mime):
        payload = json.loads(user)
        if schema.__name__ == "Meaning":
            return json.dumps(payload["rulesHint"], ensure_ascii=False)
        if schema.__name__ == "NaturalReply":
            return json.dumps({"sentences":[{"fact_ids":[f["id"] for f in payload["facts"]],"join":"and"}],
                               "warmth":"friendly","question_style":"gentle"})
        return json.dumps({"tone": "friendly", "acts": [
            {"fact_id": a["fact_id"], "phrase": 1} for a in payload["acts"]]}, ensure_ascii=False)
