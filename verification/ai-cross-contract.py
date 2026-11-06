import sys, json, asyncio, os
from pathlib import Path
from uuid import UUID

repo = Path(os.environ['BRANDORA_AI_SOURCE']).resolve()
sys.path.insert(0, str(repo))
from app.http import create_app
from app.config import Settings
from app.schemas.backend import (
    Product, AuthorizedHistoryPage, ExpectedScope, RetrievalOutcome,
    RetrievalStatus, ToolEnvelope,
)
from app.data.history import HistoryService
from fastapi.testclient import TestClient
import httpx

p = json.load(sys.stdin)
Product.model_validate(p['product'])
calls = []

def backend(request):
    wire = json.loads(request.content)
    name, args = wire['tool'], wire['arguments']
    calls.append(name)
    page = {'limit': args.get('limit', 20), 'offset': args.get('offset', 0),
            'totalCount': 1, 'hasMore': False, 'nextOffset': None}
    if name == 'get_products':
        data = {'items': [p['product']], 'pagination': page}
    elif name == 'get_product_details':
        data = p['product']
    elif name == 'get_product_variants':
        data = {'items': p['product']['variants'], 'pagination': page}
    elif name == 'get_variant_details':
        data = p['product']['variants'][0]
    else:
        raise AssertionError('Unexpected tool')
    return httpx.Response(200, json={'tool': name, 'data': data})

settings = Settings(
    ai_provider='rules', legacy_api_enabled=False, ai_integration_enabled=True,
    app_env='local', ai_service_token=p['outbound'], backend_service_token=p['inbound'],
    backend_base_url='http://127.0.0.1:3000', backend_context_public_key=p['public'],
)
client = TestClient(create_app(settings, products_transport=httpx.MockTransport(backend)))
headers = {'Content-Type': 'application/json',
           'X-Internal-Token': p['outbound'], 'X-AI-Context': p['token']}
response = client.post('/v2/ai/respond', content=p['body'].encode(), headers=headers)
assert response.status_code == 200, response.status_code
assert client.post('/v2/ai/respond', content=(p['body']+' ').encode(),
                   headers=headers).status_code == 403
assert client.post('/v2/ai/respond', content=p['body'].encode(),
                   headers={**headers, 'X-Internal-Token': p['inbound']}).status_code == 401

class HistoryData:
    async def get_conversation_history(self, *args, **kwargs):
        return RetrievalOutcome(
            status=RetrievalStatus.AVAILABLE,
            envelope=ToolEnvelope[AuthorizedHistoryPage](
                tool='get_conversation_history',
                data=AuthorizedHistoryPage.model_validate(p['history'])))

scope = ExpectedScope(business_id=p['ids']['businessId'],
                      customer_id=p['ids']['customerId'],
                      conversation_id=p['ids']['conversationId'])
hist = asyncio.run(HistoryService(HistoryData()).prepare_authorized(
    UUID(p['ids']['messageId']), scope=scope, context_token=p['token']))
assert hist.coverage.value == 'complete'
from copy import deepcopy
from pydantic import ValidationError
original = deepcopy(p['history'])
p['history']['items'][0]['createdAt'] = p['history']['beforeMessageCreatedAt']
same_time = asyncio.run(HistoryService(HistoryData()).prepare_authorized(
    UUID(p['ids']['messageId']), scope=scope, context_token=p['token']))
assert same_time.coverage.value == 'partial'
p['history'] = deepcopy(original)
p['history']['items'].append({**p['history']['items'][0], 'id': '30000000-0000-4000-8000-000000000001'})
p['history']['pagination']['totalCount'] = 2
ties = asyncio.run(HistoryService(HistoryData()).prepare_authorized(
    UUID(p['ids']['messageId']), scope=scope, context_token=p['token']))
assert ties.coverage.value == 'partial'
p['history'] = deepcopy(original)
p['history']['items'][0]['content'] = '\U0001f600' * 2000
AuthorizedHistoryPage.model_validate(p['history'])
p['history']['items'][0]['content'] += '\U0001f600'
try:
    AuthorizedHistoryPage.model_validate(p['history'])
    raise AssertionError('Oversized history unexpectedly accepted')
except ValidationError:
    pass
loaded = [Path(mod.__file__).resolve() for name, mod in sys.modules.items()
          if (name == 'app' or name.startswith('app.')) and getattr(mod, '__file__', None)]
assert loaded and all(f.is_relative_to(repo) for f in loaded)
print(json.dumps({'response': response.json(), 'calls': calls,
                  'coverage': hist.coverage.value, 'issues': hist.issues}))
