# HomeAI Pro — ESP-12E + Gemini + YouTube

A personal smart-home assistant starter project based on the supplied ESP8266/ESP-12E relay controller. It adds a browser-based voice/chat interface, English/Hinglish replies, Gemini conversation, YouTube search + embedded playback, and cloud-to-device relay commands over MQTT TLS.

## What is included

- `backend/server.js` — Express API, HTTP Basic Auth, Gemini API calls, YouTube Data API search, safe command parsing, MQTT publish.
- `backend/.env.example` — required server secrets/configuration template.
- `web/index.html` — responsive chat UI, English/Hinglish selection, browser speech, “Hey HomeAI” wake-word mode, YouTube IFrame player, relay buttons.
- `esp8266/HomeAI_ESP8266.ino` — ESP8266 firmware with four relays, local authenticated endpoints, auto-off timer, and MQTT-over-TLS command listener.

## Architecture

Phone/browser (HTTPS) → cloud Node.js app → Gemini + YouTube Data API. For relay commands, the cloud app publishes a validated command to an MQTT broker; the ESP8266 makes an outbound TLS connection to that broker and applies the command. No computer at home needs to stay on. The ESP8266 and phone need internet access for remote control/AI. The local setup AP is only for local setup/troubleshooting; it is not an internet bridge.

## 1. Get API credentials

### Gemini

