"""Synthetic six-tool Backend transport. This module cannot make network calls."""
from copy import deepcopy
import json
from uuid import UUID

import httpx

from ..clients.backend_client import BackendClient
from ..data.backend import BackendDataAccess
from ..schemas.backend import ExpectedScope


def identifier(group, number):
    return str(UUID(f"{group:08d}-0000-4000-8000-{number:012d}"))


def page(items, limit=20, offset=0):
    end = offset + limit
    return {"items": deepcopy(items[offset:end]), "pagination": {
        "limit": limit, "offset": offset, "totalCount": len(items),
        "hasMore": end < len(items), "nextOffset": end if end < len(items) else None}}


def catalog(business=1):
    bid, pid = identifier(1, business), identifier(4, business * 10)
    variants = []
    for i, (color, size, price, stock, active) in enumerate([
            ("Black", "M", "250.00", 5, True), ("Black", "L", "275.00", 4, True),
            ("White", "L", "285.00", 8, True), ("White", "M", "225.00", None, True),
            ("Blue", "M", "0.00", 0, True), ("Blue", "L", "205.00", 9, False)]):
        variants.append({"id": identifier(5, business * 100 + i), "businessId": bid,
                         "catalogItemId": pid, "optionValues": {"color": color, "size": size},
                         "unitPrice": price, "effectivePrice": price, "trackInventory": stock is not None,
                         "stockQuantity": stock, "isActive": active})
    primary = {"id": pid, "businessId": bid, "name": "تيشيرت قطن Cotton T-Shirt",
               "description": "Synthetic demonstration product", "basePrice": "200.00",
               "options": {"color": ["Black", "White", "Blue"], "size": ["M", "L"]},
               "attributes": {}, "isActive": True, "isSellable": True,
               "variants": variants, "variantsPagination": page(variants)["pagination"]}
    cap = deepcopy(primary)
    cap.update(id=identifier(4, business * 10 + 1), name="كاب Cap", basePrice=None, options={}, isSellable=False)
    cap["variants"] = [{"id": identifier(5, business * 100 + 10), "businessId": bid,
                        "catalogItemId": cap["id"], "optionValues": {}, "unitPrice": None,
                        "effectivePrice": None, "trackInventory": False, "stockQuantity": None, "isActive": True}]
    cap["variantsPagination"] = page(cap["variants"])["pagination"]
    return [primary, cap]


class SyntheticBackend:
    """Instance-owned mutable fixtures support offline stock-change testing only."""
    def __init__(self):
        self.products = {i: catalog(i) for i in (1, 2)}
        self.calls = []
        self.status_code = None

    def scope(self, business=1, customer=1):
        if business not in (1, 2) or customer not in (1, 2):
            raise ValueError("Choose synthetic business/customer 1 or 2")
        return ExpectedScope(business_id=identifier(1, business), customer_id=identifier(2, customer),
                             conversation_id=identifier(3, business * 10 + customer))

    def data(self):
        return BackendDataAccess(BackendClient("https://synthetic.invalid", "synthetic-service",
                                              transport=httpx.MockTransport(self._handle)))

    def token(self, scope):
        return f"synthetic:{scope.business_id}:{scope.customer_id}:{scope.conversation_id}"

    def _handle(self, request):
        if self.status_code:
            return httpx.Response(self.status_code)
        payload = json.loads(request.content)
        tool, args = payload["tool"], payload["arguments"]
        token = request.headers.get("X-AI-Context", "")
        selected = next((i for i in (1, 2) for c in (1, 2) if token == self.token(self.scope(i, c))), None)
        if selected is None or request.headers.get("Authorization") != "Bearer synthetic-service":
            return httpx.Response(403)
        self.calls.append(tool)  # Tool names only; no headers or message content.
        products = self.products[selected]
        if tool == "get_products":
            data = page(products, args.get("limit", 20), args.get("offset", 0))
        elif tool == "get_business_info":
            data = {"business": {"id": identifier(1, selected), "name": f"Synthetic shop {selected}"}}
        elif tool == "get_conversation_history":
            data = page([], args.get("limit", 20), args.get("offset", 0))
        else:
            product = next((p for p in products if p["id"] == args.get("productId")), None)
            if product is None:
                return httpx.Response(404)
            if tool == "get_product_details":
                data = product
            elif tool == "get_product_variants":
                data = page(product["variants"], args.get("limit", 20), args.get("offset", 0))
            else:
                data = next((v for v in product["variants"] if v["id"] == args.get("variantId")), None)
                if data is None:
                    return httpx.Response(404)
        return httpx.Response(200, json={"tool": tool, "data": deepcopy(data)})
