"""Legacy-compatible ASGI import. Railway uses python -m app.server."""
from app.http import create_app

app = create_app()