1. Open [Google AI Studio](https://aistudio.google.com/app/apikey) and create an API key.
2. Add it as `GEMINI_API_KEY` in `backend/.env`; never put it in `web/index.html` or ESP firmware.
3. The default model is `gemini-2.5-flash`. Model availability, free-tier access and quotas can vary by project/region and can change. Check the [official pricing page](https://ai.google.dev/gemini-api/docs/pricing) and [rate-limit page](https://ai.google.dev/gemini-api/docs/rate-limits) before deployment. Free-tier requests may have data-use terms different from paid service; do not send private/sensitive information unless you accept Google's current terms.

### YouTube search

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create/select a project, enable **YouTube Data API v3**, and create an API key.
3. Restrict the key to YouTube Data API v3 and keep it server-side as `YOUTUBE_API_KEY`.
4. Search quota applies; default allocations can change. See the [YouTube Data API overview](https://developers.google.com/youtube/data/getting-started).
5. Playback is through YouTube's official embedded player, not a downloaded audio stream. See the [YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference).

### MQTT broker

Create a TLS-enabled broker account (for example, HiveMQ Cloud). Create a user with a strong password. Use a unique, hard-to-guess topic prefix for this project, such as `homeai/device-a-long-random-suffix`. Configure the broker's access-control rules so the ESP user can subscribe only to `<prefix>/cmd` and publish only to `<prefix>/status`; the backend user can publish only to `<prefix>/cmd` and subscribe to `<prefix>/status` if needed. Do not use a public unauthenticated broker.

Obtain the broker's correct root CA certificate from its official documentation and paste it into `MQTT_ROOT_CA` in the ESP sketch. The firmware deliberately refuses MQTT connection if the certificate placeholder remains. Do not replace certificate validation with `setInsecure()`.

## 2. Configure the backend

```bash
cd backend
cp .env.example .env
```

Edit `.env` and set:

- `APP_USERNAME` and a long, unique `APP_PASSWORD`
- `GEMINI_API_KEY`
- `YOUTUBE_API_KEY`
- `MQTT_URL` (must start `mqtts://`), `MQTT_USERNAME`, `MQTT_PASSWORD`
- `MQTT_TOPIC_PREFIX` — must exactly match the topic prefix in the ESP sketch

Install and run locally for testing:

```bash
npm install
npm start
```

Open `http://localhost:3000`. The browser will request the Basic Auth credentials. For local testing this is acceptable; **do not expose plain HTTP to the public internet**.

## 3. Configure and flash the ESP-12E

1. Install Arduino IDE and the ESP8266 board package.
2. Install libraries: **PubSubClient** by Nick O'Leary and **ArduinoJson** by Benoit Blanchon. `ESP8266WiFi`, `ESP8266WebServer`, and BearSSL are supplied by the ESP8266 core.
3. Open `esp8266/HomeAI_ESP8266.ino`.
4. Fill in Wi-Fi SSID/password, AP password, local HTTP username/password, MQTT host, MQTT username/password, identical topic names, and the broker root CA PEM.
5. Select your NodeMCU/ESP-12E board and correct COM port, then upload.
6. Open Serial Monitor at 115200 baud. Confirm Wi-Fi and “Secure MQTT connected.” If MQTT does not connect, verify broker hostname, credentials, topic names, CA certificate, and network access to port 8883.

Pins are D1, D2, D5, D6. This sketch assumes a relay board compatible with ESP8266 3.3V logic and active-low relays; change `RELAY_ACTIVE_LOW` only after checking your relay board. Use a properly rated isolated relay module and safe enclosure for mains loads. Do not handle mains wiring while powered. The firmware initializes outputs OFF and turns each relay off after 30 minutes.

## 4. Deploy so it works without your computer

Deploy the **backend folder plus the web folder** to an always-on cloud Node.js host that supports environment variables and outbound HTTPS/MQTT TLS. Set the start command to `npm start`, the root directory to `backend` (or configure the build context accordingly), and add every `.env` variable through the host's secret/environment-variable settings. Attach HTTPS and a stable domain. Do not upload `.env` to GitHub.

If your chosen host sleeps on a free tier, the first request may be slow or the service may not be continuously available. “No computer running at home” is supported, but continuous cloud availability depends on your host's plan and terms. The ESP must stay powered and connected to home Wi-Fi.

When deployed, open the HTTPS URL on your phone and sign in. Add it to the phone home screen if desired. Browser speech recognition and wake-word behavior vary by browser/device; keep the page open, screen awake, microphone permission enabled, and network available. A wake phrase is not guaranteed to work while the browser is backgrounded or the phone is locked.

## 5. Use it

- “Hey HomeAI play Kesariya” → YouTube search results for the named song.
- “Hey HomeAI play trending songs” → searches current YouTube results for trending songs in India.
- “Hey HomeAI play romantic songs” → searches popular romantic songs.
- “Hey HomeAI” then, after it replies, “Turn on the fan.”
- Or tap **Talk now** and speak once.
- Select English or Hinglish before talking. Browser voice availability varies; Hinglish output is Roman Hindi mixed with English and uses a Hindi voice if one is available.

For reliability, the web UI routes clear music requests directly to search; general conversation goes to Gemini. It asks a follow-up when the request is just “play music” without a song or mood. YouTube search results are not a guarantee of official uploads or live chart ranking.

## Security checklist before remote use

- Replace every placeholder password; never reuse your Wi-Fi password as an app or MQTT password.
- Use HTTPS for the cloud site and TLS certificate verification for MQTT.
- Keep API keys in cloud environment variables; never commit `.env`.
- Restrict YouTube API keys and MQTT topics/permissions.
- Use a long random MQTT topic prefix and strong broker credentials.
- Keep ESP local HTTP endpoints off the public internet; Basic Auth alone is not encryption on plain HTTP.
- The cloud relay parser only accepts known appliance names and explicit on/off commands; all-off is supported. Review the regex/device map before adding new commands.
- Test relay outputs with loads disconnected before wiring real appliances. Use certified isolation and a qualified electrician for mains wiring.

## Limitations

- The ESP8266 cannot run a modern conversational model locally; Gemini requires internet and may hit quota limits.
- “Hey HomeAI” is browser speech-recognition-based, not a dedicated low-power wake-word chip. It is not guaranteed in the background/locked state.
- Browser autoplay can be blocked; if so, press Play inside the embedded YouTube player.
- Trending search uses YouTube search results, not an authoritative real-time music chart.
- This is a starter implementation. Before public production use, consider stronger account authentication (rather than Basic Auth), CSRF protections, command acknowledgements/state synchronization, and a proper per-user device permission model.
