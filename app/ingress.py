"""Bounded ingress with explicit CIDR or isolated Railway public-edge trust."""
import asyncio
import ipaddress
from starlette.responses import JSONResponse
from .config import valid_railway_domain


class IntegrationIngress:
    def __init__(self,app,*,trusted_proxy_cidrs=(),railway_public_domain=None):
        self.app=app
        if railway_public_domain is not None and not valid_railway_domain(railway_public_domain):
            raise ValueError("Invalid Railway public domain")
        self.railway_public_domain=railway_public_domain
        self.networks=[]
        try:
            for value in trusted_proxy_cidrs:
                network=ipaddress.ip_network(value,strict=True)
                if network.prefixlen == 0:
                    raise ValueError()
                self.networks.append(network)
        except ValueError:
            raise ValueError("Trusted proxies require explicit bounded IP/CIDR entries; wildcard trust is forbidden") from None

    async def __call__(self,scope,receive,send):
        if scope["type"] != "http":
            return await self.app(scope,receive,send)
        headers=scope.get("headers",[])
        try:
            peer=ipaddress.ip_address(scope["client"][0])
            trusted=any(peer in network for network in self.networks)
        except (ValueError,KeyError,TypeError,IndexError):
            trusted=False
        forwarded=[v for k,v in headers if k.lower()==b"x-forwarded-proto"]
        # Opt-in platform boundary, not proof supplied by an arbitrary header.
        # Deployment must expose this listener only through Railway's HTTPS edge
        # and to trusted services in its isolated project environment. No TCP proxy.
        railway_edge=False
        if self.railway_public_domain is not None:
            host=[v for k,v in headers if k.lower()==b"host"]
            forwarded_host=[v for k,v in headers if k.lower()==b"x-forwarded-host"]
            domain=self.railway_public_domain.encode("ascii")
            railway_edge=(len(host)==1 and host[0].lower()==domain
                          and len(forwarded_host)==1 and forwarded_host[0].lower()==domain)
        if (trusted or railway_edge) and len(forwarded)==1 and forwarded[0].lower()==b"https":
            scope={**scope,"scheme":"https"}
        if scope["path"] not in {"/v2/ai/respond","/v2/ai/products/respond","/v2/ai/respond-with-context"}:
            return await self.app(scope,receive,send)
        chunks=[]
        class TooLarge(Exception):
            pass
        async def read_body():
            count=0
            while True:
                message=await receive()
                if message["type"]=="http.disconnect":
                    return False
                count+=len(message.get("body",b""))
                if count > 65536:
                    raise TooLarge()
                chunks.append(message.get("body",b""))
                if not message.get("more_body",False):
                    return True
        try:
            if not await asyncio.wait_for(read_body(),timeout=10):
                return
        except TooLarge:
            return await JSONResponse({"detail":"Request body exceeds 65536 bytes"},status_code=413)(scope,receive,send)
        except asyncio.TimeoutError:
            return await JSONResponse({"detail":"Request body read deadline exceeded"},status_code=408)(scope,receive,send)
        pending=True
        async def replay():
            nonlocal pending
            if pending:
                pending=False
                return {"type":"http.request","body":b"".join(chunks),"more_body":False}
            return await receive()
        await self.app(scope,replay,send)
