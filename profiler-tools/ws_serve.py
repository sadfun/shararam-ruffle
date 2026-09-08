import asyncio, sys, websockets
data = open(sys.argv[1], 'rb').read()
async def handler(ws):
    await ws.send(data)
    try: await ws.wait_closed()
    except Exception: pass
async def main():
    async with websockets.serve(handler, '127.0.0.1', 8792, max_size=None):
        print('serving', len(data), 'bytes on ws://127.0.0.1:8792', flush=True)
        await asyncio.Future()
asyncio.run(main())
