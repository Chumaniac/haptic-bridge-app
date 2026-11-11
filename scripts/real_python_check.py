"""Check the official Python client against this test's own native engine."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from importlib.metadata import version
from urllib.parse import urlsplit

from buttplug import ButtplugClient


async def check(endpoint: str, expected_name: str) -> dict[str, object]:
    """Verify an empty-device handshake without discovering or actuating hardware."""
    target = urlsplit(endpoint)
    if target.scheme != "ws" or target.hostname != "127.0.0.1" or not target.port:
        raise ValueError("Only the owned loopback engine endpoint is accepted")
    client = ButtplugClient("Haptic Bridge actual Python interoperability")
    async with asyncio.timeout(10):
        try:
            await client.connect(endpoint)
            if not client.connected or client.server_name != expected_name:
                raise RuntimeError("Native engine identity or handshake mismatch")
            if client.devices or client.scanning:
                raise RuntimeError("Unexpected device or scanning in hardware-disabled test")
            result: dict[str, object] = {
                "client": "buttplug",
                "version": version("buttplug"),
                "python": sys.version.split()[0],
                "websockets": version("websockets"),
                "pydantic": version("pydantic"),
                "serverName": client.server_name,
                "connected": client.connected,
                "deviceCount": len(client.devices),
                "scanning": client.scanning,
                "hardwareOutputAttempted": False,
            }
        finally:
            await client.disconnect()
        result["disconnected"] = not client.connected
        return result


def main() -> None:
    """Run the scoped component check; the caller owns the native engine."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("endpoint")
    parser.add_argument("expected_name")
    arguments = parser.parse_args()
    print(json.dumps(asyncio.run(check(arguments.endpoint, arguments.expected_name))))


if __name__ == "__main__":
    main()
