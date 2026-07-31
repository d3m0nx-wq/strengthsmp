# EaglerLink
**Custom-domain bridge for Eaglercraft hosts (EaglerHost, etc.) that don’t let you change the WSS domain.**

EaglerLink lets you put your own domain in front of an “unchangeable” Eaglercraft host domain by running a tiny Node service that:

- ✅ Serves your portal website from the **/public** folder (desktop + mobile pages)
- ✅ Proxies **WebSocket (WSS)** traffic from your domain → your real EaglerHost WSS endpoint
- ✅ Keeps your upstream host unchanged

**Result:** players can connect using  
`wss://yourdomain.com`  
instead of being stuck with something like  
`wss://yourserver.eagler.host`

---

## How it works (simple)
Your domain points to this service on Render (or any Node host).

- Website files: `https://yourdomain.com/` → served from `/public`
- WebSocket: `wss://yourdomain.com/` → forwarded to your upstream `wss://yourserver.eagler.host/`

So the browser/game thinks it’s connecting to your domain, while EaglerHost stays the backend.

---

## Requirements
- A domain you own (Namecheap, Cloudflare, etc.)
- A hosting platform for Node (Render recommended)
- Your upstream EaglerHost WSS URL (example: `wss://YourServer.eagler.host/`)

---

## Quick Setup (Render)
### 1) Fork this repo
Click **Fork** on GitHub so you have your own copy.

### 2) Edit the upstream WSS URL
Open `server.js` and change:

```js
const UPSTREAM_URL = 'wss://YOUR-SERVER.eagler.host/';
````

to your EaglerHost WSS endpoint:

```js
const UPSTREAM_URL = 'wss://exampleserver.eagler.host/';
```

> Keep the trailing `/` if your host uses it.

### 3) Deploy on Render

1. Go to Render → **New +** → **Web Service**
2. Connect your GitHub account and select your fork
3. Settings:

   * **Environment:** Node
   * **Build Command:** `npm install`
   * **Start Command:** `npm start`
4. Deploy

When it finishes, Render will give you a URL like:
`https://eaglerlink.onrender.com`

---

## Connect your domain

### Option A: Using Cloudflare (recommended)

1. Add your domain to Cloudflare
2. Create DNS records:

   * `A` or `CNAME` depending on Render’s instructions
3. In Render → your service → **Settings → Custom Domains**
4. Add `yourdomain.com` (and optionally `www.yourdomain.com`)
5. Follow Render’s DNS prompts until it verifies

### Option B: No Cloudflare (Namecheap / basic DNS)

Same idea: follow Render’s custom domain page and add the record it tells you.

---

## Put your portal pages in `/public`

Your site is served from the `/public` folder.

Example structure:

```
public/
  index.html
  game.html
  mobile.html
  assets/
```

* `index.html` is your landing page
* `game.html` is your desktop portal
* `mobile.html` is your mobile portal

If a file isn’t found, the server falls back to `index.html`.

---

## Update the portal to use your domain

Inside your portal/client settings, use:

**Server Address:**

```
wss://yourdomain.com
```

That’s it.

> If your portal hardcodes the old address anywhere, update it to your domain.

---

## Health Check

Visit:

```
https://yourdomain.com/health
```

If it returns `ok`, the service is running.

---

## Common Issues

### “It connects but doesn’t show server list / details / MOTD”

This project buffers early packets until the upstream is fully open (important for Eagler server-list pings).
If you customized the proxy logic, make sure you kept the **queue/buffer** behavior.

### “My site loads but WSS doesn’t connect”

* Make sure your domain is using **HTTPS** (Render provides this)
* Confirm you’re using **wss://** not ws://
* Confirm `UPSTREAM_URL` is correct and reachable

### “Render says it can’t find module ws”

Make sure `package.json` includes:

```json
"dependencies": {
  "ws": "^8.16.0"
}
```

Then redeploy.

### “I want / to be both the site and the websocket”

That’s supported. HTTP requests serve `/public`, and WebSocket upgrades are detected automatically.

---

## Customization

* Edit `/public/index.html` to match your server branding
* Add screenshots, Discord links, etc.
* Replace the “YourServer” placeholders

---

## Disclaimer

This is a domain bridge/proxy. You’re still responsible for:

* Your host’s rules/ToS
* Your domain setup
* Any content you serve

---

## Credits / License

Original project by **Lukas (PromiseLand-CKMC)**.
See `LICENSE` and `NOTICE` for terms.

```
::contentReference[oaicite:0]{index=0}
```
