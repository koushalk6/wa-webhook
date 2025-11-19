"""
import json
import asyncio
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaPlayer
from google.cloud import texttospeech
import requests
import os

WHATSAPP_TOKEN = os.getenv("WHATSAPP_TOKEN")
PHONE_NUMBER_ID = os.getenv("PHONE_NUMBER_ID")
GRAPH = "https://graph.facebook.com/v20.0"

# --------------------------- TTS ---------------------------
def generate_tts():
    text = "Welcome to Avasar, the citizen driven platform. I am bot agent Santosh. How can I help you today?"

    client = texttospeech.TextToSpeechClient()
    req = texttospeech.SynthesisInput(text=text)
    voice = texttospeech.VoiceSelectionParams(
        language_code="en-US",
        ssml_gender=texttospeech.SsmlVoiceGender.NEUTRAL
    )
    audio = texttospeech.AudioConfig(audio_encoding=texttospeech.AudioEncoding.LINEAR16)

    res = client.synthesize_speech(input=req, voice=voice, audio_config=audio)

    path = "/tmp/welcome.wav"
    with open(path, "wb") as f:
        f.write(res.audio_content)

    return path

# ------------------------ WebRTC Answer ----------------------
async def handle_call(call):
    call_id = call["id"]
    event = call["event"]

    if event != "connect":
        return web.Response(text="ignored")

    offer_sdp = call["session"]["sdp"]

    pc = RTCPeerConnection()

    wav = generate_tts()
    player = MediaPlayer(wav)
    pc.addTrack(player.audio)

    await pc.setRemoteDescription(RTCSessionDescription(offer_sdp, "offer"))
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    # PRE-ACCEPT
    requests.post(
        f"{GRAPH}/{PHONE_NUMBER_ID}/calls",
        headers={"Authorization": f"Bearer {WHATSAPP_TOKEN}"},
        json={
            "messaging_product": "whatsapp",
            "call_id": call_id,
            "action": "pre_accept",
            "session": {"sdp_type": "answer", "sdp": pc.localDescription.sdp}
        }
    )

    # On ICE connect → ACCEPT
    @pc.on("iceconnectionstatechange")
    async def _():
        if pc.iceConnectionState == "connected":
            requests.post(
                f"{GRAPH}/{PHONE_NUMBER_ID}/calls",
                headers={"Authorization": f"Bearer {WHATSAPP_TOKEN}"},
                json={
                    "messaging_product": "whatsapp",
                    "call_id": call_id,
                    "action": "accept",
                    "session": {
                        "sdp_type": "answer",
                        "sdp": pc.localDescription.sdp
                    }
                }
            )

    return web.Response(text="TTS sent")

# --------------------------- Web Server ----------------------

async def handle_req(req):
    data = await req.json()
    asyncio.create_task(handle_call(data))
    return web.Response(text="OK")

app = web.Application()
app.router.add_post("/run", handle_req)

if __name__ == "__main__":
    import os
    port = int(os.getenv("PORT", 8030))  # Use the Cloud Run environment variable
    web.run_app(app, port=port)

"""